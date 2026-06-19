export interface MaileryCloudClientOptions {
  apiUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MaileryCloudRequestOptions {
  method?: string;
  body?: unknown;
  tokenRequired?: boolean;
  idempotencyKey?: string;
  retries?: number;
  timeoutMs?: number;
}

export class MaileryCloudError extends Error {
  status?: number;
  retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "MaileryCloudError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

function normalizeApiUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) throw new MaileryCloudError("Mailery Cloud API URL is empty.");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new MaileryCloudError("Mailery Cloud API URL must use http or https.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function assertRelativeApiPath(path: string): void {
  if (!path.startsWith("/")) throw new MaileryCloudError("Mailery Cloud request path must start with '/'.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    throw new MaileryCloudError("Mailery Cloud request path must be relative, not an absolute URL.");
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function defaultRetries(method: string, idempotencyKey?: string): number {
  if (method === "GET" || method === "HEAD") return 2;
  return idempotencyKey ? 2 : 0;
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MaileryCloudError(`Mailery Cloud ${res.status}: response was not valid JSON`, {
      status: res.status,
      retryable: retryableStatus(res.status),
    });
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const error = obj["error"];
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return message;
    }
    const message = obj["message"];
    if (typeof message === "string") return message;
  }
  return fallback;
}

export class MaileryCloudClient {
  private apiUrl: string;
  private token?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private retries: number | undefined;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: MaileryCloudClientOptions) {
    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 20_000);
    this.retries = opts.retries;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(path: string, opts: MaileryCloudRequestOptions = {}): Promise<T> {
    assertRelativeApiPath(path);
    const method = (opts.method ?? "GET").toUpperCase();
    if (opts.tokenRequired !== false && !this.token) {
      throw new MaileryCloudError("Mailery Cloud is not authenticated. Run `mailery cloud login --api-key <key>` or set MAILERY_API_KEY.");
    }

    const maxRetries = Math.max(0, opts.retries ?? this.retries ?? defaultRetries(method, opts.idempotencyKey));
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1_000, opts.timeoutMs ?? this.timeoutMs));
      try {
        const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-mailery-client": "mailery-cli",
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        clearTimeout(timeout);

        const data = await parseJsonResponse(res);
        if (res.ok) return data as T;

        const retryable = retryableStatus(res.status);
        const err = new MaileryCloudError(`Mailery Cloud ${res.status}: ${errorMessage(data, res.statusText)}`, {
          status: res.status,
          retryable,
        });
        if (!retryable || attempt >= maxRetries) throw err;
        lastError = err;
      } catch (error) {
        clearTimeout(timeout);
        const retryable = error instanceof MaileryCloudError ? error.retryable : true;
        if (!retryable || attempt >= maxRetries) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new MaileryCloudError("Mailery Cloud request timed out.", { retryable: true });
          }
          if (error instanceof MaileryCloudError) throw error;
          throw new MaileryCloudError(`Mailery Cloud request failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
        }
        lastError = error;
      }

      await this.sleep(Math.min(2_000, 150 * (attempt + 1) ** 2));
    }

    throw lastError instanceof Error ? lastError : new MaileryCloudError("Mailery Cloud request failed.");
  }
}
