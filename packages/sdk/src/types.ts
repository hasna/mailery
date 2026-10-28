// Types aligned to THIS server (src/server/app.ts + docs/openapi.json). Where
// older client assumptions disagreed with the server, the server wins. All
// types are structural and forgiving (optional aliases, index-free)
// so a server that adds fields never breaks a compiled client.

export type MaileryAuthVia = "session" | "api_key" | "admin_key" | (string & {});
export type MaileryUserRole = "owner" | "admin" | "member" | "viewer" | (string & {});
export type * from "./purchase-withdrawal-types.js";

export type MaileryApiKeyScope = "full" | "mail_read" | "mail_write" | "billing_read" | "domains:purchase" | (string & {});

// ─── Auth / account ────────────────────────────────────────────────────────

export interface MaileryUser {
  id: string;
  email: string;
  name: string | null;
  tenantId: string;
  role: MaileryUserRole;
  isPlatformAdmin: boolean;
  /** ISO-8601 timestamp of email verification, or null while unverified. */
  emailVerifiedAt: string | null;
}

export interface MaileryTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId?: string | null;
  billingFlag?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Response of POST /auth/signup and POST /auth/login: a session bootstrap. */
export interface MaileryAuthResult {
  token: string;
  user: MaileryUser;
  tenant: MaileryTenant;
}

/** Response of GET /auth/me. `user` is null when the caller authenticated with an API key. */
export interface MaileryMeResponse {
  user: MaileryUser | null;
  tenant: MaileryTenant | null;
  auth: { via: MaileryAuthVia; scopes: string[] };
}

export interface PublishedTerms { version: string; url: string }
export interface TermsAcceptanceInput { acceptedTerms: true; termsVersion: string }
export interface TermsClientReceipt { declaration: "declared" | "undeclared" | "unrecorded"; name: string | null; version: string | null }
export interface TermsAcceptanceReceipt extends PublishedTerms { acceptedAt: string; client: TermsClientReceipt }

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
  inviteCode?: string;
  /** Explicit opt-in only. Never derive from account creation or silently fill. */
  acceptedTerms?: true;
  termsVersion?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface PasswordForgotInput {
  email: string;
}

export interface PasswordResetInput {
  token: string;
  password: string;
}

export interface VerifyEmailInput {
  token: string;
}

export interface VerifyPollInput {
  email: string;
}

/**
 * Result of POST /api/v1/auth/verify/poll. `pending` is returned for every
 * state the caller is not entitled to see; `verified` carries a fresh session
 * token (the same scope set a normal login issues) and only ever arrives when
 * the caller presented a live session for that exact account AND the emailed
 * verification link has been clicked.
 */
export type VerificationPollResult = { status: "pending" } | { status: "verified"; token: string };

export interface AccountExportOptions {
  /** Independent cursor from withdrawal_evidence.next_cursor. */
  withdrawalCursor?: string;
  limit?: number;
  cursor?: string;
}

export interface DeleteAccountInput {
  password: string;
}

// ─── API keys ────────────────────────────────────────────────────────────────

