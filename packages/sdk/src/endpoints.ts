// The single source of truth for every route the SDK talks to. Client methods
// build their URLs from these entries, and the OpenAPI drift test asserts that
// every `stable` entry exists in docs/openapi.json (freezing /api/v1) and that
// every `pending` entry is still ABSENT (so the day the server ships it, the
// test fails and reminds us to promote it). Path templates use the OpenAPI
// `{param}` style so they compare directly against the spec's `paths` keys.

export type EndpointState =
  // Part of the frozen /api/v1 contract: MUST exist in docs/openapi.json.
  | "stable"
  // Coded against a route the server does not expose yet (see notes in the
  // README / task handoff). MUST be absent from docs/openapi.json for now.
  | "pending"
  // Service-info root, deliberately not an enumerated operation in the spec.
  | "unversioned";

export interface EndpointSpec {
  readonly id: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly state: EndpointState;
}

export const ENDPOINTS = {
  health: { id: "health", method: "GET", path: "/api/v1", state: "unversioned" },

  signup: { id: "signup", method: "POST", path: "/api/v1/auth/signup", state: "stable" },
  login: { id: "login", method: "POST", path: "/api/v1/auth/login", state: "stable" },
  logout: { id: "logout", method: "POST", path: "/api/v1/auth/logout", state: "stable" },
  authProviders: { id: "authProviders", method: "GET", path: "/api/v1/auth/providers", state: "stable" },
  forgotPassword: { id: "forgotPassword", method: "POST", path: "/api/v1/auth/password/forgot", state: "stable" },
  resetPassword: { id: "resetPassword", method: "POST", path: "/api/v1/auth/password/reset", state: "stable" },
  verifyEmail: { id: "verifyEmail", method: "POST", path: "/api/v1/auth/verify", state: "stable" },
  // Machine-bootstrap poll: answers `pending` until the emailed verification
  // link has been clicked, then issues a login-equivalent session to a caller
  // presenting a live session for that account. Frozen in openapi.json.
  verifyPoll: { id: "verifyPoll", method: "POST", path: "/api/v1/auth/verify/poll", state: "stable" },
  me: { id: "me", method: "GET", path: "/api/v1/auth/me", state: "stable" },
  // Re-send the email-verification link (interactive user session). Returns
  // verified:true without sending when already verified. Frozen in openapi.json.
  resendVerification: { id: "resendVerification", method: "POST", path: "/api/v1/auth/verify/resend", state: "stable" },

  accountExport: { id: "accountExport", method: "GET", path: "/api/v1/account/export", state: "stable" },
  deleteAccount: { id: "deleteAccount", method: "DELETE", path: "/api/v1/account", state: "stable" },

  listKeys: { id: "listKeys", method: "GET", path: "/api/v1/api-keys", state: "stable" },
  createKey: { id: "createKey", method: "POST", path: "/api/v1/api-keys", state: "stable" },
  revokeKey: { id: "revokeKey", method: "POST", path: "/api/v1/api-keys/{id}/revoke", state: "stable" },
  // Break-glass "revoke every key" (pivot D-3). Live as of the P4 containment
  // merge: accepts a session bearer token OR email+password in the body, so it
  // works even when every key is compromised. Frozen in docs/openapi.json.
  revokeAllKeys: { id: "revokeAllKeys", method: "POST", path: "/api/v1/keys/revoke-all", state: "stable" },

  createCheckout: { id: "createCheckout", method: "POST", path: "/api/v1/billing/checkout", state: "stable" },
  billingOverview: { id: "billingOverview", method: "GET", path: "/api/v1/billing/overview", state: "stable" },
  billingPortal: { id: "billingPortal", method: "POST", path: "/api/v1/billing/portal", state: "stable" },
  // Prepaid wallet (launch lane L07): the USD balance domain purchases and
  // renewals are charged against, separate from send credits. Frozen in
  // docs/openapi.json.
  getWallet: { id: "getWallet", method: "GET", path: "/api/v1/billing/wallet", state: "stable" },
  topUpWallet: { id: "topUpWallet", method: "POST", path: "/api/v1/billing/wallet/topup", state: "stable" },

  listMailboxes: { id: "listMailboxes", method: "GET", path: "/api/v1/mailboxes", state: "stable" },
  createMailbox: { id: "createMailbox", method: "POST", path: "/api/v1/mailboxes", state: "stable" },
  deleteMailbox: { id: "deleteMailbox", method: "DELETE", path: "/api/v1/mailboxes/{id}", state: "stable" },

  send: { id: "send", method: "POST", path: "/api/v1/messages/send", state: "stable" },
  // Batch hosted send (launch lane L04): up to 100 messages, each with its own
  // idempotency key and its own result, metered in one transaction.
  sendBatch: { id: "sendBatch", method: "POST", path: "/api/v1/messages/send/batch", state: "stable" },
  listInbox: { id: "listInbox", method: "GET", path: "/api/v1/messages", state: "stable" },
  uploadMessage: { id: "uploadMessage", method: "POST", path: "/api/v1/messages", state: "stable" },
  listLabels: { id: "listLabels", method: "GET", path: "/api/v1/labels", state: "stable" },
  messageGroups: { id: "messageGroups", method: "GET", path: "/api/v1/messages/groups", state: "stable" },
  messageChanges: { id: "messageChanges", method: "GET", path: "/api/v1/messages/changes", state: "stable" },
  bulkMessages: { id: "bulkMessages", method: "POST", path: "/api/v1/messages/bulk", state: "stable" },
  messageTombstones: { id: "messageTombstones", method: "GET", path: "/api/v1/messages/tombstones", state: "stable" },
  getMessage: { id: "getMessage", method: "GET", path: "/api/v1/messages/{id}", state: "stable" },
  updateMessage: { id: "updateMessage", method: "PATCH", path: "/api/v1/messages/{id}", state: "stable" },
  deleteMessage: { id: "deleteMessage", method: "DELETE", path: "/api/v1/messages/{id}", state: "stable" },
  addMessageLabel: { id: "addMessageLabel", method: "POST", path: "/api/v1/messages/{id}/labels", state: "stable" },
  removeMessageLabel: { id: "removeMessageLabel", method: "DELETE", path: "/api/v1/messages/{id}/labels/{label}", state: "stable" },
  parseMessage: { id: "parseMessage", method: "POST", path: "/api/v1/messages/{id}/parse", state: "stable" },
  listMessageAttachments: { id: "listMessageAttachments", method: "GET", path: "/api/v1/messages/{id}/attachments", state: "stable" },
  // Per-message delivery timeline (launch lane L04): the pull counterpart of
  // the email.* customer webhooks.
  listMessageEvents: { id: "listMessageEvents", method: "GET", path: "/api/v1/messages/{id}/events", state: "stable" },
  downloadAttachment: { id: "downloadAttachment", method: "GET", path: "/api/v1/attachments/{id}/download", state: "stable" },

  listDigests: { id: "listDigests", method: "GET", path: "/api/v1/digests", state: "stable" },
  generateDigest: { id: "generateDigest", method: "POST", path: "/api/v1/digests/generate", state: "stable" },

  searchDomains: { id: "searchDomains", method: "GET", path: "/api/v1/domains/availability", state: "stable" },
  listDomains: { id: "listDomains", method: "GET", path: "/api/v1/domains", state: "stable" },
  createDomain: { id: "createDomain", method: "POST", path: "/api/v1/domains", state: "stable" },
  setupDomain: { id: "setupDomain", method: "POST", path: "/api/v1/domains/setup", state: "stable" },
  getDomainStatus: { id: "getDomainStatus", method: "GET", path: "/api/v1/domains/status", state: "stable" },
  // Domain purchase (pivot phase P5) is live as of the billing-containment (P4)
  // merge: one-command, idempotent, resumable purchase → provision to
  // ownership-ready. Requires the `domains:purchase` scope + entitlement.
  // Frozen in docs/openapi.json.
  purchaseDomain: { id: "purchaseDomain", method: "POST", path: "/api/v1/domains/purchase", state: "stable" },
  getDomain: { id: "getDomain", method: "GET", path: "/api/v1/domains/{id}", state: "stable" },
  deleteDomain: { id: "deleteDomain", method: "DELETE", path: "/api/v1/domains/{id}", state: "stable" },
  listDomainDns: { id: "listDomainDns", method: "GET", path: "/api/v1/domains/{id}/dns", state: "stable" },
  listDomainEvents: { id: "listDomainEvents", method: "GET", path: "/api/v1/domains/{id}/events", state: "stable" },
  recordDmarcReport: { id: "recordDmarcReport", method: "POST", path: "/api/v1/domains/{id}/dmarc/report", state: "stable" },
  updateDmarcPolicy: { id: "updateDmarcPolicy", method: "POST", path: "/api/v1/domains/{id}/dmarc/policy", state: "stable" },
  verifyDomain: { id: "verifyDomain", method: "POST", path: "/api/v1/domains/{id}/verify", state: "stable" },
  enableDomainInbound: { id: "enableDomainInbound", method: "POST", path: "/api/v1/domains/{id}/enable-inbound", state: "stable" },
  enableDomainOutbound: { id: "enableDomainOutbound", method: "POST", path: "/api/v1/domains/{id}/enable-outbound", state: "stable" },
  disableDomain: { id: "disableDomain", method: "POST", path: "/api/v1/domains/{id}/disable", state: "stable" },
  // Renewals (launch lane L07): renew charges the prepaid wallet; auto-renew is
  // an opt-in that proceeds only when the balance covers the quote.
  renewDomain: { id: "renewDomain", method: "POST", path: "/api/v1/domains/{id}/renew", state: "stable" },
  setDomainAutoRenew: { id: "setDomainAutoRenew", method: "POST", path: "/api/v1/domains/{id}/auto-renew", state: "stable" },

  // Customer webhooks (launch lane L05): registered destinations receive
  // signed event POSTs (Mailery-Signature v1, HMAC-SHA256). Frozen in
  // docs/openapi.json.
  listWebhooks: { id: "listWebhooks", method: "GET", path: "/api/v1/webhooks", state: "stable" },
  createWebhook: { id: "createWebhook", method: "POST", path: "/api/v1/webhooks", state: "stable" },
  getWebhook: { id: "getWebhook", method: "GET", path: "/api/v1/webhooks/{id}", state: "stable" },
  updateWebhook: { id: "updateWebhook", method: "PATCH", path: "/api/v1/webhooks/{id}", state: "stable" },
  deleteWebhook: { id: "deleteWebhook", method: "DELETE", path: "/api/v1/webhooks/{id}", state: "stable" },
  rotateWebhookSecret: { id: "rotateWebhookSecret", method: "POST", path: "/api/v1/webhooks/{id}/rotate-secret", state: "stable" },
  testWebhook: { id: "testWebhook", method: "POST", path: "/api/v1/webhooks/{id}/test", state: "stable" },
  listWebhookDeliveries: { id: "listWebhookDeliveries", method: "GET", path: "/api/v1/webhooks/{id}/deliveries", state: "stable" },
  redeliverWebhook: { id: "redeliverWebhook", method: "POST", path: "/api/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver", state: "stable" },

  // Suppression list (launch lane L06): the addresses the send path refuses
  // because SES reported a hard bounce or a complaint for them.
  listSuppressions: { id: "listSuppressions", method: "GET", path: "/api/v1/suppressions", state: "stable" },
  deleteSuppression: { id: "deleteSuppression", method: "DELETE", path: "/api/v1/suppressions/{id}", state: "stable" },

  submitFeedback: { id: "submitFeedback", method: "POST", path: "/api/v1/feedback", state: "stable" },
  mcp: { id: "mcp", method: "POST", path: "/api/v1/mcp", state: "stable" },
  listFeedback: { id: "listFeedback", method: "GET", path: "/api/v1/feedback", state: "stable" },

  adminOverview: { id: "adminOverview", method: "GET", path: "/api/v1/admin/overview", state: "stable" },
  adminAdjustCredits: { id: "adminAdjustCredits", method: "POST", path: "/api/v1/admin/credits/adjust", state: "stable" },
  adminAuditPurgePreflight: { id: "adminAuditPurgePreflight", method: "GET", path: "/api/v1/admin/audit/purge/preflight", state: "stable" },
  adminAuditPurge: { id: "adminAuditPurge", method: "POST", path: "/api/v1/admin/audit/purge", state: "stable" },
  adminBillingAnomaliesGet: { id: "adminBillingAnomaliesGet", method: "GET", path: "/api/v1/admin/billing/anomalies", state: "stable" },
  adminBillingAnomaliesPost: { id: "adminBillingAnomaliesPost", method: "POST", path: "/api/v1/admin/billing/anomalies", state: "stable" },
  adminFreezeTenant: { id: "adminFreezeTenant", method: "POST", path: "/api/v1/admin/tenants/{id}/freeze", state: "stable" },
  adminUnfreezeTenant: { id: "adminUnfreezeTenant", method: "POST", path: "/api/v1/admin/tenants/{id}/unfreeze", state: "stable" },
} satisfies Record<string, EndpointSpec>;

export type EndpointId = keyof typeof ENDPOINTS;

/** Flat list of every endpoint the SDK is aware of. */
export const ENDPOINT_LIST: readonly EndpointSpec[] = Object.values(ENDPOINTS);
