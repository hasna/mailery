import { describe, expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";

type Call = { method: string; path: string; auth?: string; body?: unknown; query: URLSearchParams };

function clientWithCalls(calls: Call[]): MaileryClient {
  return new MaileryClient({
    baseUrl: "https://mailery.test",
    apiKey: "ml_key",
    sessionToken: "sess_owner",
    retries: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: String(init?.method ?? "GET"),
        path: url.pathname,
        query: url.searchParams,
        auth: init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>).authorization
          : undefined,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.pathname.includes("/attachments/") && url.pathname.endsWith("/download")) {
        return new Response("attachment-bytes", { status: 200 });
      }
      return Response.json({ ok: true, data: [], next_cursor: null, url: "https://billing.test/session", token: "sess_owner", user: {}, tenant: {}, auth: { via: "api_key", scopes: ["full"] } });
    },
  });
}

describe("MaileryClient API coverage", () => {
  test("newly covered account, auth, billing, message, digest, domain, and admin methods call the versioned API", async () => {
    const calls: Call[] = [];
    const client = clientWithCalls(calls);
    const cases: Array<{ label: string; run: () => Promise<unknown>; method: string; path: string }> = [
      { label: "authProviders", run: () => client.authProviders(), method: "GET", path: "/api/v1/auth/providers" },
      { label: "forgotPassword", run: () => client.forgotPassword("agent@example.com"), method: "POST", path: "/api/v1/auth/password/forgot" },
      { label: "resetPassword", run: () => client.resetPassword({ token: "tok", password: "Sup3rSecret!" }), method: "POST", path: "/api/v1/auth/password/reset" },
      { label: "verifyEmail", run: () => client.verifyEmail("tok"), method: "POST", path: "/api/v1/auth/verify" },
      { label: "verifyPoll", run: () => client.pollVerification("agent@example.com"), method: "POST", path: "/api/v1/auth/verify/poll" },
      { label: "exportAccount", run: () => client.exportAccount({ limit: 10, cursor: "c1" }), method: "GET", path: "/api/v1/account/export" },
      { label: "deleteAccount", run: () => client.deleteAccount({ password: "Sup3rSecret!" }), method: "DELETE", path: "/api/v1/account" },
      { label: "createBillingPortal", run: () => client.createBillingPortal(), method: "POST", path: "/api/v1/billing/portal" },
      { label: "listLabels", run: () => client.listLabels(), method: "GET", path: "/api/v1/labels" },
      { label: "getMessageGroups", run: () => client.getMessageGroups({ mailboxId: "mb1" }), method: "GET", path: "/api/v1/messages/groups" },
      { label: "listMessageChanges", run: () => client.listMessageChanges({ updatedSince: "2026-07-15T00:00:00Z" }), method: "GET", path: "/api/v1/messages/changes" },
      { label: "bulkMessages", run: () => client.bulkMessages({ action: "markRead", ids: ["m1"] }), method: "POST", path: "/api/v1/messages/bulk" },
      { label: "uploadMessage", run: () => client.uploadMessage({ mailboxId: "mb1", subject: "hi" }), method: "POST", path: "/api/v1/messages" },
      { label: "listMessageTombstones", run: () => client.listMessageTombstones({ since: "2026-07-15T00:00:00Z" }), method: "GET", path: "/api/v1/messages/tombstones" },
      { label: "updateMessage", run: () => client.updateMessage("m1", { isRead: true }), method: "PATCH", path: "/api/v1/messages/m1" },
      { label: "deleteMessage", run: () => client.deleteMessage("m1", { reason: "cleanup" }), method: "DELETE", path: "/api/v1/messages/m1" },
      { label: "addMessageLabel", run: () => client.addMessageLabel("m1", "Priority"), method: "POST", path: "/api/v1/messages/m1/labels" },
      { label: "removeMessageLabel", run: () => client.removeMessageLabel("m1", "Priority"), method: "DELETE", path: "/api/v1/messages/m1/labels/Priority" },
      { label: "parseMessage", run: () => client.parseMessage("m1"), method: "POST", path: "/api/v1/messages/m1/parse" },
      { label: "listMessageAttachments", run: () => client.listMessageAttachments("m1"), method: "GET", path: "/api/v1/messages/m1/attachments" },
      { label: "downloadAttachment", run: () => client.downloadAttachment("att1"), method: "GET", path: "/api/v1/attachments/att1/download" },
      { label: "listDigests", run: () => client.listDigests({ limit: 5 }), method: "GET", path: "/api/v1/digests" },
      { label: "generateDigest", run: () => client.generateDigest("last_7_days"), method: "POST", path: "/api/v1/digests/generate" },
      { label: "createDomain", run: () => client.createDomain({ domain: "agent.example.com" }), method: "POST", path: "/api/v1/domains" },
      { label: "setupDomain", run: () => client.setupDomain({ domain: "agent.example.com", buy: true, quoteToken: "signed_quote", maxPriceCents: 1500, currency: "usd", idempotencyKey: "setup-stable-key" }), method: "POST", path: "/api/v1/domains/setup" },
      { label: "getDomain", run: () => client.getDomain("dom1"), method: "GET", path: "/api/v1/domains/dom1" },
      { label: "listDomainDns", run: () => client.listDomainDns("dom1"), method: "GET", path: "/api/v1/domains/dom1/dns" },
      { label: "listDomainEvents", run: () => client.listDomainEvents("dom1", { limit: 10 }), method: "GET", path: "/api/v1/domains/dom1/events" },
      { label: "recordDmarcReport", run: () => client.recordDmarcReport("dom1", { aligned: true }), method: "POST", path: "/api/v1/domains/dom1/dmarc/report" },
      { label: "updateDmarcPolicy", run: () => client.updateDmarcPolicy("dom1", { policy: "quarantine" }), method: "POST", path: "/api/v1/domains/dom1/dmarc/policy" },
      { label: "verifyDomain", run: () => client.verifyDomain("dom1"), method: "POST", path: "/api/v1/domains/dom1/verify" },
      { label: "enableDomainInbound", run: () => client.enableDomainInbound("dom1"), method: "POST", path: "/api/v1/domains/dom1/enable-inbound" },
      { label: "enableDomainOutbound", run: () => client.enableDomainOutbound("dom1"), method: "POST", path: "/api/v1/domains/dom1/enable-outbound" },
      { label: "disableDomain", run: () => client.disableDomain("dom1", "pause"), method: "POST", path: "/api/v1/domains/dom1/disable" },
      { label: "deleteDomain", run: () => client.deleteDomain("dom1"), method: "DELETE", path: "/api/v1/domains/dom1" },
      { label: "mcp", run: () => client.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }), method: "POST", path: "/api/v1/mcp" },
      { label: "adminOverview", run: () => client.adminOverview(), method: "GET", path: "/api/v1/admin/overview" },
      { label: "adminAdjustCredits", run: () => client.adminAdjustCredits({ tenantId: "t1", amount: 5, reason: "test", idempotencyKey: "adjust-retry-key-1" }), method: "POST", path: "/api/v1/admin/credits/adjust" },
      { label: "adminAuditPurgePreflight", run: () => client.adminAuditPurgePreflight(), method: "GET", path: "/api/v1/admin/audit/purge/preflight" },
      { label: "adminAuditPurge", run: () => client.adminAuditPurge({ applyToken: "preflight-token" }), method: "POST", path: "/api/v1/admin/audit/purge" },
      { label: "adminBillingAnomalies", run: () => client.adminBillingAnomalies({ limit: 10 }), method: "POST", path: "/api/v1/admin/billing/anomalies" },
      { label: "adminBillingAnomaliesGet", run: () => client.adminBillingAnomaliesGet({ limit: 10 }), method: "GET", path: "/api/v1/admin/billing/anomalies" },
      { label: "adminFreezeTenant", run: () => client.adminFreezeTenant("t1", { reason: "fraud" }), method: "POST", path: "/api/v1/admin/tenants/t1/freeze" },
      { label: "adminUnfreezeTenant", run: () => client.adminUnfreezeTenant("t1", { clearBillingFlag: false }), method: "POST", path: "/api/v1/admin/tenants/t1/unfreeze" },
    ];

    for (const item of cases) {
      calls.length = 0;
      await item.run();
      expect(calls, item.label).toHaveLength(1);
      expect(calls[0]!.method, item.label).toBe(item.method);
      expect(calls[0]!.path, item.label).toBe(item.path);
    }
  });

  test("admin methods prefer the session/admin credential over a tenant API key when both are configured", async () => {
    const calls: Call[] = [];
    const client = clientWithCalls(calls);

    await client.adminOverview();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/v1/admin/overview");
    expect(calls[0]!.auth).toBe("Bearer sess_owner");
  });
});


test("existing admin SDK methods preserve both reconciliation coverage lanes", async () => {
  const report = { ok: false, eventAnomalies: [], eventReconciliation: { checked: 1000, complete: false }, foreignEventReconciliation: { performed: true, checked: 0, complete: true } };
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "fixture", retries: 0, fetch: async () => Response.json(report) });
  expect(await client.adminBillingAnomalies({ limit: 1 })).toEqual(report);
  expect(await client.adminBillingAnomaliesGet({ limit: 1 })).toEqual(report);
});
