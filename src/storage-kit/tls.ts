// Product-owned Emails Postgres storage utilities.
// Forked from storage-kit 0.4.2 and maintained in this repository.

// TLS resolution for the Emails Postgres storage utilities.
//
// One correct TLS approach for this deployment. This replaces drifted
// variants that previously existed across repos, all of which hardcoded
// `{ rejectUnauthorized: false }` for any TLS connection — that silently
// disables certificate verification even when the caller asked for
// `verify-full`, which defeats the point of TLS against a self_hosted database.
//
// The rule accepts familiar libpq `sslmode` names but intentionally applies a
// stricter verification policy:
//   - disable / (no ssl param)  -> no TLS (ssl: undefined)
//   - prefer                    -> no explicit TLS policy (local development)
//   - require                   -> encrypt and verify the server certificate
//   - verify-ca / verify-full   -> encrypt AND verify against a CA bundle
//                                  (rejectUnauthorized: true, ca: <bundle>).
//                                  A CA bundle is REQUIRED; we throw if none is
//                                  available so verification can never silently
//                                  downgrade.
//
// The RDS CA bundle is loaded (in priority order) from:
//   1. an explicit `ca` string passed by the caller,
//   2. an explicit `caCertPath` passed by the caller,
//   3. `sslrootcert` in the connection string,
//   4. `EMAILS_DATABASE_CA_FILE` (the product-specific runtime setting),
//   5. `PGSSLROOTCERT` (libpq's standard env var),
//   6. `NODE_EXTRA_CA_CERTS`.
// Download the Amazon RDS global bundle to one of those paths:
//   https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

import { readFileSync } from "node:fs";

const PG_TLS_QUERY_PARAMETERS = new Set([
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslpassword",
  "sslnegotiation",
  "uselibpqcompat",
]);

/** The `ssl` field shape accepted by `pg.Pool` / `pg.Client`. */
export type PgSslConfig = boolean | { rejectUnauthorized: boolean; ca?: string };

export interface TlsResolveOptions {
  /** Inline CA bundle (PEM). Wins over every other CA source. */
  ca?: string;
  /** Path to a CA bundle PEM file, e.g. the Amazon RDS global bundle. */
  caCertPath?: string;
  /** Environment used to discover the supported CA bundle path settings. */
  env?: Record<string, string | undefined>;
}

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

interface ConnectionStringParts {
  base: string;
  fragment: string;
  params: URLSearchParams;
}

function connectionStringParts(connectionString: string): ConnectionStringParts {
  const queryStart = connectionString.indexOf("?");
  if (queryStart === -1) {
    return { base: connectionString, fragment: "", params: new URLSearchParams() };
  }
  const base = connectionString.slice(0, queryStart);
  const queryAndFragment = connectionString.slice(queryStart + 1);
  const fragmentStart = queryAndFragment.indexOf("#");
  const query = fragmentStart === -1 ? queryAndFragment : queryAndFragment.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? "" : queryAndFragment.slice(fragmentStart);
  return { base, fragment, params: new URLSearchParams(query) };
}

function tlsQueryValues(connectionString: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of connectionStringParts(connectionString).params) {
    const normalized = key.toLowerCase();
    if (PG_TLS_QUERY_PARAMETERS.has(normalized)) values.set(normalized, value);
  }
  return values;
}

/**
 * Remove SSL query parameters after Emails resolves them to explicit pool
 * options. `pg` reparses `connectionString` after merging Pool options; leaving
 * `sslmode` or `sslrootcert` in the URL replaces the verified SSL object.
 */
export function connectionStringWithoutTlsParameters(connectionString: string): string {
  const { base, fragment, params } = connectionStringParts(connectionString);
  for (const key of [...params.keys()]) {
    if (PG_TLS_QUERY_PARAMETERS.has(key.toLowerCase())) params.delete(key);
  }
  const query = params.toString();
  return `${base}${query ? `?${query}` : ""}${fragment}`;
}

