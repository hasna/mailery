// MaileryClient — a zero-dependency TypeScript client for the Mailery
// /api/v1. Aligned to src/server/app.ts; the server is the source of
// truth. Runs anywhere a WHATWG `fetch` exists (Bun, Node 18+, browsers); the
// fetch is injectable so it can be pointed at an in-process Hono `app.fetch`
// for contract tests.

import {
  MaileryAuthRequiredError,
  MaileryError,
  MaileryTimeoutError,
} from "./errors.js";
import { ENDPOINTS, type EndpointSpec } from "./endpoints.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp.js";
import type {
  AccountExportOptions,
  AdminApiResult,
  AdminBillingAnomaliesOptions,
  AdminBillingAnomaliesResult,
  AdminAuditPurgeInput,
  AdminAuditPurgePreflight,
  AdminAuditPurgeResult,
  AdminCreditAdjustmentInput,
  AdminCreditAdjustmentResult,
  AdminTenantFreezeInput,
  AdminTenantUnfreezeInput,
  BillingPortalResult,
  BulkMessageInput,
  BulkMessageResult,
  CreateApiKeyInput,
  CreateApiKeyResult,
  CreateCheckoutInput,
  CheckoutCountryPolicy,
  CreateDomainInput,
  CreateMailboxInput,
  DeleteAccountInput,
  DmarcPolicyInput,
  DmarcReportInput,
  DomainActionResult,
  ListInboxOptions,
  LabelMutationResult,
  ListDomainEventsOptions,
  LoginInput,
  MaileryApiKey,
  MaileryMailbox,
  MaileryAuthResult,
  MaileryBillingOverview,
  MaileryDomainRenewal,
  MaileryDomainRenewResult,
  MaileryWallet,
  RenewDomainInput,
  WalletTopupInput,
  WalletTopupResult,
  MaileryDigest,
  MaileryDigestWindow,
  MaileryDomainAvailability,
  MaileryDomainStatus,
  MaileryFeedbackEntry,
  MaileryLabel,
  MaileryMeResponse,
  MaileryDomainPurchaseResult,
  MaileryMessageChangesPage,
  MaileryMessagePage,
  MaileryMessageTombstone,
  MaileryMessageWithAttachments,
  MaileryTenantDomain,
  MaileryUsage,
  MaileryWebhookDelivery,
  MaileryWebhookDeliveryPage,
  MaileryWebhookEndpoint,
  MaileryWebhookSecretResult,
  MaileryWebhookTestResult,
  CreateWebhookInput,
  ListWebhookDeliveriesOptions,
  RotateWebhookSecretOptions,
  UpdateWebhookInput,
  MessageChangesOptions,
  MessageGroupsOptions,
  MessagePatchInput,
  MessageTombstonesOptions,
  PasswordForgotInput,
  PasswordResetInput,
  PurchaseDomainInput,
  MaileryMessageEvents,
  SendBatchItem,
  SendBatchResult,
  SendInput,
  SendResult,
  SetupDomainInput,
  SignupInput,
  SubmitFeedbackInput,
  UploadMessageInput,
  VerificationPollResult,
  VerifyEmailInput,
  VerifyPollInput,
  WaitForEntitlementOptions,
  DeleteMailboxOptions,
  DeleteMailboxResult,
  ListSuppressionsOptions,
  MailerySuppression,
  MailerySuppressionPage,
  DeleteSuppressionOptions,
  DeleteSuppressionResult,
} from "./types.js";

/** WHATWG fetch shape — matches both the global `fetch` and Hono's `app.fetch`-wrapped adapter. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MaileryClientOptions {
  /** Base origin of the API, e.g. "https://mailery.co". Trailing slashes are trimmed. */
  baseUrl: string;
  /** Tenant API key (ml_…) for the daily surface (send/inbox/messages/domains/feedback). */
  apiKey?: string;
  /** Owner session token (from signup/login) for owner-only routes (keys/checkout). */
  sessionToken?: string;
  /** Injectable fetch. Defaults to the global `fetch`; required so tests can inject `app.fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 20000). */
  timeoutMs?: number;
  /** Retry attempts for safe GETs and idempotency-key-protected mutations (default 1). */
  retries?: number;
  /** Injectable sleep, for deterministic retry/poll tests. */
  sleep?: (ms: number) => Promise<void>;
}

type AuthMode = "none" | "session" | "key" | "any" | "admin" | "optional";
const MANAGED_MAILBOX_PROVIDER = ["s", "e", "s"].join("");

interface RequestOptions {
  auth?: AuthMode;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  params?: Record<string, string>;
  idempotencyKey?: string;
  timeoutMs?: number;
  retries?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  const raw = (baseUrl ?? "").trim();
  if (!raw) throw new MaileryError("baseUrl is required", { code: "config" });
  return raw.replace(/\/+$/, "");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryCount(endpoint: EndpointSpec, options: RequestOptions, configuredRetries: number): number {
  // GETs are safe to replay. Mutations are only replayable when the caller
  // supplied one stable idempotency key that will be reused for every attempt.
  // Without that contract, a timeout/5xx can hide a committed first attempt.
  if (endpoint.method !== "GET" && !options.idempotencyKey) return 0;
  return Math.max(0, options.retries ?? configuredRetries);
}

function fillPath(template: string, params?: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = params?.[key];
    if (value === undefined) throw new MaileryError(`missing path parameter: ${key}`, { code: "config" });
    return encodeURIComponent(value);
  });
}