export interface MaileryApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: MaileryApiKeyScope[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateApiKeyInput {
  name?: string;
  /** Defaults server-side to ["full"]; least-privilege scopes are ["mail_read"|"mail_write"|"billing_read"]. */
  scopes?: MaileryApiKeyScope[];
}

/** Response of POST /api-keys — the plaintext `key` is shown exactly once. */
export interface CreateApiKeyResult {
  key: string;
  api_key: {
    id: string;
    name: string;
    prefix: string;
    scopes: MaileryApiKeyScope[];
    createdAt: string;
  };
}

// ─── Billing ───────────────────────────────────────────────────────────────

export interface MaileryPlan {
  /** Monthly received-message allowance; absent on older servers. */
  monthlyReceives?: number;
  name: string;
  amountCents: number;
  monthlyCredits: number;
}

export interface MaileryCreditTransaction {
  id: string;
  delta: number;
  reason: string;
  source: string;
  balanceAfter: number;
  createdAt: string;
}

export interface MailerySubscription {
  id?: string;
  status: string;
  plan?: string;
  monthlyCredits?: number;
  currentPeriodEnd?: string | null;
  [key: string]: unknown;
}

/**
 * Prepaid USD wallet (launch lane L07). Integer cents, separate from the send
 * credit balance: credits meter sends, wallet cents pay the registrar for
 * domain purchases and renewals.
 */
export interface MaileryWallet {
  balance_cents: number;
  currency: string;
  lifetime_topup_cents?: number;
  lifetime_spent_cents?: number;
  /** Suggested top-up amounts in cents (1000, 2500, 5000, 10000). */
  topup_presets_cents?: number[];
  /** Smallest accepted top-up in cents (1000 = $10.00). */
  minimum_topup_cents?: number;
  maximum_topup_cents?: number;
  transactions?: MaileryWalletTransaction[];
  [key: string]: unknown;
}

export type MaileryWalletSource =
  | "topup"
  | "domain_purchase"
  | "domain_renewal"
  | "refund"
  | "adjustment"
  /** Zero-delta marker: refunded funds already spent irreversibly at a registrar. */
  | "loss"
  | (string & {});

export interface MaileryWalletTransaction {
  id: string;
  delta_cents: number;
  balance_after_cents: number;
  reason: string;
  source: MaileryWalletSource;
  metadata?: Record<string, unknown>;
  created_at: string;
  [key: string]: unknown;
}

/** Read the current policy and present its restrictions before asking for this declaration. */
export interface CheckoutCountryInput {
  /** ISO 3166-1 alpha-2 billing or residence country. Required by current servers. */
  country?: string;
  countryBasis?: "billing" | "residence";
  /** Exact version returned by getCheckoutCountryPolicy(), after presenting the list. */
  /** Exact original version. Never refresh it on a retry. Omit all country
   * fields only for an exact pre-country replay; absent claims fail closed. */
  countryPolicyVersion?: string;
}
export interface CheckoutCountryPolicy {
  version: string;
  restricted_countries: string[];
  declaration_bases: Array<"billing" | "residence">;
  disclosure_path: string;
  pricing_path: string;
}

export interface WalletTopupInput extends CheckoutCountryInput {
  /** USD cents to add. Minimum 1000 ($10.00). */
  amountCents: number;
  /** Caller-supplied idempotency key sent as Idempotency-Key (required). */
  idempotencyKey: string;
}

export interface WalletTopupResult {
  url: string;
  amount_cents: number;
  currency: string;
  [key: string]: unknown;
}

export interface MaileryInboundUsage {
  metering_active: boolean;
  month: string;
  monthly_included: number;
  received: number;
  remaining_included: number;
  charged_credits: number;
  overage_credit_cost: number;
  warning_percent: number;
  status: "within_allowance" | "near_allowance" | "overage" | "paused";
  resets_at: string;
}

/** Response of GET /billing/overview. */
export interface MaileryBillingOverview {
  inbound_usage?: MaileryInboundUsage;
  balance: number;
  /** Prepaid wallet (launch lane L07); absent on servers predating it. */
  wallet?: MaileryWallet;
  plans: Record<string, MaileryPlan>;
  credit_packs: Record<string, number>;
  subscriptions: MailerySubscription[];
  ledger: MaileryCreditTransaction[];
}

/** Derived usage view (balance + recent ledger). The server has no dedicated
 *  /usage route; `getUsage()` projects it from GET /billing/overview. */
export interface MaileryUsage {
  inbound_usage?: MaileryInboundUsage;
  balance: number;
  ledger: MaileryCreditTransaction[];
}

export type CheckoutKind = "subscription" | "credit_pack";

export interface CreateCheckoutInput extends CheckoutCountryInput {
  kind?: CheckoutKind;
  /** Paid subscription plan key: "pro" or "scale" (omit to default to "pro"). */
  plan?: string;
  /** Credit-pack size for kind:"credit_pack". */
  credits?: number;
  /** Persist and reuse this key for retries; a fresh key means a deliberate new purchase. */
  idempotencyKey?: string;
}

export interface BillingPortalResult {
  url: string;
  [key: string]: unknown;
}

export interface WaitForEntitlementOptions {
  timeoutMs?: number;
  /** Poll interval; defaults to 2000ms. */
  intervalMs?: number;
  /** Abort signal to cancel the poll loop early. */
  signal?: AbortSignal;
}

// ─── Mailboxes ────────────────────────────────────────────────────────────────

export type MaileryMailboxProvider = "hosted" | "manual" | "sandbox" | (string & {});
export type MaileryMailboxStatus = "active" | "paused" | "error" | (string & {});

/**
 * Lifecycle status of a message row.
 *
 * `test_sent` is the honest non-terminal state of a hosted send issued while
 * the server runs with MAILERY_MAIL_MODE != "live": the send was accepted and
 * recorded, but NO SES dispatch ran, so it must never be read as delivered.
 */
export type MaileryMessageStatus = "received" | "queued" | "sent" | "parsed" | "failed" | "test_sent" | (string & {});

export interface MaileryMailbox {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  provider: MaileryMailboxProvider;
  status: MaileryMailboxStatus;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/**
 * Body of POST /mailboxes. The provider is normally omitted: a mailbox created
 * without one is a HOSTED mailbox on the managed mail plane, which is what
 * hosted send requires. Pass `manual` only for an aggregation-only mailbox that
 * will never send.
 */
export interface CreateMailboxInput {
  email: string;
  name?: string;
  provider?: MaileryMailboxProvider;
}

/** Options for DELETE /mailboxes/:id. */
export interface DeleteMailboxOptions {
  /**
   * Delete the mailbox together with the messages it holds. Without it a
   * non-empty mailbox is refused (409 `mailbox_not_empty`) so mail is never
   * destroyed by accident.
   */
  purge?: boolean;
}

export interface DeleteMailboxResult {
  ok: boolean;
  id: string;
  email: string;
  purged_messages: number;
}

// ─── Mail ────────────────────────────────────────────────────────────────────

export type MaileryMessageDirection = "inbound" | "outbound";

export interface MaileryAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum?: string | null;
  downloadUrl?: string;
  download_url?: string;
  [key: string]: unknown;
}

export interface MaileryMessage {
  id: string;
  tenantId: string;
  mailboxId: string;
  direction: MaileryMessageDirection;
  status: MaileryMessageStatus;
  subject: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  receivedAt: string | null;
  sentAt: string | null;
  textBody: string | null;
  htmlBody: string | null;
  cleanMarkdown: string | null;
  summary: string | null;
  importanceScore: number;
  isRead: boolean;
  isImportant: boolean;
  isSpam: boolean;
  isTrash: boolean;
  isArchived: boolean;
  isStarred?: boolean;
  is_starred?: boolean;
  threadId?: string | null;
  thread_id?: string | null;
  snippet?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface MaileryMessageWithAttachments extends MaileryMessage {
  attachments: MaileryAttachment[];
}

/** A list item may be a live message or a deletion tombstone. */
export interface MaileryMessageTombstone {
  id: string;
  deleted?: boolean;
  tombstone?: boolean;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export type MaileryMessageListItem = MaileryMessage | MaileryMessageTombstone;

export interface MaileryMessagePage {
  data: MaileryMessageListItem[];
  nextCursor: string | null;
}

export interface ListInboxOptions {
  group?: string;
  q?: string;
  limit?: number;
  cursor?: string;
  mailboxId?: string;
  direction?: MaileryMessageDirection;
  threadId?: string;
}

export interface MaileryLabel {
  id?: string;
  name: string;
  count?: number;
  unread?: number;
  [key: string]: unknown;
}

export interface MessageGroupsOptions {
  mailboxId?: string;
}

export interface MessageChangesOptions {
  since?: string;
  updatedSince?: string;
  cursor?: string;
  limit?: number;
  mailboxId?: string;
}

export interface MaileryMessageChangesPage extends MaileryMessagePage {
  serverTime?: string;
  state?: string;
}

export interface MessageTombstonesOptions {
  since?: string;
  limit?: number;
  mailboxId?: string;
}

export interface BulkMessageInput {
  action: string;
  ids?: string[];
  mailboxId?: string;
  folder?: string;
  group?: string;
  label?: string;
  cursor?: string;
}

export interface BulkMessageResult {
  ok: boolean;
  affected?: number;
  hasMore?: boolean;
  has_more?: boolean;
  nextCursor?: string | null;
  next_cursor?: string | null;
  [key: string]: unknown;
}

export interface MessagePatchInput {
  isRead?: boolean;
  isImportant?: boolean;
  isArchived?: boolean;
  isSpam?: boolean;
  isTrash?: boolean;
  isStarred?: boolean;
}

export type UploadMessageInput = Record<string, unknown>;

export interface LabelMutationResult {
  ok: boolean;
  labels: MaileryLabel[];
  label_records?: MaileryLabel[];
  label_names?: string[];
}

export type MaileryDigestWindow = "today" | "yesterday" | "last_7_days" | "month";

export interface MaileryDigest {
  id?: string;
  window?: MaileryDigestWindow | string;
  summary?: string;
  [key: string]: unknown;
}

/**
 * One attachment on a send. Provide EITHER `content` (base64 of the file) or
 * `attachmentId` (an attachment already stored on one of your messages — the
 * cheap way to forward something you received). At most 10 attachments and
 * 10 MiB decoded in total per message.
 */
export interface SendAttachmentInput {
  /** Display filename. Defaults to "attachment". */
  filename?: string;
  /** MIME type, e.g. "application/pdf". Defaults to application/octet-stream. */
  contentType?: string;
  /** Base64-encoded file content. Mutually exclusive with attachmentId. */
  content?: string;
  /** Id of an attachment already stored on this tenant. Mutually exclusive with content. */
  attachmentId?: string;
}

/** Body of POST /messages/send. `mailboxId` is required; the sender domain must be outbound-ready. */
export interface SendInput {
  mailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string[];
  /**
   * Parent Message-ID to reply into a thread. Angle brackets optional. The
   * server sets In-Reply-To from this and extends References with it, so the
   * reply threads in the recipient's client.
   */
  inReplyTo?: string;
  /** The parent's References ancestry, oldest first (or its raw header value). */
  references?: string[] | string;
  /**
   * Custom headers. Allowlisted: any `X-…` header (except provider/Mailery
   * reserved prefixes) plus a small set of standard filing headers such as
   * List-Unsubscribe. At most 10.
   */
  headers?: Record<string, string>;
  attachments?: SendAttachmentInput[];
  /**
   * YOUR stable key for this send, sent as `Idempotency-Key`. Retrying with
   * the same key returns the original result (`replayed: true`) instead of
   * sending — and charging — twice. The SDK never invents one: a key it made
   * up per call would protect nothing.
   */
  idempotencyKey?: string;
}

export interface SendResult extends MaileryMessageWithAttachments {
  /** SES message id. Null in non-live mode: no dispatch ran, so there is no provider reference to return. */
  provider_message_id?: string | null;
  /** SES message id. Null in non-live mode: no dispatch ran, so there is no provider reference to return. */
  providerMessageId?: string | null;
  mode?: string;
  /** True when this response replayed an earlier send bound to the same idempotency key. */
  replayed?: boolean;
  /** The idempotency key this result is bound to, when one was supplied. */
  idempotency_key?: string | null;
}

/** One message in a batch send: a send body plus its own idempotency key. */
export interface SendBatchItem extends SendInput {}

export interface SendBatchItemResult {
  index: number;
  status: "sent" | "failed";
  idempotency_key: string | null;
  /** True when this item replayed a result already bound to its idempotency key. */
  replayed: boolean;
  /**
   * Whether THIS batch pushed the message to the provider. False means the
   * failure is on the safe side of the dispatch boundary and its meter unit
   * was returned; true after a failure means the outcome is ambiguous and the
   * unit stays consumed.
   */
  dispatched?: boolean;
  message?: SendResult;
  provider_message_id?: string | null;
  mode?: string;
  error?: { code: string; message: string; details?: unknown };
}

export interface SendBatchMetering {
  /** Which meter the batch drew from: credits, the free monthly allowance, or none (non-live mode). */
  unit: "credits" | "monthly_allowance" | "none";
  /** Messages the batch drew for, up front, in one transaction. */
  messages: number;
  credits_charged: number;
  /** Messages whose unit was returned (failed before their dispatch, or replayed). */
  refunded: number;
  /** Messages whose unit stays consumed (sent, or ambiguous after dispatch). */
  retained: number;
}

export interface SendBatchResult {
  count: number;
  sent: number;
  failed: number;
  results: SendBatchItemResult[];
  metering: SendBatchMetering;
}

/** One row of a message's delivery timeline. */
export interface MaileryMessageEvent {
  id: string;
  message_id: string;
  /** sent | delivered | bounced | complained | rejected. */
  type: string;
  provider_message_id: string | null;
  recipient: string | null;
  recipients: string[];
  reason_code: string | null;
  occurred_at: string;
  created_at: string;
  [key: string]: unknown;
}

export interface MaileryMessageEvents {
  data: MaileryMessageEvent[];
  message_id: string;
  /** The message's current delivery status. */
  status: string;
  sent_at: string | null;
  /** Provider timestamp of the newest event, or null when none has arrived. */
  last_event_at: string | null;
  [key: string]: unknown;
}

// ─── Domains ──────────────────────────────────────────────────────────────────

export interface MaileryDomainPurchaseQuote {
  token: string;
  domain: string;
  quoted_price_cents: number;
  currency: string;
  expires_at: string;
  idempotency_key_required: true;
}

export interface MaileryDomainAvailability {
  domain: string;
  available: boolean;
  premium?: boolean;
  purchase_quote?: MaileryDomainPurchaseQuote;
  /** Status skipped registrar availability for a connected domain; available=false is not a registrar response. */
  check_status?: "not_requested";
  [key: string]: unknown;
}

export interface MaileryDomainStatus {
  domain?: string;
  availability?: MaileryDomainAvailability;
  domain_record?: unknown;
  [key: string]: unknown;
}

export interface MaileryTenantDomain {
  id: string;
  domain: string;
  warmup?: MaileryDomainWarmupStatus;
  [key: string]: unknown;
}

/** Durable UTC-day recipient accounting, including unresolved dispatches. */
export interface MaileryDomainWarmupStatus {
  status: "warming" | "ready" | "limited" | "paused";
  day: string;
  ramp_day: number;
  total_ramp_days: number;
  daily_recipient_limit: number;
  reserved_recipients: number;
  remaining_recipients: number;
  resolved_recipients: number;
  bounce_rate: number | null;
  complaint_rate: number | null;
  resets_at: string;
}

export interface PurchaseDomainInput {
  /** The domain to buy and provision (e.g. "acme-support.com"). */
  domain: string;
  /** Signed quote token returned by GET /api/v1/domains/availability. */
  quoteToken: string;
  /** Maximum all-in price authorized by the caller, in minor units. */
  maxPriceCents: number;
  /** Three-letter currency expected by the caller. */
  currency: string;
  /** Caller-supplied idempotency key sent as Idempotency-Key. */
  idempotencyKey: string;
  /** Opt in to domain auto-renew. Defaults to false server-side (pivot P4). */
  autoRenew?: boolean;
}

/** Renewal tracking for a domain Mailery registered (launch lane L07). */
export interface MaileryDomainRenewal {
  id: string;
  tenant_domain_id: string;
  domain: string;
  expires_at: string | null;
  days_until_expiry: number | null;
  auto_renew: boolean;
  registration_status?: string | null;
  last_checked_at?: string | null;
  last_renewed_at?: string | null;
  last_renewal_error?: string | null;
  notices_sent?: Record<string, string>;
  [key: string]: unknown;
}

export interface RenewDomainInput {
  /** Tenant domain id (see listDomains / getDomain). */
  id: string;
  /** Caller-supplied idempotency key sent as Idempotency-Key (required). */
  idempotencyKey: string;
  /** Also set the auto-renew opt-in, applied only after the charge succeeds. */
  autoRenew?: boolean;
}

export interface MaileryDomainRenewResult {
  domain: string;
  tenant_domain_id?: string;
  status: string;
  operation_id?: string;
  expires_at?: string | null;
  auto_renew?: boolean;
  renewal?: MaileryDomainRenewal | null;
  billing?: {
    quoted_price_cents?: number;
    currency?: string;
    wallet_debit_cents?: number;
    wallet_balance_cents?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreateDomainInput {
  domain: string;
  provider?: string;
  mailboxId?: string;
  catchAll?: boolean;
}

interface SetupDomainBaseInput {
  domain: string;
  provider?: string;
  address?: string;
  mailboxId?: string;
  catchAll?: boolean;
  inbound?: boolean;
  mxMigrationConsent?: boolean;
  dnsAuthorityConsent?: boolean;
  route53DnsConsent?: boolean;
  applyDns?: boolean;
  autoCreateZone?: boolean;
  dnsDelegationConsent?: boolean;
  delegateToRoute53?: boolean;
  autoUpdateNameservers?: boolean;
  autoRenew?: boolean;
}

/** Connecting an already-owned domain does not spend and needs no idempotency key. */
export type ConnectDomainInput = SetupDomainBaseInput & {
  buy?: false;
  purchase?: false;
  idempotencyKey?: never;
};

/** Paid setup must carry the signed quote and a caller-stable idempotency key. */
export type PaidSetupDomainInput = SetupDomainBaseInput & {
  quoteToken: string;
  maxPriceCents: number;
  currency: string;
  idempotencyKey: string;
} & ({ buy: true; purchase?: boolean } | { purchase: true; buy?: boolean });

export type SetupDomainInput = ConnectDomainInput | PaidSetupDomainInput;

export type DomainActionResult = Record<string, unknown>;

export interface ListDomainEventsOptions {
  limit?: number;
}

export type DmarcReportInput = Record<string, unknown>;
export type DmarcPolicyInput = Record<string, unknown>;

/**
 * Result of the quote-confirm purchase → provision lifecycle (POST
 * /api/v1/domains/purchase). Callers must supply a quote token from
 * /api/v1/domains/availability plus an idempotency key. Re-calling the same
 * domain resumes from the last completed step (`resumed: true`) and never
 * double-charges.
 */
export interface MaileryDomainPurchaseResult {
  domain?: string;
  /** True once the domain reaches ownershipStatus "ready" (send-ready identity). */
  ownership_ready?: boolean;
  /** True once outbound sending is enabled (status active + send_enabled). */
  outbound_enabled?: boolean;
  /** True when this call resumed an in-flight purchase rather than starting one. */
  resumed?: boolean;
  /** Present when a non-fatal verification step failed but the row still advanced. */
  verify_error?: string;
  /** Present when billing metadata is returned by the service. */
  billing?: Record<string, unknown>;
  lifecycle_steps?: { step: string; status: string }[];
  [key: string]: unknown;
}

// ─── Suppressions (send hygiene) ──────────────────────────────────────────────

/**
 * Why an address is suppressed. `bounce` and `complaint` are written by the
 * provider feedback path; `manual` is an operator/tenant entry.
 */
export type MailerySuppressionReason = "bounce" | "complaint" | "manual" | (string & {});

export interface MailerySuppression {
  id: string;
  email: string;
  reason: MailerySuppressionReason;
  source: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface ListSuppressionsOptions {
  limit?: number;
  cursor?: string;
  reason?: MailerySuppressionReason;
  email?: string;
}

export interface MailerySuppressionPage {
  data: MailerySuppression[];
  nextCursor: string | null;
}

export interface DeleteSuppressionOptions {
  /**
   * Required to remove a `complaint` entry: the recipient reported the last
   * message as spam, so re-opening delivery is a reputation decision the API
   * refuses to make implicitly (409 `complaint_removal_requires_confirmation`).
   */
  confirm?: boolean;
}

export interface DeleteSuppressionResult {
  ok: boolean;
  id: string;
  email: string;
  reason: MailerySuppressionReason;
}

// ─── Feedback ─────────────────────────────────────────────────────────────────

export type FeedbackKind = "bug" | "idea" | "question" | "praise" | "other" | (string & {});
export type FeedbackSeverity = "low" | "medium" | "high" | "critical" | (string & {});

export interface SubmitFeedbackInput {
  message: string;
  kind?: FeedbackKind;
  severity?: FeedbackSeverity;
  /** Absolute http(s) URL; a relative value is rejected by the server with 400. */
  url?: string;
  tags?: string[];
  context?: { route?: string; url?: string } | null;
  /** Optional `data:image/png;base64,...` screenshot; best-effort, never blocks the text. */
  screenshot?: string;
}

export interface MaileryFeedbackEntry {
  id: string;
  kind: FeedbackKind;
  severity: FeedbackSeverity | null;
  message: string;
  status: string;
  url: string | null;
  createdAt: string;
  context: unknown;
}

// ─── Admin / operator ───────────────────────────────────────────────────────

export interface AdminCreditAdjustmentInput {
  tenantId: string;
  amount: number;
  reason: string;
  /**
   * Caller-supplied Idempotency-Key (8-200 chars), stable across YOUR retries.
   * A repeat with the same key replays the original adjustment instead of
   * adjusting twice; the same key with a different body is
   * `409 idempotency_key_conflict`. Sent as the Idempotency-Key header.
   */
  idempotencyKey?: string;
}

export interface AdminCreditAdjustmentResult {
  balance: number;
  tenantId: string;
  amount: number;
  reason: string;
  /** true when the response was replayed from an earlier request with the same Idempotency-Key. */
  replayed: boolean;
}

/** Scope of an audit purge: fixed today to every tenant's admin_audit rows past the retention window. */
export interface AdminAuditPurgeScope {
  table: "admin_audit";
  tenants: "all";
  retention_months: number;
}

/** GET /api/v1/admin/audit/purge/preflight */
export interface AdminAuditPurgePreflight {
  /** Rows the purge would delete (strictly older than `cutoff`). */
  count: number;
  /** ISO timestamp the purge would use as its cutoff. */
  cutoff: string;
  retention_months: number;
  scope: AdminAuditPurgeScope;
  /** Short-lived token bound to count/cutoff/scope/actor; required by adminAuditPurge. */
  apply_token: string;
  apply_token_expires_at: string;
  apply_token_ttl_seconds: number;
}

export interface AdminAuditPurgeInput {
  /** `apply_token` from adminAuditPurgePreflight(). */
  applyToken: string;
}

/** POST /api/v1/admin/audit/purge */
export interface AdminAuditPurgeResult {
  removed: number;
  retention_months: number;
  cutoff: string;
  scope: AdminAuditPurgeScope;
  preflight_count: number;
  apply_token_id: string;
}

// Older servers may omit coverage. Absence never establishes reconciliation.
export interface AdminBillingAnomaliesResult extends AdminApiResult {
  eventReconciliation?: { checked: number; complete: boolean };
  foreignEventReconciliation?: { performed: boolean; checked: number; complete: boolean };
}

export interface AdminBillingAnomaliesOptions {
  minutes?: number;
  olderThanMinutes?: number;
  limit?: number;
  subscriptionLimit?: number;
  predeploy?: boolean;
}

export interface AdminTenantFreezeInput {
  reason?: string;
}

export interface AdminTenantUnfreezeInput {
  clearBillingFlag?: boolean;
}

export type AdminApiResult = Record<string, unknown>;

// ─── Webhooks (customer event delivery) ──────────────────────────────────────

export type MaileryWebhookEventType =
  | "email.received"
  | "email.sent"
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.rejected"
  | "domain.ready"
  | "domain.blocked"
  | "billing.suspended"
  | "webhook.test"
  | (string & {});

export type MaileryWebhookEndpointStatus = "active" | "disabled" | "dead" | (string & {});
export type MaileryWebhookDeliveryStatus = "pending" | "delivered" | "failed" | "dead" | (string & {});

/** One registered destination. The signing secret is never returned here — only its display prefix. */
export interface MaileryWebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  /** Event filter: exact types or group wildcards ("email.*"); null means every event. */
  events: string[] | null;
  /** `dead` = taken offline by the circuit breaker; PATCH status "active" re-enables it. */
  status: MaileryWebhookEndpointStatus;
  secret_prefix: string;
  failure_count: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWebhookInput {
  /** Absolute https URL on a public host (the SSRF guard rejects private/loopback/metadata destinations). */
  url: string;
  description?: string;
  /** Event filter; omit for every event. */
  events?: MaileryWebhookEventType[];
  /**
   * Caller-stable key sent as `Idempotency-Key`. Omit for a single-shot create
   * (no client retries); supply one — stable across your own retries — to have
   * a repeat replay the original endpoint and secret instead of registering a
   * second endpoint.
   */
  idempotencyKey?: string;
}

export interface UpdateWebhookInput {
  url?: string;
  description?: string | null;
  events?: MaileryWebhookEventType[] | null;
  /** `active` re-enables a disabled or breaker-tripped endpoint (resets its failure count). */
  status?: "active" | "disabled";
}

/** Response of POST /webhooks and POST /webhooks/{id}/rotate-secret — the plaintext `secret` is shown exactly once. */
export interface MaileryWebhookSecretResult {
  endpoint: MaileryWebhookEndpoint;
  secret: string;
}

export interface RotateWebhookSecretOptions {
  idempotencyKey?: string;
}

export interface MaileryWebhookDelivery {
  id: string;
  endpoint_id: string;
  /** Shared by every delivery (and redelivery) of the same event; dedupe on it. */
  event_id: string;
  event_type: MaileryWebhookEventType;
  status: MaileryWebhookDeliveryStatus;
  attempt: number;
  response_status: number | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface ListWebhookDeliveriesOptions {
  limit?: number;
  cursor?: string;
  status?: MaileryWebhookDeliveryStatus;
}

export interface MaileryWebhookDeliveryPage {
  data: MaileryWebhookDelivery[];
  nextCursor: string | null;
}

/** Response of POST /webhooks/{id}/test (202). */
export interface MaileryWebhookTestResult {
  event_id: string;
  delivery: MaileryWebhookDelivery;
}

/** The JSON body a webhook receiver gets; verify it with `verifyWebhookSignature` before trusting it. */
export interface MaileryWebhookEvent<TData = Record<string, unknown>> {
  id: string;
  type: MaileryWebhookEventType;
  created_at: string;
  tenant_id: string;
  data: TData;
}

/** Each value must come from the person's separate explicit choice. Never default. */
export interface CheckoutConsentInput {
  language: "en" | "ro";
  requestImmediatePerformance: true;
  acknowledgeWithdrawal: true;
  immediateVersion: string;
  withdrawalVersion: string;
  idempotencyKey: string;
}
export interface CheckoutOrderResult {
  orderId: string;
  intent: { kind: "subscription"; plan: string } | { kind: "credit_pack"; credits: number };
  amountCents: number;
  currency: string;
  country: { country: string; countryBasis: "billing" | "residence"; countryPolicyVersion: string };
  termsVersion: string;
  /** Exact purchase-time source Markdown, content-addressed by SHA-256. */
  refundPolicy: { version: string; text: string };
  consent: Record<"en" | "ro", { language: "en" | "ro"; immediate: { text: string; version: string }; withdrawal: { text: string; version: string } }>;
}
