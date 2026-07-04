export const DEFAULT_MAILERY_CLOUD_API_URL = "https://mailery.co";

export type MaileryCloudAuthVia = "session" | "api_key" | "admin_key" | string;
export type MaileryCloudUserRole = "owner" | "admin" | "member" | "viewer";
export type MaileryCloudMailboxProvider = "manual" | "resend" | "ses" | "gmail" | "sandbox";
export type MaileryCloudMailboxStatus = "active" | "paused" | "error";
export type MaileryCloudMessageDirection = "inbound" | "outbound";
export type MaileryCloudDigestWindow = "today" | "yesterday" | "last_7_days" | "month";
export type MaileryCloudCheckoutKind = "subscription" | "credit_pack";

export interface MaileryCloudClientOptions {
  apiUrl?: string;
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
  headers?: Record<string, string>;
}

export interface MaileryCloudUser {
  id: string;
  email: string;
  name: string | null;
  tenantId: string;
  role: MaileryCloudUserRole;
  isPlatformAdmin: boolean;
}

export interface MaileryCloudTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaileryCloudMeResponse {
  user: MaileryCloudUser | null;
  tenant: MaileryCloudTenant | null;
  auth: { via: MaileryCloudAuthVia; scopes: string[] };
}

export interface MaileryCloudAuthResponse {
  token: string;
  user?: MaileryCloudUser;
  tenant?: MaileryCloudTenant;
}

export interface MaileryCloudMailbox {
  id: string;
  tenantId: string;
  name: string | null;
  email: string;
  provider: MaileryCloudMailboxProvider;
  status: MaileryCloudMailboxStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MaileryCloudAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum?: string | null;
  storageDriver?: string;
  storageKey?: string | null;
  metadata?: Record<string, unknown>;
  contentBase64?: string;
  download_url?: string;
  downloadUrl?: string;
  body?: Record<string, unknown>;
}

