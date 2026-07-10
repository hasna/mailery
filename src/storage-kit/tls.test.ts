import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectionStringWithoutTlsParameters,
  resolveTlsConfig,
  sslNegotiationFromConnectionString,
} from "./tls.js";

const temporaryDirectories: string[] = [];

function caFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "emails-ca-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "bundle.pem");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Postgres TLS", () => {
  test("sslmode=require always keeps certificate verification enabled", () => {
    expect(
      resolveTlsConfig("postgresql://db/emails?sslmode=require", { env: {} }),
    ).toEqual({ rejectUnauthorized: true });
  });

  test("loads the product-specific CA file before generic environment settings", () => {
    const productCa = caFile("PRODUCT CA");
    const libpqCa = caFile("LIBPQ CA");

    expect(
      resolveTlsConfig("postgresql://db/emails?sslmode=verify-full", {
        env: {
          EMAILS_DATABASE_CA_FILE: productCa,
          PGSSLROOTCERT: libpqCa,
        },
      }),
    ).toEqual({ rejectUnauthorized: true, ca: "PRODUCT CA" });
  });

  test("verify-full fails closed without a CA bundle", () => {
    expect(() =>
      resolveTlsConfig("postgresql://db/emails?sslmode=verify-full", { env: {} }),
    ).toThrow("requires a CA bundle");
  });

  test("loads sslrootcert before environment CA settings", () => {
    const connectionCa = caFile("CONNECTION CA");
    const environmentCa = caFile("ENVIRONMENT CA");
    const connectionString =
      `postgresql://db/emails?sslmode=verify-full&sslrootcert=${encodeURIComponent(connectionCa)}`;

    expect(resolveTlsConfig(connectionString, {
      env: { EMAILS_DATABASE_CA_FILE: environmentCa },
    })).toEqual({ rejectUnauthorized: true, ca: "CONNECTION CA" });
  });

  test("removes every pg SSL override while preserving unrelated parameters", () => {
    const connectionString = connectionStringWithoutTlsParameters(
      "postgresql://db/emails?application_name=emails&sslmode=verify-full&sslrootcert=%2Fca.pem&sslnegotiation=direct",
    );
    expect(connectionString).toBe("postgresql://db/emails?application_name=emails");
  });

  test("preserves validated SSL transport negotiation outside the sanitized URL", () => {
    expect(sslNegotiationFromConnectionString(
      "postgresql://db/emails?sslmode=require&sslnegotiation=direct",
    )).toBe("direct");
    expect(() => sslNegotiationFromConnectionString(
      "postgresql://db/emails?sslnegotiation=invalid",
    )).toThrow("postgres or direct");
  });

  test("rejects client-certificate query parameters instead of silently dropping them", () => {
    expect(() => resolveTlsConfig(
      "postgresql://db/emails?sslmode=require&sslkey=%2Fclient.key",
      { env: {} },
    )).toThrow("sslkey is not supported");
  });
});