function coerceError(data: unknown, fallback: string): { message: string; code?: string; details?: unknown } {
  if (data && typeof data === "object") {
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
    if (typeof record["message"] === "string") {
      return { message: record["message"], code: typeof record["code"] === "string" ? record["code"] : undefined };
    }
  }
  return { message: fallback };
}

export class MaileryClient {
  readonly baseUrl: string;
  private apiKey?: string;
  private sessionToken?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: MaileryClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey || undefined;
    this.sessionToken = options.sessionToken || undefined;
    const injected = options.fetch;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const chosen = injected ?? globalFetch;
    if (!chosen) throw new MaileryError("no fetch implementation available; pass options.fetch", { code: "config" });
    this.fetchImpl = chosen;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = Math.max(0, options.retries ?? 1);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Swap in a session token after login/signup. */
  setSessionToken(token: string | undefined): void {
    this.sessionToken = token || undefined;
  }

  /** Swap in an API key after minting one. */
  setApiKey(key: string | undefined): void {
    this.apiKey = key || undefined;
  }

  private tokenFor(mode: AuthMode): string | undefined {
    switch (mode) {
      case "none":
        return undefined;
      case "optional":
        // Attach whatever credential is configured, never throw: some public
        // routes (verify/poll) accept anonymous callers and answer a uniform
        // `pending`, while presenting the signup SESSION unlocks issuance.
        // Session-first on purpose — the poll endpoint ignores API keys.
        return this.sessionToken ?? this.apiKey ?? undefined;
      case "session":
        if (!this.sessionToken) throw new MaileryAuthRequiredError("this operation requires a session token (signup/login first)");
        return this.sessionToken;
      case "key":
        if (!this.apiKey) throw new MaileryAuthRequiredError("this operation requires an API key");
        return this.apiKey;
      case "any": {
        const token = this.apiKey ?? this.sessionToken;
        if (!token) throw new MaileryAuthRequiredError("this operation requires an API key or a session token");
        return token;
      }
      case "admin": {
        const token = this.sessionToken ?? this.apiKey;
        if (!token) throw new MaileryAuthRequiredError("this operation requires an admin API key or a platform-admin session token");
        return token;
      }
    }
  }

  private urlFor(endpoint: EndpointSpec, options: RequestOptions = {}): { path: string; url: string } {
    const path = fillPath(endpoint.path, options.params);
    let url = `${this.baseUrl}${path}`;
    if (options.query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }
    return { path, url };
  }

  private async request<T>(endpoint: EndpointSpec, options: RequestOptions = {}): Promise<T> {
    const mode: AuthMode = options.auth ?? "any";
    const token = this.tokenFor(mode);
    const { path, url } = this.urlFor(endpoint, options);

    const retries = retryCount(endpoint, options, this.retries);
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.timeoutMs);

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {};
        if (options.body !== undefined) headers["content-type"] = "application/json";
        if (token) headers["authorization"] = `Bearer ${token}`;
        if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

