import { VERSION } from "./version.js";
// Resolves a MaileryClient from environment variables only.
// The CLI is cloud-only: the base URL defaults to https://mailery.co and is
// overridable ONLY via MAILERY_BASE_URL. There is no local-server mode and no
// persisted CLI config.

import { MaileryClient, type FetchLike } from "@hasna/mailery-sdk-internal";

export type Env = Record<string, string | undefined>;

export const DEFAULT_BASE_URL = "https://mailery.co";

export interface CliDeps {
  env: Env;
  fetch?: FetchLike;
  /** Text goes to stdout as usual; binary (attachment download) arrives as bytes. */
  stdout: (chunk: string | Uint8Array) => void;
  stderr: (chunk: string) => void;
  setExitCode: (code: number) => void;
  /** Injectable file writer for attachment downloads; defaults to fs/promises.writeFile. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
  /** Injectable file reader for `send --attach` / `send batch --file`; defaults to fs/promises.readFile. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Injectable clock/sleep so subscribe polling is deterministic in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable browser opener; defaults to a no-op when not provided. */
  openBrowser?: (url: string) => void;
  /** Whether the session is interactive (a TTY). Gates browser-open + progress. */
  interactive?: boolean;
  /** Reads piped stdin to completion (used by `send` for the body). */
  readStdin?: () => Promise<string>;
}

export function resolveBaseUrl(env: Env): string {
  const fromEnv = env.MAILERY_BASE_URL?.trim();
  return fromEnv || DEFAULT_BASE_URL;
}

export interface ClientOptions {
  /** Force session-only auth (owner routes); ignore any stored API key. */
  preferSession?: boolean;
  technicalClientName?: "mailery-cli" | "mailery-mcp";
  /** Override the API key (e.g. a freshly minted one before exporting it). */
  apiKey?: string;
  /** Override the session token. */
  sessionToken?: string;
  retries?: number;
  timeoutMs?: number;
}

export function buildClient(deps: CliDeps, options: ClientOptions = {}): MaileryClient {
  const baseUrl = resolveBaseUrl(deps.env);
  // Credentials come ONLY from env vars or explicit options (never from local config)
  const apiKey = options.preferSession
    ? undefined
    : options.apiKey ?? deps.env.MAILERY_API_KEY?.trim();
  const sessionToken = options.sessionToken ?? deps.env.MAILERY_SESSION_TOKEN?.trim();
  return new MaileryClient({
    baseUrl,
    clientDeclaration: { name: options.technicalClientName ?? "mailery-cli", version: VERSION },
    apiKey: apiKey || undefined,
    sessionToken: sessionToken || undefined,
    fetch: deps.fetch,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    sleep: deps.sleep,
  });
}
