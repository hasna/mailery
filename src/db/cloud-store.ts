// Cloud HTTP storage bridge — makes `self_hosted` mode real for the client.
//
// When the client-flip contract resolves to cloud (mode=self_hosted/cloud AND
// HASNA_MAILERY_API_URL + HASNA_MAILERY_API_KEY are set), the repository layer
// (src/db/*.ts) routes ALL reads AND writes to the app's cloud HTTP API
// (`<API_URL>/v1/<resource>`) with the bearer key — NOT the local SQLite store,
// NOT a DSN. This mirrors the resource-CRUD vocabulary of the Hasna Service
// Contract v1 that `@hasna/contracts`'s `createHasnaStorageClient` speaks:
//
//   list   -> GET    /v1/<resource>            -> { <resource>: [...] }
//   get    -> GET    /v1/<resource>/<id>       -> { <singular>: <entity> } | 404
//   create -> POST   /v1/<resource>            -> { <singular>: <entity> }
//   update -> PATCH  /v1/<resource>/<id>       -> { <singular>: <entity> }
//   delete -> DELETE /v1/<resource>/<id>       -> void (200/204/404 => ok)
//
// The repository functions are synchronous (CLI, MCP and serve all call them
// without an await), so this bridge performs the HTTP call synchronously via a
// spawned `curl`. Bun has no synchronous `fetch`.
//
// SAFETY: the API key is NEVER placed on the process argv (it would leak into
// `ps`/monitoring). It is written to a 0600 curl config file that is deleted
// immediately after the call. The key value is never logged or embedded in an
// error.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = "mailery";
const TOKEN = "MAILERY";

export class CloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodyText: string,
  ) {
    super(`Cloud ${method} ${path} failed: HTTP ${status}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ""}`);
    this.name = "CloudHttpError";
  }
}

interface CloudConfig {
  baseUrl: string; // `<origin>/v1`
  apiKey: string;
}

const DEPRECATED_CLOUD_ALIASES = new Set(["remote", "hybrid", "self_hosted", "selfhosted", "self-hosted"]);

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeMode(raw: string | undefined): "cloud" | "local" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/-/g, "_");
  if (v === "local") return "local";
  if (v === "cloud") return "cloud";
  if (DEPRECATED_CLOUD_ALIASES.has(v)) return "cloud";
  return null;
}

function toV1BaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must use http or https.");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  url.pathname = `${path}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

let _cachedSignature: string | null = null;
let _cachedConfig: CloudConfig | null | undefined;

/**
 * Resolve the cloud config from the client-flip env, or null for local mode.
 * Fail-closed: if cloud is requested (mode=self_hosted/cloud) but the API URL or
 * key is missing, this THROWS rather than silently reading local data.
 */
export function resolveCloudConfig(): CloudConfig | null {
  const modeRaw = firstEnv([
    `HASNA_${TOKEN}_STORAGE_MODE`,
    `HASNA_${TOKEN}_MODE`,
    `${TOKEN}_STORAGE_MODE`,
    `${TOKEN}_MODE`,
    // Mailery's internal mode env (the app is also known as "emails").
    "HASNA_EMAILS_STORAGE_MODE",
    "HASNA_EMAILS_MODE",
  ]);
  const apiUrl = firstEnv([`HASNA_${TOKEN}_API_URL`, `${TOKEN}_API_URL`]);
  const apiKey = firstEnv([`HASNA_${TOKEN}_API_KEY`, `${TOKEN}_API_KEY`]);

  const signature = `${modeRaw ?? ""}|${apiUrl ?? ""}|${apiKey ? "k" : ""}`;
  if (signature === _cachedSignature && _cachedConfig !== undefined) return _cachedConfig ?? null;

  const config = computeConfig(modeRaw, apiUrl, apiKey);
  _cachedSignature = signature;
  _cachedConfig = config;
  return config;
}

function computeConfig(
  modeRaw: string | undefined,
  apiUrl: string | undefined,
  apiKey: string | undefined,
): CloudConfig | null {
  const mode = normalizeMode(modeRaw);

  // Explicit `local` mode always uses the local SQLite store, even when API
  // URL/key happen to be present in the environment.
  if (mode === "local") return null;

  // Engage the cloud API client when the mode is explicitly cloud/self_hosted,
  // OR when BOTH the API URL and key are set. The latter is the fleet
  // client-flip contract: `HASNA_<APP>_API_URL` + `HASNA_<APP>_API_KEY` imply
  // cloud even with no `*_STORAGE_MODE`/`*_MODE` set — parity with
  // `@hasna/contracts` >= 0.5.1 `resolveClientTransport`, and matching what the
  // flip writes (URL + key, no storage-mode var).
  const cloudRequested = mode === "cloud" || Boolean(apiUrl && apiKey);
  if (!cloudRequested) return null;

  // Cloud requested but NEITHER URL nor key is set: not an API-client flip
  // (e.g. mode=cloud alongside a legacy config the machine wrapper still
  // exports) — fall through to the app's existing local/legacy path rather
  // than erroring.
  if (!apiUrl && !apiKey) return null;

  // Partial API config -> fail closed (no silent drift onto the wrong dataset).
  if (!apiKey) {
    throw new Error(
      `${APP}: cloud API URL is set (HASNA_${TOKEN}_API_URL) but no API key. ` +
        `Set HASNA_${TOKEN}_API_KEY to route to the cloud, or unset the URL to use the local store.`,
    );
  }
  if (!apiUrl) {
    throw new Error(
      `${APP}: cloud API key is set (HASNA_${TOKEN}_API_KEY) but no API URL. ` +
        `Set HASNA_${TOKEN}_API_URL=https://${APP}.hasna.xyz.`,
    );
  }

  return { baseUrl: toV1BaseUrl(apiUrl), apiKey };
}

