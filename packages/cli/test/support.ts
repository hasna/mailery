// Shared test scaffolding: captured IO and a routing fake `fetch` so the
// CLI/MCP can be exercised without a network, filesystem, or database.

import type { FetchLike } from "@hasna/mailery-sdk-internal";
import type { CliDeps } from "../src/client.js";

export interface FetchCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  auth?: string;
}

export interface RouteHandler {
  (call: FetchCall): { status?: number; body?: unknown } | undefined;
}

export function routeFetch(handler: RouteHandler, calls: FetchCall[] = []): FetchLike {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers["authorization"] ?? headers["Authorization"];
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FetchCall = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query, headers, body, auth };
    calls.push(call);
    const res = handler(call);
    const status = res?.status ?? 200;
    const payload = res?.body ?? {};
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
}

export interface Harness {
  deps: CliDeps;
  env: Record<string, string | undefined>;
  out: () => string;
  err: () => string;
  exitCode: () => number;
  calls: FetchCall[];
}

export function makeHarness(options: { route?: RouteHandler; fetch?: FetchLike; env?: Record<string, string | undefined>; interactive?: boolean; stdin?: string; files?: Record<string, string | Uint8Array> } = {}): Harness {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  let exitCode = 0;
  const calls: FetchCall[] = [];
  const env: Record<string, string | undefined> = {
    MAILERY_BASE_URL: "http://mailery.test",
    ...options.env,
  };
  const fetchImpl = options.fetch ?? (options.route ? routeFetch(options.route, calls) : undefined);
  const deps: CliDeps = {
    env,
    fetch: fetchImpl,
    // Binary chunks (attachment download to '-') are coerced losslessly via
    // latin1 so text assertions keep working; byte-exact tests override deps.stdout.
    stdout: (c) => outChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("latin1")),
    stderr: (c) => errChunks.push(c),
    setExitCode: (code) => { exitCode = code; },
    sleep: () => Promise.resolve(),
    openBrowser: () => {},
    interactive: options.interactive ?? false,
    readStdin: () => Promise.resolve(options.stdin ?? ""),
    // In-memory filesystem for `send --attach` / `send batch --file`: the CLI
    // is the only layer that touches disk, and tests must not.
    readFile: async (path: string) => {
      const entry = options.files?.[path];
      if (entry === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return typeof entry === "string" ? new TextEncoder().encode(entry) : entry;
    },
  };
  return {
    deps,
    env,
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
    exitCode: () => exitCode,
    calls,
  };
}

/** Parse the single JSON envelope a `--json` command prints to stdout. */
export function parseJsonOut(out: string): { ok: boolean; data?: unknown; error?: { code: string; message: string; status?: number; hint?: string } } {
  return JSON.parse(out.trim());
}

/** node-style argv the CLI expects (process.argv shape). */
export function argv(...parts: string[]): string[] {
  return ["node", "mailery", ...parts];
}