/** Preserve pg's transport negotiation choice outside the sanitized URL. */
export function sslNegotiationFromConnectionString(
  connectionString: string,
): "postgres" | "direct" | undefined {
  const value = tlsQueryValues(connectionString).get("sslnegotiation")?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "postgres" || value === "direct") return value;
  throw new Error("sslnegotiation must be either postgres or direct");
}

/**
 * Extract the effective `sslmode` from a Postgres connection string. Honors the
 * `sslmode` query param and the legacy `ssl=true` boolean. Returns `disable`
 * when TLS is not requested.
 */
export function sslModeFromConnectionString(connectionString: string): SslMode {
  const values = tlsQueryValues(connectionString);
  const sslmode = values.get("sslmode")?.trim().toLowerCase();
  if (sslmode) {
    switch (sslmode) {
      case "disable":
      case "prefer":
      case "require":
      case "verify-ca":
      case "verify-full":
        return sslmode;
      case "allow":
        return "prefer";
      default:
        throw new Error(`Unknown sslmode '${sslmode}' in connection string.`);
    }
  }

  const ssl = values.get("ssl")?.trim().toLowerCase();
  if (ssl && ["1", "true", "yes", "on", "require"].includes(ssl)) return "require";
  if (ssl && !["0", "false", "no", "off", "disable"].includes(ssl)) {
    throw new Error(`Unknown ssl value '${ssl}' in connection string.`);
  }

  return "disable";
}

function loadCaBundle(connectionString: string, options: TlsResolveOptions): string | null {
  const env = options.env ?? process.env;
  if (options.ca && options.ca.trim()) return options.ca;
  const sslRootCert = tlsQueryValues(connectionString).get("sslrootcert")?.trim();
  const path =
    options.caCertPath ??
    sslRootCert ??
    env.EMAILS_DATABASE_CA_FILE ??
    env.PGSSLROOTCERT ??
    env.NODE_EXTRA_CA_CERTS;
  if (path && path.trim()) return readFileSync(path.trim(), "utf8");
  return null;
}

/**
 * Resolve the `pg` ssl config for a connection string. See the module header
 * for the full mode table. Returns `undefined` when TLS should be off.
 */
export function resolveTlsConfig(
  connectionString: string,
  options: TlsResolveOptions = {},
): PgSslConfig | undefined {
  const values = tlsQueryValues(connectionString);
  const unsupportedClientCertificateParameter = ["sslcert", "sslkey", "sslpassword"]
    .find((key) => values.has(key));
  if (unsupportedClientCertificateParameter) {
    throw new Error(
      `${unsupportedClientCertificateParameter} is not supported in EMAILS_DATABASE_URL; ` +
        "Emails self-hosted supports verified server certificates through a CA bundle.",
    );
  }
  const mode = sslModeFromConnectionString(connectionString);

  if (mode === "disable") {
    const sslmode = values.get("sslmode")?.trim().toLowerCase();
    const ssl = values.get("ssl")?.trim().toLowerCase();
    if (sslmode === "disable" || (ssl && ["0", "false", "no", "off", "disable"].includes(ssl))) {
      return false;
    }
    return undefined;
  }

  if (mode === "prefer") {
    // `prefer` still lets pg negotiate TLS opportunistically without a config,
    // but we only force TLS at `require` and above. Treat it as no explicit ssl
    // config so a plain local Postgres keeps working.
    return undefined;
  }

  const ca = loadCaBundle(connectionString, options);

  if (mode === "require") {
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }

  // verify-ca / verify-full: verification is mandatory.
  if (!ca) {
    throw new Error(
      `sslmode=${mode} requires a CA bundle. Set EMAILS_DATABASE_CA_FILE, PGSSLROOTCERT, ` +
        `NODE_EXTRA_CA_CERTS (or pass caCertPath/ca) to the ` +
        `Amazon RDS global bundle: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`,
    );
  }
  return { rejectUnauthorized: true, ca };
}
