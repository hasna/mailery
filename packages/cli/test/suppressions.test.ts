// `mailery suppressions *` and `mailery mailboxes create|delete` command tests
// (launch lane L06): parsing, request shape and envelopes. No network — the
// routing fake fetch stands in for the server.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type RouteHandler } from "./support.js";

const BOUNCE = {
  id: "sup_1",
  email: "bounced@example.com",
  reason: "bounce",
  source: "ses",
  created_at: "2026-09-10T00:00:00.000Z",
  updated_at: "2026-09-10T00:00:00.000Z",
  expires_at: null,
};
const COMPLAINT = { ...BOUNCE, id: "sup_2", email: "complained@example.com", reason: "complaint" };

const route: RouteHandler = (c) => {
  if (c.path === "/api/v1/suppressions" && c.method === "GET") {
    return { body: { data: [BOUNCE, COMPLAINT], next_cursor: "cursor-2" } };
  }
  if (c.path === "/api/v1/suppressions/sup_2" && c.method === "DELETE") {
    // The server refuses a complaint removal that arrives without confirm.
    if (c.query["confirm"] !== "true") {
      return { status: 409, body: { error: { code: "complaint_removal_requires_confirmation", message: "this address is suppressed because the recipient reported a message as spam; resend confirm=true to remove it" } } };
    }
    return { body: { ok: true, id: "sup_2", email: COMPLAINT.email, reason: "complaint" } };
  }
  if (c.path === "/api/v1/suppressions/sup_1" && c.method === "DELETE") {
    return { body: { ok: true, id: "sup_1", email: BOUNCE.email, reason: "bounce" } };
  }
  if (c.path === "/api/v1/mailboxes" && c.method === "POST") {
    const body = c.body as { provider?: string; email: string };
    return { status: 201, body: { id: "mb_1", email: body.email, provider: body.provider ?? "ses", status: "active" } };
  }
  if (c.path === "/api/v1/mailboxes/mb_1" && c.method === "DELETE") {
    return { body: { ok: true, id: "mb_1", email: "agent@tenant.example", purged_messages: c.query["purge"] === "true" ? 3 : 0 } };
  }
  return undefined;
};

function harness() {
  return makeHarness({ route, env: { MAILERY_API_KEY: "ml_key" } });
}

describe("mailery suppressions", () => {
  test("list passes filters and paging through and surfaces the next cursor", async () => {
    const h = harness();
    await runCli(argv("suppressions", "list", "--reason", "complaint", "--email", "complained@example.com", "--limit", "25", "--cursor", "cursor-1"), h.deps);
    expect(h.exitCode()).toBe(0);
    const call = h.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/api/v1/suppressions");
    expect(call.query).toMatchObject({ reason: "complaint", email: "complained@example.com", limit: "25", cursor: "cursor-1" });
    expect(call.auth).toBe("Bearer ml_key");
    expect(h.out()).toContain("bounced@example.com");
    expect(h.out()).toContain("next page: --cursor cursor-2");
  });

  test("list --json emits the page envelope with a normalized cursor", async () => {
    const h = harness();
    await runCli(argv("suppressions", "list", "--json"), h.deps);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    const page = env.data as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(page.data.map((row) => row.id)).toEqual(["sup_1", "sup_2"]);
    expect(page.nextCursor).toBe("cursor-2");
  });

  test("remove sends no confirm by default and --confirm opts into a complaint removal", async () => {
    const plain = harness();
    await runCli(argv("suppressions", "remove", "sup_1"), plain.deps);
    expect(plain.exitCode()).toBe(0);
    expect(plain.calls[0]!.method).toBe("DELETE");
    expect(plain.calls[0]!.query["confirm"]).toBeUndefined();
    expect(plain.out()).toContain("Suppression for bounced@example.com (bounce) removed.");

    // Without --confirm the server's 409 reaches the operator as a failure.
    const refused = harness();
    await runCli(argv("suppressions", "remove", "sup_2"), refused.deps);
    expect(refused.exitCode()).not.toBe(0);
    expect(refused.err()).toContain("reported a message as spam");

    const confirmed = harness();
    await runCli(argv("suppressions", "remove", "sup_2", "--confirm", "--json"), confirmed.deps);
    expect(confirmed.exitCode()).toBe(0);
    expect(confirmed.calls[0]!.query["confirm"]).toBe("true");
    expect((parseJsonOut(confirmed.out()).data as { reason: string }).reason).toBe("complaint");
  });
});

describe("mailery mailboxes", () => {
  test("create without --provider asks for no provider, so the server's hosted default applies", async () => {
    const h = harness();
    await runCli(argv("mailboxes", "create", "agent@tenant.example", "--json"), h.deps);
    expect(h.exitCode()).toBe(0);
    const call = h.calls[0]!;
    expect((call.body as Record<string, unknown>)["provider"]).toBeUndefined();
    // The server answers with the hosted backend rather than the old
    // non-sendable "manual" default.
    expect((parseJsonOut(h.out()).data as { provider: string }).provider).toBe("ses");
  });

  test("create still accepts an explicit manual backend", async () => {
    const h = harness();
    await runCli(argv("mailboxes", "create", "agent@tenant.example", "--provider", "manual", "--json"), h.deps);
    expect((h.calls[0]!.body as Record<string, unknown>)["provider"]).toBe("manual");
  });

  test("delete refuses to purge unless asked", async () => {
    const plain = harness();
    await runCli(argv("mailboxes", "delete", "mb_1"), plain.deps);
    expect(plain.exitCode()).toBe(0);
    expect(plain.calls[0]!.method).toBe("DELETE");
    expect(plain.calls[0]!.query["purge"]).toBeUndefined();
    expect(plain.out()).toContain("Mailbox agent@tenant.example deleted.");

    const purged = harness();
    await runCli(argv("mailboxes", "delete", "mb_1", "--purge"), purged.deps);
    expect(purged.calls[0]!.query["purge"]).toBe("true");
    expect(purged.out()).toContain("with 3 message(s)");
  });
});