export interface MaileryCloudMessage {
  id: string;
  tenantId: string;
  mailboxId: string;
  direction: MaileryCloudMessageDirection;
  status: string;
  subject: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  externalId?: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  textBody: string | null;
  htmlBody: string | null;
  rawEmail?: string | null;
  cleanMarkdown: string | null;
  summary: string | null;
  parserModel: string | null;
  classification: Record<string, unknown>;
  labels?: Array<string | { name?: string | null; label?: string | null; kind?: string | null }>;
  label_names?: string[];
  label_ids?: string[];
  custom_labels?: string[];
  digest_ids?: string[];
  digestIds?: string[];
  metadata?: Record<string, unknown>;
  importanceScore: number;
  isRead: boolean;
  isImportant: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isArchived: boolean;
  // Starred flag (E4) — server emits both snake/camel casing on the list projection.
  isStarred?: boolean;
  is_starred?: boolean;
  // Lightweight list-projection fields (bodyless list + delta feed). Present on
  // GET /messages and GET /messages/changes items, omitted on full GET /messages/:id.
  threadId?: string | null;
  thread_id?: string | null;
  snippet?: string;
  hasAttachments?: boolean;
  has_attachments?: boolean;
  sortAt?: string;
  sort_at?: string;
  isDeleted?: boolean;
  deleted?: boolean;
  tombstone?: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaileryCloudMessageWithAttachments extends MaileryCloudMessage {
  attachments: MaileryCloudAttachment[];
}

export interface MaileryCloudMessageTombstone {
  id: string;
  tenantId?: string;
  mailboxId?: string;
  mailbox_id?: string | null;
  externalId?: string | null;
  external_id?: string | null;
  message_id?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  status?: string;
  deleted?: boolean;
  isDeleted?: boolean;
  tombstone?: boolean;
  deletedAt?: string | null;
  deleted_at?: string | null;
  updatedAt?: string;
  createdAt?: string;
  created_at?: string;
}

export type MaileryCloudMessageListItem = MaileryCloudMessage | MaileryCloudMessageTombstone;

export interface MaileryCloudMessagePage {
  data: MaileryCloudMessageListItem[];
  nextCursor: string | null;
}

// A message label record as returned by the label mutation routes (E3) and the
// list/read projections (`label_records`).
export interface MaileryCloudLabelRecord {
  id: string;
  name: string;
  color: string;
  kind: "system" | "custom";
}

// Response shape of POST /messages/:id/labels and DELETE /messages/:id/labels/:label.
export interface MaileryCloudLabelMutationResult {
  ok: boolean;
  labels: MaileryCloudLabelRecord[];
  label_records?: MaileryCloudLabelRecord[];
  label_names: string[];
}

// Request body of POST /messages/send (hosted mail). mailboxId is required and the
// sender domain must be outbound-ready or the server fails closed before charging.
export interface MaileryCloudSendInput {
  mailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string[];
}

// POST /messages/send returns the created message (publicMessage shape) plus the
// provider message id and the mail mode. Status 202.
export interface MaileryCloudSendResult extends MaileryCloudMessageWithAttachments {
  provider_message_id?: string | null;
  providerMessageId?: string | null;
  mode?: string;
}

// E6 bulk mutation. Either `ids` (explicit, bounded id list) OR a
// `{ mailboxId, folder }` filter, plus an action. `cursor` resumes a filter drain.
export type MaileryCloudBulkAction =
  | "markRead"
  | "markUnread"
  | "important"
  | "unimportant"
  | "star"
  | "unstar"
  | "archive"
  | "unarchive"
  | "spam"
  | "unspam"
  | "trash"
  | "untrash"
  | "addLabel"
  | "removeLabel"
  | "delete";

export interface MaileryCloudBulkInput {
  action: MaileryCloudBulkAction | string;
  ids?: string[];
  mailboxId?: string;
  folder?: string;
  label?: string;
  cursor?: string;
}

export interface MaileryCloudBulkResult {
  ok: boolean;
  action: string;
  affected: number;
  matched: number;
  hasMore: boolean;
  nextCursor: string | null;
}

// GET /messages/changes — JMAP changesSince delta feed (created-or-changed live
// messages since a watermark, ordered by updated_at ASC). Deletions come from
// listMessageTombstones. Only a mailbox scope is supported alongside updatedSince.
export interface MaileryCloudMessageChangesQuery {
  updatedSince?: string;
  mailboxId?: string;
  cursor?: string;
  limit?: number;
}

export interface MaileryCloudMessageUploadInput {
  mailboxId: string;
  direction?: MaileryCloudMessageDirection;
  status?: string;
  subject?: string;
  from?: string;
  fromAddress?: string;
  to?: string[];
  toAddresses?: string[];
  cc?: string[];
  ccAddresses?: string[];
  receivedAt?: string;
  sentAt?: string;
  text?: string;
  textBody?: string | null;
  html?: string;
  htmlBody?: string | null;
  parse?: boolean;
  externalId?: string;
}

export interface MaileryCloudGroupCounts {
  inbox?: number;
  important?: number;
  unread?: number;
  archived?: number;
  spam?: number;
  trash?: number;
  [key: string]: number | undefined;
}

export interface MaileryCloudDigest {
  id: string;
  window: MaileryCloudDigestWindow;
  title: string;
  summary: string;
  periodStart: string;
  periodEnd: string;
  messageCount: number;
  importantCount: number;
  highlights?: string[];
  actionItems?: string[];
  action_items?: string[];
  messageIds?: string[];
  message_ids?: string[];
  importantMessageIds?: string[];
  important_message_ids?: string[];
  labelCounts?: Record<string, number>;
  label_counts?: Record<string, number>;
  model?: string | null;
  status?: string | null;
  error?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface MaileryCloudPlan {
  name: string;
  amountCents: number;
  monthlyCredits: number;
}

export interface MaileryCloudCreditTransaction {
  id: string;
  delta: number;
  reason: string;
  source: string;
  balanceAfter: number;
  createdAt: string;
}

export interface MaileryCloudBillingOverview {
  balance: number;
  plans: Record<string, MaileryCloudPlan>;
  credit_packs: Record<string, number>;
  subscriptions: Array<Record<string, unknown>>;
  ledger: MaileryCloudCreditTransaction[];
}

export interface MaileryCloudApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MaileryCloudDomainAvailability {
  domain: string;
  available: boolean;
  price?: string | number;
  currency?: string;
  premium?: boolean;
}

export interface MaileryCloudDomainSetupInput {
  domain: string;
  address?: string;
  purchase?: boolean;
  provider?: "ses" | "route53" | "open-domains" | string;
  catchAll?: boolean;
  mxMigrationConsent?: boolean;
}

export interface MaileryCloudDomainSetupResult {
  domain: string;
  status: string;
  steps?: string[];
  records?: unknown[];
}

export class MaileryCloudError extends Error {
  status?: number;
  code?: string;
  retryable: boolean;
  details?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "MaileryCloudError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

function normalizeApiUrl(apiUrl: string | undefined): string {
  const raw = (apiUrl || DEFAULT_MAILERY_CLOUD_API_URL).trim();
  if (!raw) return DEFAULT_MAILERY_CLOUD_API_URL;
  return raw.replace(/\/+$/, "");
}

function apiPath(path: string): string {
  if (!path || path === "/") return "/api/v1";
  if (path.startsWith("/api/v1")) return path;
  return `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function coerceErrorMessage(data: unknown, fallback: string): { message: string; code?: string; details?: unknown } {
  if (!data || typeof data !== "object") return { message: fallback };
  const record = data as Record<string, unknown>;
  const error = record["error"];
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    return {
      message: typeof err["message"] === "string" ? err["message"] : fallback,
      code: typeof err["code"] === "string" ? err["code"] : undefined,
      details: err["details"],
    };
  }
  return {
    message: typeof record["message"] === "string" ? String(record["message"]) : fallback,
    code: typeof record["code"] === "string" ? String(record["code"]) : undefined,
    details: record["details"],
  };
}

function normalizeMessageResponse(value: MaileryCloudMessageWithAttachments | {
  message: MaileryCloudMessage;
  attachments?: MaileryCloudAttachment[];
}): MaileryCloudMessageWithAttachments {
  if ("message" in value) return { ...value.message, attachments: value.attachments ?? [] };
  return { ...value, attachments: value.attachments ?? [] };
}

function normalizeMessagePageResponse(value: { data: MaileryCloudMessageListItem[]; next_cursor?: string | null; nextCursor?: string | null }): MaileryCloudMessagePage {
  return { data: value.data, nextCursor: value.next_cursor ?? value.nextCursor ?? null };
}

function normalizeBulkResponse(value: {
  ok?: boolean;
  action?: string;
  affected?: number;
  matched?: number;
  hasMore?: boolean;
  has_more?: boolean;
  nextCursor?: string | null;
  next_cursor?: string | null;
}): MaileryCloudBulkResult {
  return {
    ok: value.ok ?? true,
    action: String(value.action ?? ""),
    affected: value.affected ?? 0,
    matched: value.matched ?? 0,
    hasMore: value.hasMore ?? value.has_more ?? false,
    nextCursor: value.nextCursor ?? value.next_cursor ?? null,
  };
}

function normalizeLabelMutationResponse(value: {
  ok?: boolean;
  labels?: MaileryCloudLabelRecord[];
  label_records?: MaileryCloudLabelRecord[];
  label_names?: string[];
}): MaileryCloudLabelMutationResult {
  const labels = value.labels ?? value.label_records ?? [];
  return {
    ok: value.ok ?? true,
    labels,
    label_records: value.label_records ?? labels,
    label_names: value.label_names ?? labels.map((label) => label.name),
  };
}

export class MaileryCloudClient {
  private apiUrl: string;
  private token?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: MaileryCloudClientOptions = {}) {
    this.apiUrl = normalizeApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 1;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  setToken(token: string | undefined): void {
    this.token = token || undefined;
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  async request<T>(path: string, opts: MaileryCloudRequestOptions = {}): Promise<T> {
    const method = (opts.method ?? (opts.body === undefined ? "GET" : "POST")).toUpperCase();
    const retries = Math.max(0, opts.retries ?? this.retries);
    const timeoutMs = Math.max(1, opts.timeoutMs ?? this.timeoutMs);
    const url = `${this.apiUrl}${apiPath(path)}`;
    const tokenRequired = opts.tokenRequired ?? true;
    if (tokenRequired && !this.token) {
      throw new MaileryCloudError("Mailery Cloud authentication is required. Run `mailery cloud login` first.", {
        code: "unauthorized",
        status: 401,
      });
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = { ...(opts.headers ?? {}) };
        if (opts.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
        if (this.token) headers["authorization"] = `Bearer ${this.token}`;
        if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await response.text();
        const data = text ? JSON.parse(text) as unknown : {};
        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          if (retryable && attempt < retries) {
            await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
            continue;
          }
          const err = coerceErrorMessage(data, `${method} ${apiPath(path)} failed (${response.status})`);
          throw new MaileryCloudError(err.message, {
            status: response.status,
            code: err.code,
            retryable,
            details: err.details,
          });
        }
        return data as T;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof MaileryCloudError) throw error;
        const retryable = attempt < retries;
        if (retryable) {
          await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
          continue;
        }
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new MaileryCloudError(aborted ? `Mailery Cloud request timed out after ${timeoutMs}ms` : `Cannot reach Mailery Cloud at ${this.apiUrl}`, {
          code: aborted ? "timeout" : "network",
          retryable: aborted,
        });
      }
    }
  }

  health(): Promise<{ version: string; service: string; open_source?: string }> {
    return this.request("", { tokenRequired: false });
  }

  signup(input: { email: string; password: string; name?: string }): Promise<MaileryCloudAuthResponse> {
    return this.request("/auth/signup", { method: "POST", body: input, tokenRequired: false });
  }

  login(input: { email: string; password: string }): Promise<MaileryCloudAuthResponse> {
    return this.request("/auth/login", { method: "POST", body: input, tokenRequired: false });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request("/auth/logout", { method: "POST", tokenRequired: false });
  }

  me(): Promise<MaileryCloudMeResponse> {
    return this.request("/auth/me");
  }

  listMailboxes(): Promise<MaileryCloudMailbox[]> {
    return this.request<{ data: MaileryCloudMailbox[] }>("/mailboxes").then((result) => result.data);
  }

  createMailbox(input: { email: string; name?: string; provider?: MaileryCloudMailboxProvider }): Promise<MaileryCloudMailbox> {
    return this.request("/mailboxes", { method: "POST", body: input });
  }

  messageGroups(opts: { mailboxId?: string } = {}): Promise<MaileryCloudGroupCounts> {
    const query = opts.mailboxId ? `?mailboxId=${encodeURIComponent(opts.mailboxId)}` : "";
    return this.request(`/messages/groups${query}`);
  }

  listMessagesPage(opts: { group?: string; q?: string; limit?: number; cursor?: string; mailboxId?: string; direction?: string; threadId?: string } = {}): Promise<MaileryCloudMessagePage> {
    const params = new URLSearchParams();
    // group covers folder views incl. sent (direction=outbound) and starred (E4/E5).
    if (opts.group) params.set("group", opts.group);
    if (opts.q) params.set("q", opts.q);
    if (opts.mailboxId) params.set("mailboxId", opts.mailboxId);
    if (opts.direction) params.set("direction", opts.direction);
    if (opts.threadId) params.set("threadId", opts.threadId);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const query = params.toString();
    return this.request<{ data: MaileryCloudMessageListItem[]; next_cursor?: string | null; nextCursor?: string | null }>(`/messages${query ? `?${query}` : ""}`)
      .then(normalizeMessagePageResponse);
  }

  listMessages(opts: { group?: string; q?: string; limit?: number; cursor?: string; mailboxId?: string; direction?: string; threadId?: string } = {}): Promise<MaileryCloudMessageListItem[]> {
    return this.listMessagesPage(opts).then((result) => result.data);
  }

  // E2: thread grouping. GET /messages?threadId=... returns every message in a
  // thread (bodyless list projection), newest first. A blank threadId is a 400.
  listThread(threadId: string, opts: { limit?: number; cursor?: string; mailboxId?: string } = {}): Promise<MaileryCloudMessagePage> {
    return this.listMessagesPage({ ...opts, threadId });
  }

  // E1: JMAP changesSince delta feed. GET /messages/changes returns live messages
  // created-or-changed since `updatedSince`, ordered by updated_at ASC, so a bounded
  // cache can advance a watermark. Deletions come from listMessageTombstones.
  listMessageChanges(opts: MaileryCloudMessageChangesQuery = {}): Promise<MaileryCloudMessagePage> {
    const params = new URLSearchParams();
    if (opts.updatedSince) params.set("updatedSince", opts.updatedSince);
    if (opts.mailboxId) params.set("mailboxId", opts.mailboxId);
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const query = params.toString();
    return this.request<{ data: MaileryCloudMessageListItem[]; next_cursor?: string | null; nextCursor?: string | null }>(`/messages/changes${query ? `?${query}` : ""}`)
      .then(normalizeMessagePageResponse);
  }

  createMessage(input: MaileryCloudMessageUploadInput): Promise<MaileryCloudMessageWithAttachments> {
    return this.request<MaileryCloudMessageWithAttachments>("/messages", { method: "POST", body: input });
  }

  getMessage(id: string): Promise<MaileryCloudMessageWithAttachments> {
    return this.request<MaileryCloudMessageWithAttachments | { message: MaileryCloudMessage; attachments?: MaileryCloudAttachment[] }>(`/messages/${encodeURIComponent(id)}`)
      .then(normalizeMessageResponse);
  }

  patchMessage(id: string, patch: Partial<Pick<MaileryCloudMessage, "isRead" | "isImportant" | "isArchived" | "isSpam" | "isTrash" | "isStarred">>): Promise<MaileryCloudMessage> {
    return this.request(`/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  }