/** True when the client is flipped to the cloud HTTP API. */
export function isCloudMode(): boolean {
  return resolveCloudConfig() !== null;
}

/** Reset the memoized config (tests flip env between cases). */
export function resetCloudConfigCache(): void {
  _cachedSignature = null;
  _cachedConfig = undefined;
}

interface CurlResult {
  status: number;
  body: string;
}

function httpRequest(config: CloudConfig, method: string, path: string, body?: unknown): CurlResult {
  const url = `${config.baseUrl}${path}`;
  const dir = mkdtempSync(join(tmpdir(), "mailery-cloud-"));
  const cfgPath = join(dir, "curl.cfg");
  try {
    const lines = [
      `url = "${url}"`,
      `request = "${method}"`,
      `header = "Authorization: Bearer ${config.apiKey}"`,
      `header = "Accept: application/json"`,
      `silent`,
      `show-error`,
    ];
    if (body !== undefined) {
      lines.push(`header = "Content-Type: application/json"`);
      lines.push(`data-binary = "@${join(dir, "body.json")}"`);
      writeFileSync(join(dir, "body.json"), JSON.stringify(body), { mode: 0o600 });
    }
    writeFileSync(cfgPath, lines.join("\n"), { mode: 0o600 });

    const proc = spawnSync("curl", ["-K", cfgPath, "-w", "\n%{http_code}"], {
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
    });
    if (proc.error) throw proc.error;
    if (proc.status !== 0 && !proc.stdout) {
      throw new Error(`curl failed for ${method} ${path}: ${(proc.stderr || "").trim()}`);
    }
    const out = proc.stdout ?? "";
    const nl = out.lastIndexOf("\n");
    const statusStr = nl >= 0 ? out.slice(nl + 1).trim() : out.trim();
    const bodyText = nl >= 0 ? out.slice(0, nl) : "";
    const status = Number.parseInt(statusStr, 10);
    return { status: Number.isFinite(status) ? status : 0, body: bodyText };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseJson(text: string): unknown {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const LIST_KEYS = ["items", "data", "results", "rows", "records"];

function extractList(raw: unknown, resource: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of [resource, ...LIST_KEYS]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/**
 * Unwrap a single-entity response. The mailery API wraps entities as
 * `{ <singular>: entity }` (e.g. `{ domain: {...} }`); other apps return the
 * entity directly. Handles both.
 */
function unwrapSingle(raw: unknown, singular: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const wrapped = obj[singular];
  if (wrapped && typeof wrapped === "object") return wrapped as Record<string, unknown>;
  // Fall back: single-key envelope wrapping an object with an id.
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const val = obj[keys[0]!];
    if (val && typeof val === "object" && !Array.isArray(val) && "id" in (val as object)) {
      return val as Record<string, unknown>;
    }
  }
  return obj;
}

function singularOf(resource: string): string {
  const r = resource.replace(/^\/+|\/+$/g, "");
  return r.endsWith("es") && (r.endsWith("sses") || r.endsWith("ches") || r.endsWith("xes"))
    ? r.slice(0, -2)
    : r.endsWith("s")
      ? r.slice(0, -1)
      : r;
}

export interface CloudResourceStore {
  readonly resource: string;
  readonly baseUrl: string;
  list(query?: Record<string, string | number | boolean | undefined>): Record<string, unknown>[];
  get(id: string): Record<string, unknown> | null;
  create(body: unknown): Record<string, unknown>;
  update(id: string, patch: unknown, method?: "PATCH" | "PUT"): Record<string, unknown>;
  /** Delete by id. Returns true if the entity existed (2xx), false on 404. */
  del(id: string): boolean;
}

function encodeQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Return a cloud-backed store for `resource`, or null when the client is in
 * local mode. Throws (fail-closed) if cloud is requested but misconfigured.
 */
export function cloudStoreFor(resource: string): CloudResourceStore | null {
  const config = resolveCloudConfig();
  if (!config) return null;
  const clean = resource.replace(/^\/+|\/+$/g, "");
  const base = `/${clean}`;
  const singular = singularOf(clean);

  return {
    resource: clean,
    baseUrl: config.baseUrl,
    list(query) {
      const { status, body } = httpRequest(config, "GET", `${base}${encodeQuery(query)}`);
      if (status < 200 || status >= 300) throw new CloudHttpError(status, "GET", base, body);
      return extractList(parseJson(body), clean) as Record<string, unknown>[];
    },
    get(id) {
      const { status, body } = httpRequest(config, "GET", `${base}/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw new CloudHttpError(status, "GET", `${base}/${id}`, body);
      return unwrapSingle(parseJson(body), singular);
    },
    create(body) {
      const res = httpRequest(config, "POST", base, body);
      if (res.status < 200 || res.status >= 300) throw new CloudHttpError(res.status, "POST", base, res.body);
      return unwrapSingle(parseJson(res.body), singular) ?? {};
    },
    update(id, patch, method = "PATCH") {
      const res = httpRequest(config, method, `${base}/${encodeURIComponent(id)}`, patch);
      if (res.status < 200 || res.status >= 300) {
        throw new CloudHttpError(res.status, method, `${base}/${id}`, res.body);
      }
      return unwrapSingle(parseJson(res.body), singular) ?? {};
    },
    del(id) {
      const { status, body } = httpRequest(config, "DELETE", `${base}/${encodeURIComponent(id)}`);
      if (status === 404) return false;
      if (status < 200 || status >= 300) throw new CloudHttpError(status, "DELETE", `${base}/${id}`, body);
      return true;
    },
  };
}
