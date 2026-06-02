/**
 * Cloudflare authentication resolution — supports BOTH auth modes:
 *
 *   1. Scoped API token  → Authorization: Bearer <token>   (CLOUDFLARE_API_TOKEN)
 *   2. Global API key     → X-Auth-Key + X-Auth-Email       (CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL)
 *
 * Our secrets vault currently stores a Global API Key + email
 * (HASNAXYZ_CLOUDFLARE_LIVE_API_KEY / _EMAIL), not a scoped token, so global
 * mode must be supported. Scoped tokens are preferred when available.
 *
 * Pure module: the environment is injected, so it is fully unit-testable.
 */

export type CloudflareAuth =
  | { kind: "token"; token: string }
  | { kind: "global"; apiKey: string; email: string };

export interface CloudflareAuthSource {
  /** Token from the emails config file (highest priority). */
  configToken?: string;
  /** Global key/email from the emails config file. */
  configApiKey?: string;
  configEmail?: string;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export function resolveCloudflareAuth(source: CloudflareAuthSource = {}): CloudflareAuth | undefined {
  const env = source.env ?? (process.env as Record<string, string | undefined>);

  // 1. Explicit scoped token from config.
  if (source.configToken) return { kind: "token", token: source.configToken };

  // 2. Scoped token from the standard env var.
  if (env["CLOUDFLARE_API_TOKEN"]) return { kind: "token", token: env["CLOUDFLARE_API_TOKEN"]! };

  // 3. Global key + email from config.
  if (source.configApiKey && source.configEmail) {
    return { kind: "global", apiKey: source.configApiKey, email: source.configEmail };
  }

  // 4. Global key + email from the standard env vars.
  if (env["CLOUDFLARE_API_KEY"] && env["CLOUDFLARE_EMAIL"]) {
    return { kind: "global", apiKey: env["CLOUDFLARE_API_KEY"]!, email: env["CLOUDFLARE_EMAIL"]! };
  }

  // 5. Global key + email from the HASNAXYZ vault env names.
  if (env["HASNAXYZ_CLOUDFLARE_LIVE_API_KEY"] && env["HASNAXYZ_CLOUDFLARE_LIVE_EMAIL"]) {
    return {
      kind: "global",
      apiKey: env["HASNAXYZ_CLOUDFLARE_LIVE_API_KEY"]!,
      email: env["HASNAXYZ_CLOUDFLARE_LIVE_EMAIL"]!,
    };
  }

  return undefined;
}

/** Env vars to inject when invoking the Cloudflare connector for this auth. */
export function cloudflareAuthEnv(auth: CloudflareAuth): Record<string, string> {
  if (auth.kind === "token") return { CLOUDFLARE_API_TOKEN: auth.token };
  return { CLOUDFLARE_API_KEY: auth.apiKey, CLOUDFLARE_EMAIL: auth.email };
}

/** Human-readable, secret-free description for `emails doctor`. */
export function describeCloudflareAuth(auth: CloudflareAuth): string {
  if (auth.kind === "token") return "scoped token";
  return `global key (${auth.email})`;
}