  // E4: star/unstar via the flag patch route (bumps updated_at → observed by the delta feed).
  setMessageStarred(id: string, isStarred: boolean): Promise<MaileryCloudMessage> {
    return this.patchMessage(id, { isStarred });
  }

  // POST /api/v1/messages/send — hosted send from an outbound-ready tenant domain.
  sendMessage(input: MaileryCloudSendInput): Promise<MaileryCloudSendResult> {
    return this.request<MaileryCloudSendResult>("/messages/send", { method: "POST", body: input })
      .then((result) => ({ ...result, attachments: result.attachments ?? [] }));
  }

  // E3: POST /api/v1/messages/:id/labels — add a custom/system label to a message.
  addMessageLabel(id: string, label: string): Promise<MaileryCloudLabelMutationResult> {
    return this.request<MaileryCloudLabelMutationResult>(`/messages/${encodeURIComponent(id)}/labels`, { method: "POST", body: { label } })
      .then(normalizeLabelMutationResponse);
  }

  // E3: DELETE /api/v1/messages/:id/labels/:label — remove a label (by name). Idempotent.
  removeMessageLabel(id: string, label: string): Promise<MaileryCloudLabelMutationResult> {
    return this.request<MaileryCloudLabelMutationResult>(`/messages/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
      .then(normalizeLabelMutationResponse);
  }

  // E6: POST /api/v1/messages/bulk — bounded, counter-correct bulk mutation over an
  // explicit id list OR a { mailboxId, folder } filter. Returns counts + a resume cursor.
  bulkMessageAction(input: MaileryCloudBulkInput): Promise<MaileryCloudBulkResult> {
    return this.request<Parameters<typeof normalizeBulkResponse>[0]>("/messages/bulk", { method: "POST", body: input })
      .then(normalizeBulkResponse);
  }

  deleteMessage(id: string, input: { reason?: string } = {}): Promise<{ ok: boolean; tombstone: MaileryCloudMessageTombstone }> {
    return this.request(`/messages/${encodeURIComponent(id)}`, { method: "DELETE", body: input });
  }

  listMessageTombstones(opts: { limit?: number; since?: string } = {}): Promise<MaileryCloudMessageTombstone[]> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.since) params.set("since", opts.since);
    const query = params.toString();
    return this.request<{ data: MaileryCloudMessageTombstone[] }>(`/messages/tombstones${query ? `?${query}` : ""}`)
      .then((result) => result.data);
  }

  parseMessage(id: string): Promise<unknown> {
    return this.request(`/messages/${encodeURIComponent(id)}/parse`, { method: "POST" });
  }

  listDigests(opts: { limit?: number } = {}): Promise<MaileryCloudDigest[]> {
    const query = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return this.request<{ data: MaileryCloudDigest[] }>(`/digests${query}`).then((result) => result.data);
  }

  generateDigest(window: MaileryCloudDigestWindow): Promise<MaileryCloudDigest> {
    return this.request("/digests/generate", { method: "POST", body: { window } });
  }

  billingOverview(opts: { limit?: number } = {}): Promise<MaileryCloudBillingOverview> {
    const query = opts.limit ? `?limit=${encodeURIComponent(String(opts.limit))}` : "";
    return this.request(`/billing/overview${query}`);
  }

  createCheckout(input: { kind: MaileryCloudCheckoutKind; plan?: string; credits?: number }): Promise<{ url: string }> {
    return this.request("/billing/checkout", { method: "POST", body: input });
  }

  createPortal(): Promise<{ url: string }> {
    return this.request("/billing/portal", { method: "POST", body: {} });
  }

  listApiKeys(): Promise<MaileryCloudApiKey[]> {
    return this.request<{ data: MaileryCloudApiKey[] }>("/api-keys").then((result) => result.data);
  }

  createApiKey(input: { name: string; scopes?: string[] }): Promise<{ key: string; api_key: MaileryCloudApiKey }> {
    return this.request("/api-keys", { method: "POST", body: input });
  }

  revokeApiKey(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  }

  checkDomainAvailability(domain: string): Promise<MaileryCloudDomainAvailability> {
    return this.request(`/domains/availability?domain=${encodeURIComponent(domain)}`);
  }

  setupDomain(input: MaileryCloudDomainSetupInput): Promise<MaileryCloudDomainSetupResult> {
    return this.request("/domains/setup", { method: "POST", body: input });
  }
}