        const response = await this.fetchImpl(url, {
          method: endpoint.method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const text = await response.text();
        let data: unknown = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            // Non-JSON body (e.g. a framework 404 text page or an HTML error).
            data = { raw: text };
          }
        }

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          if (retryable && attempt < retries) {
            await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
            continue;
          }
          const err = coerceError(data, `${endpoint.method} ${path} failed (${response.status})`);
          throw new MaileryError(err.message, { status: response.status, code: err.code, retryable, details: err.details });
        }
        return data as T;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof MaileryError) throw error;
        if (attempt < retries) {
          await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
          continue;
        }
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new MaileryError(
          aborted ? `Mailery request timed out after ${timeoutMs}ms` : `cannot reach Mailery at ${this.baseUrl}`,
          { code: aborted ? "timeout" : "network", retryable: aborted, cause: error },
        );
      }
    }
  }

  private async requestRaw(endpoint: EndpointSpec, options: RequestOptions = {}): Promise<Response> {
    const mode: AuthMode = options.auth ?? "any";
    const token = this.tokenFor(mode);
    const { path, url } = this.urlFor(endpoint, options);
    const retries = retryCount(endpoint, options, this.retries);
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.timeoutMs);

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {};
        if (token) headers["authorization"] = `Bearer ${token}`;
        if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
        const response = await this.fetchImpl(url, { method: endpoint.method, headers, signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
          const text = await response.text();
          let data: unknown = {};
          if (text) {
            try { data = JSON.parse(text); } catch { data = { raw: text }; }
          }
          const retryable = isRetryableStatus(response.status);
          if (retryable && attempt < retries) {
            await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
            continue;
          }
          const err = coerceError(data, `${endpoint.method} ${path} failed (${response.status})`);
          throw new MaileryError(err.message, { status: response.status, code: err.code, retryable, details: err.details });
        }
        return response;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof MaileryError) throw error;
        if (attempt < retries) {
          await this.sleep(Math.min(250 * 2 ** attempt, 2_000));
          continue;
        }
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new MaileryError(
          aborted ? `Mailery request timed out after ${timeoutMs}ms` : `cannot reach Mailery at ${this.baseUrl}`,
          { code: aborted ? "timeout" : "network", retryable: aborted, cause: error },
        );
      }
    }
  }

  // ─── Service info ──────────────────────────────────────────────────────────

  /** Public service info from the /api/v1 root (version, release_sha, modes). Unauthenticated. */
  health(): Promise<{ version: string; service: string; release_sha?: string; [key: string]: unknown }> {
    return this.request(ENDPOINTS.health, { auth: "none" });
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  getCurrentTerms(): Promise<import("./types.js").PublishedTerms> {
    return this.request(ENDPOINTS.getCurrentTerms, { auth: "none" });
  }

  async getTermsVersion(version: string): Promise<string> {
    const result = await this.request<{ raw: string }>(ENDPOINTS.getTermsVersion, { auth: "none", params: { version } });
    return result.raw;
  }

  acceptTerms(input: import("./types.js").TermsAcceptanceInput): Promise<import("./types.js").TermsAcceptanceReceipt> {
    return this.request(ENDPOINTS.acceptTerms, { auth: "session", body: input });
  }

  /** Create an account. Returns a session bootstrap and caches the session token on the client. */
  async signup(input: SignupInput): Promise<MaileryAuthResult> {
    const result = await this.request<MaileryAuthResult>(ENDPOINTS.signup, { auth: "none", body: input });
    if (result.token) this.setSessionToken(result.token);
    return result;
  }

  /** Log in with email + password. Caches the session token on the client. */
  async login(input: LoginInput): Promise<MaileryAuthResult> {
    const result = await this.request<MaileryAuthResult>(ENDPOINTS.login, { auth: "none", body: input });
    if (result.token) this.setSessionToken(result.token);
    return result;
  }

  /** Revoke the current session token server-side and clear it locally. */
  async logout(): Promise<{ ok: boolean }> {
    const result = await this.request<{ ok: boolean }>(ENDPOINTS.logout, { auth: "session" });
    this.setSessionToken(undefined);
    return result;
  }

  /** Return configured auth providers/capabilities for this deployment. */
  authProviders(): Promise<Record<string, unknown>> {
    return this.request(ENDPOINTS.authProviders, { auth: "none" });
  }

  /** Request a password-reset email. The server response is uniform for known/unknown accounts. */
  forgotPassword(input: string | PasswordForgotInput): Promise<{ ok: boolean; message?: string }> {
    const email = typeof input === "string" ? input : input.email;
    return this.request(ENDPOINTS.forgotPassword, { auth: "none", body: { email } });
  }

  /** Reset a password with the one-time reset token. */
  resetPassword(input: PasswordResetInput): Promise<{ ok: boolean }> {
    return this.request(ENDPOINTS.resetPassword, { auth: "none", body: input });
  }

  /** Verify an email address with the one-time verification token. */
  verifyEmail(input: string | VerifyEmailInput): Promise<{ ok: boolean; verified: boolean; email?: string }> {
    const token = typeof input === "string" ? input : input.token;
    return this.request(ENDPOINTS.verifyEmail, { auth: "none", body: { token } });
  }

  /**
   * Poll whether the emailed verification link has been clicked. Returns
   * `{ status: "pending" }` for every state the caller cannot act on — unknown
   * emails, unverified accounts, and any call lacking a live session for that
   * exact account — and `{ status: "verified", token }` (a fresh session with
   * the normal login scope set) once the human click landed. Presenting the
   * signup session is what unlocks issuance; anonymous polling learns nothing.
   * Pair with `signup()` for a fully scriptable bootstrap:
   * signup → poll until verified → keys create.
   */
  pollVerification(input: string | VerifyPollInput): Promise<VerificationPollResult> {
    const email = typeof input === "string" ? input : input.email;
    return this.request(ENDPOINTS.verifyPoll, { auth: "optional", body: { email } });
  }

  /** Who am I — resolves the caller's user (null for API keys), tenant, and auth scopes. */
  me(): Promise<MaileryMeResponse> {
    return this.request(ENDPOINTS.me, { auth: "any" });
  }

  /**
   * Re-send the email-verification link over the current session. The server
   * returns `{ verified: true }` (without re-sending) when the email is already
   * verified, or `{ verified: false }` after dispatching a fresh link. The link
   * itself is a one-time browser step — there is no code/OTP verify endpoint.
   */
  resendVerification(): Promise<{ ok: boolean; verified: boolean }> {
    return this.request(ENDPOINTS.resendVerification, { auth: "session" });
  }

  /** GDPR Art. 20 tenant export. Owner/admin session only; never billing-gated. */
  exportAccount(options: AccountExportOptions = {}): Promise<Record<string, unknown>> {
    return this.request(ENDPOINTS.accountExport, { auth: "session", query: { limit: options.limit, cursor: options.cursor } });
  }

  /** GDPR Art. 17 tenant deletion. Requires owner password re-authentication. */
  deleteAccount(input: DeleteAccountInput): Promise<{ ok: boolean; [key: string]: unknown }> {
    return this.request(ENDPOINTS.deleteAccount, { auth: "session", body: input });
  }

  // ─── API keys (owner session) ────────────────────────────────────────────────

  async listKeys(): Promise<MaileryApiKey[]> {
    const result = await this.request<{ data: MaileryApiKey[] }>(ENDPOINTS.listKeys, { auth: "session" });
    return result.data;
  }

  /** Mint a scoped API key. The plaintext `key` is returned exactly once. */
  createKey(input: CreateApiKeyInput = {}): Promise<CreateApiKeyResult> {
    return this.request(ENDPOINTS.createKey, { auth: "session", body: input });
  }

  revokeKey(id: string): Promise<{ ok: boolean }> {
    return this.request(ENDPOINTS.revokeKey, { auth: "session", params: { id } });
  }

  /**
   * Break-glass: revoke every API key for the tenant (pivot D-3). Calls
   * `POST /api/v1/keys/revoke-all` over the current session. The server also
   * accepts email+password in the body for the zero-usable-key escape hatch; the
   * CLI logs in first to obtain a session, then calls this.
   */
  revokeAllKeys(): Promise<{ ok: boolean; revoked?: number }> {
    return this.request(ENDPOINTS.revokeAllKeys, { auth: "session" });
  }

  // ─── Billing ───────────────────────────────────────────────────────────────

  /** First checkout step: present this list before collecting the country declaration or payment. */
  getCheckoutCountryPolicy(): Promise<CheckoutCountryPolicy> {
    return this.request(ENDPOINTS.getCheckoutCountryPolicy, { auth: "none" });
  }

  /**
   * Open Stripe Checkout after presenting getCheckoutCountryPolicy(). Current
   * new purchases require country, countryBasis and countryPolicyVersion.
   * Omitting all declaration fields can replay only an exact pre-country
   * purchase under its original key (including the historical no-header key).
   * An absent claim fails admission before any insert or provider call.
   * Retain the same purchase key on retry or uncertainty. A changed country or
   * policy conflicts with that key rather than creating another payable session.
   */
  async createCheckout(planOrInput: string | CreateCheckoutInput = "pro"): Promise<string> {
    const input: CreateCheckoutInput = typeof planOrInput === "string"
      ? { kind: "subscription", plan: planOrInput }
      : { kind: planOrInput.kind ?? "subscription", plan: planOrInput.plan, credits: planOrInput.credits, country: planOrInput.country, countryBasis: planOrInput.countryBasis, countryPolicyVersion: planOrInput.countryPolicyVersion };
    const idempotencyKey = typeof planOrInput === "string" ? undefined : planOrInput.idempotencyKey;
    const result = await this.request<{ url: string }>(ENDPOINTS.createCheckout, { auth: "session", body: input, idempotencyKey });
    return result.url;
  }

  /** Create a Stripe billing-portal session URL for the tenant. */
  async createBillingPortal(): Promise<string> {
    const result = await this.request<BillingPortalResult>(ENDPOINTS.billingPortal, { auth: "session" });
    return result.url;
  }

  /** Full billing overview: balance, wallet, plans, credit packs, subscriptions, and ledger. */
  getBillingStatus(options: { limit?: number } = {}): Promise<MaileryBillingOverview> {
    return this.request(ENDPOINTS.billingOverview, { auth: "any", query: { limit: options.limit } });
  }

  /**
   * Prepaid wallet balance and recent wallet transactions. This is the USD
   * balance domain purchases and renewals are charged against — NOT the send
   * credit balance. Requires billing_read.
   */
  getWallet(options: { limit?: number } = {}): Promise<MaileryWallet> {
    return this.request(ENDPOINTS.getWallet, { auth: "any", query: { limit: options.limit } });
  }

  /**
   * Open a Stripe Checkout session that adds funds to the prepaid wallet.
   * `amountCents` must be at least 1000 ($10.00). `idempotencyKey` is REQUIRED
   * and must be stable across YOUR retries so a retry replays the same session
   * instead of opening a second payable one. Retain every original declaration
   * field, including countryPolicyVersion. Omit all declaration fields only
   * to replay an exact pre-country claim; that cannot create a new claim.
   * New funding is disabled at paid opening (409 wallet_funding_disabled); exact-key replay is retained.
   */
  topUpWallet(input: WalletTopupInput): Promise<WalletTopupResult> {
    const { idempotencyKey, ...body } = input;
    return this.request(ENDPOINTS.topUpWallet, { auth: "session", body, idempotencyKey });
  }

  /**
   * Credit balance + recent ledger. The server has no dedicated /usage route, so
   * this is projected from GET /billing/overview.
   */
  async getUsage(options: { limit?: number } = {}): Promise<MaileryUsage> {
    const overview = await this.getBillingStatus(options);
    return { balance: overview.balance, ledger: overview.ledger, ...(overview.inbound_usage ? { inbound_usage: overview.inbound_usage } : {}) };
  }

  /** True when the tenant is entitled (active/trialing subscription or a positive balance). */
  private static isEntitled(overview: MaileryBillingOverview): boolean {
    const subActive = overview.subscriptions?.some((s) => s.status === "active" || s.status === "trialing");
    return Boolean(subActive) || (overview.balance ?? 0) > 0;
  }

  /**
   * Poll billing status until the tenant is entitled or the deadline elapses.
   * There is no dedicated entitlement-wait endpoint; this polls
   * GET /billing/overview. Throws MaileryTimeoutError on timeout.
   */
  async waitForEntitlement(options: WaitForEntitlementOptions = {}): Promise<MaileryBillingOverview> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = Math.max(1, options.intervalMs ?? 2_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted) throw new MaileryError("waitForEntitlement aborted", { code: "aborted" });
      const overview = await this.getBillingStatus();
      if (MaileryClient.isEntitled(overview)) return overview;
      if (Date.now() + intervalMs >= deadline) {
        throw new MaileryTimeoutError(`tenant not entitled within ${timeoutMs}ms`);
      }
      await this.sleep(intervalMs);
    }
  }

  // ─── Mailboxes ─────────────────────────────────────────────────────────────

  /** List the tenant's mailboxes. Requires mail_read. */
  async listMailboxes(): Promise<MaileryMailbox[]> {
    const result = await this.request<{ data: MaileryMailbox[] }>(ENDPOINTS.listMailboxes, { auth: "any" });
    return result.data;
  }

  /**
   * Create (or upsert by email) a mailbox. Requires mail_write + entitlement.
   * Hosted send needs a mailbox on an outbound-ready tenant domain.
   */
  createMailbox(input: CreateMailboxInput): Promise<MaileryMailbox> {
    const provider = input.provider === "hosted" ? MANAGED_MAILBOX_PROVIDER : input.provider;
    return this.request(ENDPOINTS.createMailbox, { auth: "any", body: { ...input, provider } });
  }

  /**
   * Delete a mailbox. Refused with 409 `mailbox_not_empty` while it still holds
   * messages unless `purge` is set, because message rows are removed with it.
   * Requires mail_write + entitlement.
   */
  deleteMailbox(id: string, options: DeleteMailboxOptions = {}): Promise<DeleteMailboxResult> {
    return this.request(ENDPOINTS.deleteMailbox, { auth: "any", params: { id }, query: { purge: options.purge ? "true" : undefined } });
  }

  // ─── Mail ────────────────────────────────────────────────────────────────────

  /**
   * Send hosted mail from an outbound-ready tenant domain. Requires
   * mail_write + entitlement.
   *
   * Pass `idempotencyKey` — YOUR stable key for this send — to make a retry
   * after a lost response replay the original result (`replayed: true`)
   * instead of sending, and charging, twice. The SDK forwards the key you give
   * it as `Idempotency-Key` and NEVER invents one: a key generated per call
   * would be different on the retry and protect nothing, and a key generated
   * per process would silently collapse two genuinely different sends into
   * one. Supplying a key also makes the send retryable by the client's own
   * transport retry, which is otherwise disabled for mutations.
   */
  async send(input: SendInput): Promise<SendResult> {
    const { idempotencyKey, ...body } = input;
    const result = await this.request<SendResult>(ENDPOINTS.send, { auth: "any", body, idempotencyKey });
    return { ...result, attachments: result.attachments ?? [] };
  }

  /**
   * Send up to 100 hosted messages in one call. Each item may carry its own
   * `idempotencyKey` and gets its own result; the batch is metered in one
   * transaction and the units of messages that failed before reaching the
   * provider are returned (see `metering` on the result).
   *
   * The published per-minute send limit applies PER MESSAGE, so a batch larger
   * than the remaining window is refused with 429 rather than partly sent.
   */
  sendBatch(messages: SendBatchItem[], options: { idempotencyKey?: string } = {}): Promise<SendBatchResult> {
    return this.request<SendBatchResult>(ENDPOINTS.sendBatch, {
      auth: "any",
      body: { messages: messages.map(({ idempotencyKey, ...rest }) => ({ ...rest, idempotencyKey })) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * One message's delivery timeline (newest first) plus its current status and
   * the provider timestamp of the newest event. The pull counterpart of the
   * `email.*` webhooks. Requires mail_read.
   */
  getMessageEvents(id: string, options: { limit?: number } = {}): Promise<MaileryMessageEvents> {
    return this.request<MaileryMessageEvents>(ENDPOINTS.listMessageEvents, { auth: "any", params: { id }, query: { limit: options.limit } });
  }

  /** List inbox messages (bodyless list projection) with folder/search/pagination. */
  listInbox(options: ListInboxOptions = {}): Promise<MaileryMessagePage> {
    return this.request<{ data: MaileryMessagePage["data"]; next_cursor?: string | null; nextCursor?: string | null }>(
      ENDPOINTS.listInbox,
      {
        auth: "any",
        query: {
          group: options.group,
          q: options.q,
          mailboxId: options.mailboxId,
          direction: options.direction,
          threadId: options.threadId,
          limit: options.limit,
          cursor: options.cursor,
        },
      },
    ).then((r) => ({ data: r.data, nextCursor: r.next_cursor ?? r.nextCursor ?? null }));
  }

  /** Upload a hosted message (optionally parse server-side). */
  uploadMessage(input: UploadMessageInput): Promise<MaileryMessageWithAttachments> {
    return this.request<MaileryMessageWithAttachments>(ENDPOINTS.uploadMessage, { auth: "any", body: input })
      .then((m) => ({ ...m, attachments: m.attachments ?? [] }));
  }

  /** List labels with live message counts. */
  async listLabels(): Promise<MaileryLabel[]> {
    const result = await this.request<{ data: MaileryLabel[] }>(ENDPOINTS.listLabels, { auth: "any" });
    return result.data;
  }

  /** Mailbox/folder group counts. */
  getMessageGroups(options: MessageGroupsOptions = {}): Promise<Record<string, unknown>> {
    return this.request(ENDPOINTS.messageGroups, { auth: "any", query: { mailboxId: options.mailboxId } });
  }

  /** Delta feed for created-or-changed messages since a watermark. */
  listMessageChanges(options: MessageChangesOptions = {}): Promise<MaileryMessageChangesPage> {
    return this.request<{
      data: MaileryMessageChangesPage["data"];
      next_cursor?: string | null;
      nextCursor?: string | null;
      server_time?: string;
      serverTime?: string;
      state?: string;
    }>(ENDPOINTS.messageChanges, {
      auth: "any",
      query: {
        since: options.since,
        updatedSince: options.updatedSince,
        cursor: options.cursor,
        limit: options.limit,
        mailboxId: options.mailboxId,
      },
    }).then((r) => ({ data: r.data, nextCursor: r.next_cursor ?? r.nextCursor ?? null, serverTime: r.server_time ?? r.serverTime, state: r.state }));
  }

  /** Tenant tombstone feed for deleted messages. */
  async listMessageTombstones(options: MessageTombstonesOptions = {}): Promise<MaileryMessageTombstone[]> {
    const result = await this.request<{ data: MaileryMessageTombstone[] }>(ENDPOINTS.messageTombstones, {
      auth: "any",
      query: { since: options.since, limit: options.limit, mailboxId: options.mailboxId },
    });
    return result.data;
  }

  /** Bounded bulk message mutation. */
  bulkMessages(input: BulkMessageInput): Promise<BulkMessageResult> {
    return this.request(ENDPOINTS.bulkMessages, { auth: "any", body: input });
  }

  /** Fetch one full message (with attachments). */
  getMessage(id: string): Promise<MaileryMessageWithAttachments> {
    return this.request<MaileryMessageWithAttachments>(ENDPOINTS.getMessage, { auth: "any", params: { id } })
      .then((m) => ({ ...m, attachments: m.attachments ?? [] }));
  }

  /** Update message flags. */
  updateMessage(id: string, patch: MessagePatchInput): Promise<MaileryMessageWithAttachments> {
    return this.request<MaileryMessageWithAttachments>(ENDPOINTS.updateMessage, { auth: "any", params: { id }, body: patch })
      .then((m) => ({ ...m, attachments: m.attachments ?? [] }));
  }

  /** Delete a message and return the server tombstone. */
  deleteMessage(id: string, options: { reason?: string } = {}): Promise<{ ok: boolean; tombstone: MaileryMessageTombstone }> {
    return this.request(ENDPOINTS.deleteMessage, { auth: "any", params: { id }, body: options.reason ? { reason: options.reason } : undefined });
  }

  addMessageLabel(id: string, label: string): Promise<LabelMutationResult> {
    return this.request(ENDPOINTS.addMessageLabel, { auth: "any", params: { id }, body: { label } });
  }

  removeMessageLabel(id: string, label: string): Promise<LabelMutationResult> {
    return this.request(ENDPOINTS.removeMessageLabel, { auth: "any", params: { id, label } });
  }

  parseMessage(id: string): Promise<Record<string, unknown>> {
    return this.request(ENDPOINTS.parseMessage, { auth: "any", params: { id } });
  }

  async listMessageAttachments(id: string): Promise<MaileryMessageWithAttachments["attachments"]> {
    const result = await this.request<{ data: MaileryMessageWithAttachments["attachments"] }>(ENDPOINTS.listMessageAttachments, { auth: "any", params: { id } });
    return result.data;
  }

  /** Download an attachment. Returns the raw Response so callers can stream bytes. */
  downloadAttachment(id: string): Promise<Response> {
    return this.requestRaw(ENDPOINTS.downloadAttachment, { auth: "any", params: { id } });
  }

  async listDigests(options: { limit?: number } = {}): Promise<MaileryDigest[]> {
    const result = await this.request<{ data: MaileryDigest[] }>(ENDPOINTS.listDigests, { auth: "any", query: { limit: options.limit } });
    return result.data;
  }

  generateDigest(window: MaileryDigestWindow = "today"): Promise<MaileryDigest> {
    return this.request(ENDPOINTS.generateDigest, { auth: "any", body: { window } });
  }

  // ─── Domains ──────────────────────────────────────────────────────────────────

  /** Check whether a domain can be used for a Mailery identity (GET /domains/availability). */
  searchDomains(domain: string): Promise<MaileryDomainAvailability> {
    return this.request(ENDPOINTS.searchDomains, { auth: "any", query: { domain } });
  }

  /** List the tenant's domains. */
  async listDomains(): Promise<MaileryTenantDomain[]> {
    const result = await this.request<{ data: MaileryTenantDomain[] }>(ENDPOINTS.listDomains, { auth: "any" });
    return result.data;
  }

  /** Add/connect a tenant domain record without provider-side DNS mutation. */
  createDomain(input: CreateDomainInput): Promise<MaileryTenantDomain> {
    return this.request(ENDPOINTS.createDomain, { auth: "any", body: input });
  }

  /** Buy/connect a domain and return DNS/mailbox setup details. */
  setupDomain(input: SetupDomainInput): Promise<DomainActionResult> {
    const { idempotencyKey, ...body } = input;
    return this.request(ENDPOINTS.setupDomain, { auth: "any", body, idempotencyKey });
  }

  /** Product-level readiness for a custom-domain identity (GET /domains/status). */
  getDomainStatus(domain: string): Promise<MaileryDomainStatus> {
    return this.request(ENDPOINTS.getDomainStatus, { auth: "any", query: { domain } });
  }

  /**
   * Buy a custom-domain identity and prepare it end-to-end for sending
   * (pivot phase P5, `POST /api/v1/domains/purchase`).
   * The call is idempotent and resumable: re-invoking with the same domain
   * continues from the current lifecycle state and never double-charges.
   * Requires the `domains:purchase` scope and an entitled tenant.
   * New purchases are disabled at paid opening (409 domain_sales_disabled); replay/reconciliation is retained.
   */
  purchaseDomain(input: PurchaseDomainInput): Promise<MaileryDomainPurchaseResult> {
    const { idempotencyKey, ...body } = input;
    return this.request(ENDPOINTS.purchaseDomain, { auth: "any", body, idempotencyKey });
  }

  /**
   * Renew a domain Mailery registered, charged to the prepaid wallet. The
   * charge is taken BEFORE the registrar call: an insufficient balance fails
   * with a 402 carrying the shortfall and never reaches the registrar.
   * Requires the domains:purchase scope and an idempotency key.
   * New renewals are disabled at paid opening (409 domain_sales_disabled); exact-key replay is retained.
   */
  renewDomain(input: RenewDomainInput): Promise<MaileryDomainRenewResult> {
    const { id, idempotencyKey, ...body } = input;
    return this.request(ENDPOINTS.renewDomain, { auth: "any", params: { id }, body, idempotencyKey });
  }

  /**
   * Turn the auto-renew opt-in on or off. Auto-renew proceeds only when the
   * prepaid wallet covers the renewal quote; otherwise Mailery notifies rather
   * than letting the domain lapse silently. Charges nothing.
   * Enabling is unavailable at paid opening (409 domain_sales_disabled); disabling remains available.
   */
  setDomainAutoRenew(id: string, enabled: boolean): Promise<MaileryDomainRenewal> {
    return this.request(ENDPOINTS.setDomainAutoRenew, { auth: "any", params: { id }, body: { enabled } });
  }

  /** Read one tenant domain lifecycle record. */
  getDomain(id: string): Promise<MaileryTenantDomain> {
    return this.request(ENDPOINTS.getDomain, { auth: "any", params: { id } });
  }

  deleteDomain(id: string): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.deleteDomain, { auth: "any", params: { id } });
  }

  async listDomainDns(id: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{ data: Array<Record<string, unknown>> }>(ENDPOINTS.listDomainDns, { auth: "any", params: { id } });
    return result.data;
  }

  async listDomainEvents(id: string, options: ListDomainEventsOptions = {}): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{ data: Array<Record<string, unknown>> }>(ENDPOINTS.listDomainEvents, { auth: "any", params: { id }, query: { limit: options.limit } });
    return result.data;
  }

  recordDmarcReport(id: string, input: DmarcReportInput): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.recordDmarcReport, { auth: "any", params: { id }, body: input });
  }

  updateDmarcPolicy(id: string, input: DmarcPolicyInput): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.updateDmarcPolicy, { auth: "any", params: { id }, body: input });
  }

  verifyDomain(id: string): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.verifyDomain, { auth: "any", params: { id } });
  }

  enableDomainInbound(id: string): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.enableDomainInbound, { auth: "any", params: { id } });
  }

  enableDomainOutbound(id: string): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.enableDomainOutbound, { auth: "any", params: { id } });
  }

  disableDomain(id: string, reason?: string): Promise<DomainActionResult> {
    return this.request(ENDPOINTS.disableDomain, { auth: "any", params: { id }, body: reason ? { reason } : undefined });
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────────

  /** List the tenant's webhook endpoints (secret prefixes only). Requires mail_read. */
  async listWebhooks(): Promise<MaileryWebhookEndpoint[]> {
    const result = await this.request<{ data: MaileryWebhookEndpoint[] }>(ENDPOINTS.listWebhooks, { auth: "any" });
    return result.data;
  }

  /**
   * Register a webhook endpoint. The plaintext signing `secret` is returned
   * exactly once — store it where the receiver can verify Mailery-Signature.
   *
   * Supply `idempotencyKey` (a key stable across YOUR retries) to make a
   * repeat of this exact call replay the original endpoint and secret instead
   * of registering a second endpoint. The SDK deliberately does not invent one:
   * the server binds terminal failures to the key, so an auto-generated key
   * would turn the client retry loop into a replay of the same error and spend
   * the create rate-limit budget for nothing.
   */
  createWebhook(input: CreateWebhookInput): Promise<MaileryWebhookSecretResult> {
    const { idempotencyKey, ...body } = input;
    return this.request(ENDPOINTS.createWebhook, { auth: "any", body, idempotencyKey });
  }

  getWebhook(id: string): Promise<MaileryWebhookEndpoint> {
    return this.request(ENDPOINTS.getWebhook, { auth: "any", params: { id } });
  }

  /** Update url/description/events/status. `status: "active"` re-enables a disabled or breaker-tripped endpoint. */
  updateWebhook(id: string, patch: UpdateWebhookInput): Promise<MaileryWebhookEndpoint> {
    return this.request(ENDPOINTS.updateWebhook, { auth: "any", params: { id }, body: patch });
  }

  deleteWebhook(id: string): Promise<{ ok: boolean; id: string }> {
    return this.request(ENDPOINTS.deleteWebhook, { auth: "any", params: { id } });
  }

  /**
   * Replace the signing secret; the old one stops validating immediately and
   * the new plaintext is shown once. Pass `idempotencyKey` to make a retry
   * replay that same new secret rather than rotating twice.
   */
  rotateWebhookSecret(id: string, options: RotateWebhookSecretOptions = {}): Promise<MaileryWebhookSecretResult> {
    return this.request(ENDPOINTS.rotateWebhookSecret, { auth: "any", params: { id }, idempotencyKey: options.idempotencyKey });
  }

  /** Enqueue a `webhook.test` event for one endpoint (202). */
  testWebhook(id: string): Promise<MaileryWebhookTestResult> {
    return this.request(ENDPOINTS.testWebhook, { auth: "any", params: { id } });
  }

  /** Delivery history for one endpoint, newest first, keyset-paginated. */
  listWebhookDeliveries(id: string, options: ListWebhookDeliveriesOptions = {}): Promise<MaileryWebhookDeliveryPage> {
    return this.request<{ data: MaileryWebhookDelivery[]; next_cursor?: string | null; nextCursor?: string | null }>(
      ENDPOINTS.listWebhookDeliveries,
      { auth: "any", params: { id }, query: { limit: options.limit, cursor: options.cursor, status: options.status } },
    ).then((r) => ({ data: r.data, nextCursor: r.next_cursor ?? r.nextCursor ?? null }));
  }

  /** Queue a fresh delivery of the same event as a new delivery row (202). */
  async redeliverWebhook(id: string, deliveryId: string): Promise<MaileryWebhookDelivery> {
    const result = await this.request<{ delivery: MaileryWebhookDelivery }>(ENDPOINTS.redeliverWebhook, { auth: "any", params: { id, deliveryId } });
    return result.delivery;
  }

  // ─── Suppressions ─────────────────────────────────────────────────────────────

  /**
   * The tenant's suppression list, newest first, keyset-paginated. These are
   * the addresses hosted send refuses: hard bounces and complaints recorded
   * from provider feedback. Requires mail_read.
   */
  listSuppressions(options: ListSuppressionsOptions = {}): Promise<MailerySuppressionPage> {
    return this.request<{ data: MailerySuppression[]; next_cursor?: string | null; nextCursor?: string | null }>(
      ENDPOINTS.listSuppressions,
      { auth: "any", query: { limit: options.limit, cursor: options.cursor, reason: options.reason, email: options.email } },
    ).then((r) => ({ data: r.data, nextCursor: r.next_cursor ?? r.nextCursor ?? null }));
  }

  /**
   * Remove one suppression so the address can receive mail again. A
   * `complaint` entry additionally needs `confirm: true` — that recipient
   * reported the previous message as spam. Requires mail_write + entitlement.
   */
  deleteSuppression(id: string, options: DeleteSuppressionOptions = {}): Promise<DeleteSuppressionResult> {
    return this.request(ENDPOINTS.deleteSuppression, { auth: "any", params: { id }, query: { confirm: options.confirm ? "true" : undefined } });
  }

  // ─── Feedback ─────────────────────────────────────────────────────────────────

  /** Submit product feedback (any authenticated tenant actor; never billing-gated). */
  async submitFeedback(input: SubmitFeedbackInput): Promise<MaileryFeedbackEntry> {
    const result = await this.request<{ feedback: MaileryFeedbackEntry }>(ENDPOINTS.submitFeedback, { auth: "any", body: input });
    return result.feedback;
  }

  /** List the caller's own feedback. */
  async listFeedback(options: { limit?: number } = {}): Promise<MaileryFeedbackEntry[]> {
    const result = await this.request<{ data: MaileryFeedbackEntry[] }>(ENDPOINTS.listFeedback, { auth: "any", query: { limit: options.limit } });
    return result.data;
  }

  mcp(input: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    return this.request(ENDPOINTS.mcp, { auth: "any", body: input });
  }

  // ─── Admin / operator ──────────────────────────────────────────────────────

  adminOverview(): Promise<AdminApiResult> {
    return this.request(ENDPOINTS.adminOverview, { auth: "admin" });
  }

  /**
   * Adjust a tenant's credits. Pass `idempotencyKey` (stable across YOUR
   * retries) so a retry after an ambiguous failure replays the original
   * adjustment instead of adjusting twice; the SDK sends none otherwise.
   */
  adminAdjustCredits(input: AdminCreditAdjustmentInput): Promise<AdminCreditAdjustmentResult> {
    const { idempotencyKey, ...body } = input;
    return this.request(ENDPOINTS.adminAdjustCredits, { auth: "admin", body, idempotencyKey });
  }

  /**
   * Report what an audit purge would delete (count, cutoff, scope) and mint
   * the short-lived apply token bound to those values.
   */
  adminAuditPurgePreflight(): Promise<AdminAuditPurgePreflight> {
    return this.request(ENDPOINTS.adminAuditPurgePreflight, { auth: "admin" });
  }

  /**
   * Apply an audit purge. Requires the `apply_token` from
   * adminAuditPurgePreflight(); the server refuses a missing, invalid, expired
   * or already-used token, and `409 audit_purge_preflight_stale` when the rows
   * under the cutoff changed since the preflight (nothing is deleted).
   */
  adminAuditPurge(input: AdminAuditPurgeInput): Promise<AdminAuditPurgeResult> {
    return this.request(ENDPOINTS.adminAuditPurge, { auth: "admin", body: { applyToken: input.applyToken } });
  }

  adminBillingAnomalies(options: AdminBillingAnomaliesOptions = {}): Promise<AdminBillingAnomaliesResult> {
    return this.request(ENDPOINTS.adminBillingAnomaliesPost, { auth: "admin", body: options });
  }

  adminBillingAnomaliesGet(options: AdminBillingAnomaliesOptions = {}): Promise<AdminBillingAnomaliesResult> {
    return this.request(ENDPOINTS.adminBillingAnomaliesGet, {
      auth: "admin",
      query: {
        minutes: options.minutes,
        olderThanMinutes: options.olderThanMinutes,
        limit: options.limit,
        subscriptionLimit: options.subscriptionLimit,
        predeploy: options.predeploy,
      },
    });
  }

  adminFreezeTenant(id: string, input: AdminTenantFreezeInput = {}): Promise<AdminApiResult> {
    return this.request(ENDPOINTS.adminFreezeTenant, { auth: "admin", params: { id }, body: input });
  }

  adminUnfreezeTenant(id: string, input: AdminTenantUnfreezeInput = {}): Promise<AdminApiResult> {
    return this.request(ENDPOINTS.adminUnfreezeTenant, { auth: "admin", params: { id }, body: input });
  }
}
