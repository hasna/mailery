// Self-hosted-ONLY: the emails (sent-ledger) repo routes every read/write to the
// /v1/messages API. This exercises the REAL curl transport against an
// out-of-process /v1 stub — see src/test-support/v1-stub.ts for why the stub
// must run in a separate process. Migrated from the deleted local-SQLite pattern
// (getDatabase/resetDatabase/:memory:/EMAILS_DB_PATH).
//
// Dropped from the local-SQLite version:
//   - the two "lean projection / omits idempotency keys" tests inspected the
//     local SQL string (recordingDb Proxy, `SELECT *`, column names) and passed a
//     `db` handle that no longer exists. The meaningful part — idempotency_key is
//     never surfaced on a mapped Email — is retained functionally below.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import {
  createEmail,
  getEmail,
  listEmails,
  searchEmails,
  updateEmailStatus,
  deleteEmail,
} from "./emails.js";
import { EmailNotFoundError } from "../types/index.js";

let stub: V1Stub;

const providerId = "prov-1";

const baseOpts = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  subject: "Test Subject",
  text: "Hello world",
};

/** An outbound /v1/messages row (with explicit created_at for deterministic ordering). */
function outboundMessage(row: {
  id: string;
  subject?: string;
  from_addr?: string;
  to_addrs?: unknown;
  cc_addrs?: unknown;
  bcc_addrs?: unknown;
  status?: string;
  created_at: string;
  provider_id?: string;
  idempotency_key?: string;
}): Record<string, unknown> {
  return {
    direction: "outbound",
    from_addr: "sender@example.com",
    to_addrs: ["recipient@example.com"],
    subject: "Seeded",
    status: "sent",
    provider_id: providerId,
    ...row,
  };
}

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

describe("createEmail", () => {
  it("creates an email with status=sent", () => {
    const e = createEmail(providerId, baseOpts);
    expect(e.id).toHaveLength(36);
    expect(e.from_address).toBe("sender@example.com");
    expect(e.to_addresses).toEqual(["recipient@example.com"]);
    expect(e.subject).toBe("Test Subject");
    expect(e.status).toBe("sent");
    expect(e.has_attachments).toBe(false);
    expect(e.attachment_count).toBe(0);
    // Round-trips through the /v1 store.
    expect(getEmail(e.id)!.subject).toBe("Test Subject");
  });

  it("stores multiple recipients", () => {
    const e = createEmail(providerId, { ...baseOpts, to: ["a@x.com", "b@x.com"] });
    expect(e.to_addresses).toEqual(["a@x.com", "b@x.com"]);
  });

  it("stores cc and bcc", () => {
    const e = createEmail(providerId, { ...baseOpts, cc: ["cc@x.com"], bcc: ["bcc@x.com"] });
    expect(e.cc_addresses).toEqual(["cc@x.com"]);
    expect(e.bcc_addresses).toEqual(["bcc@x.com"]);
  });

  it("stores attachment info", () => {
    const e = createEmail(providerId, {
      ...baseOpts,
      attachments: [{ filename: "test.pdf", content: "abc", content_type: "application/pdf" }],
    });
    expect(e.has_attachments).toBe(true);
    expect(e.attachment_count).toBe(1);
  });

  it("stores provider_message_id", () => {
    const e = createEmail(providerId, baseOpts, "msg-123");
    expect(e.provider_message_id).toBe("msg-123");
  });

  it("round-trips tags through the /v1 store", () => {
    const e = createEmail(providerId, { ...baseOpts, tags: { campaign: "launch", tier: "gold" } });
    expect(e.tags).toEqual({ campaign: "launch", tier: "gold" });
    // Tags survive a read-back (apiMessageToEmail maps the `tags` object).
    expect(getEmail(e.id)!.tags).toEqual({ campaign: "launch", tier: "gold" });
  });
});

describe("getEmail", () => {
  it("retrieves email by id", () => {
    const e = createEmail(providerId, baseOpts);
    const found = getEmail(e.id);
    expect(found?.id).toBe(e.id);
  });

  it("coerces malformed recipient JSON to empty arrays (missing tags → {})", async () => {
    // A /v1 row whose address fields are non-array JSON must map to [] (cstrArray),
    // and a row with no `tags` maps to {} (cobj of undefined).
    await stub.seed({
      messages: [
        outboundMessage({
          id: "malformed-1",
          created_at: "2026-01-01T00:00:00.000Z",
          to_addrs: "{}",
          cc_addrs: "{}",
          bcc_addrs: "{}",
        }),
      ],
    });

    const found = getEmail("malformed-1");
    expect(found?.to_addresses).toEqual([]);
    expect(found?.cc_addresses).toEqual([]);
    expect(found?.bcc_addresses).toEqual([]);
    expect(found?.tags).toEqual({});
  });

  it("returns null for unknown id", () => {
    expect(getEmail("nonexistent")).toBeNull();
  });
});

describe("listEmails", () => {
  it("lists all emails", () => {
    createEmail(providerId, baseOpts);
    createEmail(providerId, { ...baseOpts, subject: "Second" });
    expect(listEmails().length).toBe(2);
  });

  it("filters by provider_id", () => {
    createEmail(providerId, baseOpts);
    createEmail("prov-2", baseOpts);
    expect(listEmails({ provider_id: providerId }).length).toBe(1);
  });

  it("filters by status", () => {
    const e = createEmail(providerId, baseOpts);
    updateEmailStatus(e.id, "delivered");
    createEmail(providerId, { ...baseOpts, subject: "Second" });
    const delivered = listEmails({ status: "delivered" });
    const sent = listEmails({ status: "sent" });
    expect(delivered.length).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("filters by multiple statuses", () => {
    const e1 = createEmail(providerId, baseOpts);
    updateEmailStatus(e1.id, "delivered");
    const e2 = createEmail(providerId, { ...baseOpts, subject: "B" });
    updateEmailStatus(e2.id, "bounced");
    createEmail(providerId, { ...baseOpts, subject: "C" });
    const list = listEmails({ status: ["delivered", "bounced"] });
    expect(list.length).toBe(2);
  });

  it("filters by canonical sender through display-name From values", () => {
    createEmail(providerId, { ...baseOpts, from: '"Ops Team" <ops@example.com>', subject: "Display sender" });
    createEmail(providerId, { ...baseOpts, from: "ops@example.com", subject: "Bare sender" });
    createEmail(providerId, { ...baseOpts, from: "team@example.com", subject: "Other sender" });

    const bare = listEmails({ from_address: "ops@example.com" }).map((email) => email.subject).sort();
    const display = listEmails({ from_address: "Ops Team <ops@example.com>" }).map((email) => email.subject).sort();

    expect(bare).toEqual(["Bare sender", "Display sender"]);
    expect(display).toEqual(["Bare sender", "Display sender"]);
  });

  it("supports limit and offset", () => {
    for (let i = 0; i < 5; i++) createEmail(providerId, { ...baseOpts, subject: `Email ${i}` });
    expect(listEmails({ limit: 3 }).length).toBe(3);
    expect(listEmails({ limit: 3, offset: 3 }).length).toBe(2);
  });

  it("clamps bad limit and offset values", () => {
    for (let i = 0; i < 5; i++) createEmail(providerId, { ...baseOpts, subject: `Clamp ${i}` });

    expect(listEmails({ limit: 0 }).length).toBe(1);
    expect(listEmails({ limit: -2 }).length).toBe(1);
    expect(listEmails({ limit: Number.NaN }).length).toBe(5);
    expect(listEmails({ limit: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }).length).toBe(5);
  });

  it("never surfaces idempotency keys on list rows", () => {
    createEmail(providerId, { ...baseOpts, subject: "Sensitive key", idempotency_key: "dedupe-secret-key" });

    const [email] = listEmails({ limit: 1 });

    expect(email).toBeDefined();
    expect("idempotency_key" in email!).toBe(false);
    expect(JSON.stringify(email)).not.toContain("dedupe-secret-key");
  });
});

describe("updateEmailStatus", () => {
  it("updates status", () => {
    const e = createEmail(providerId, baseOpts);
    const updated = updateEmailStatus(e.id, "delivered");
    expect(updated.status).toBe("delivered");
  });

  it("throws EmailNotFoundError for unknown id", () => {
    expect(() => updateEmailStatus("nonexistent", "delivered")).toThrow(EmailNotFoundError);
  });
});

describe("deleteEmail", () => {
  it("deletes an email", () => {
    const e = createEmail(providerId, baseOpts);
    expect(deleteEmail(e.id)).toBe(true);
    expect(getEmail(e.id)).toBeNull();
  });

  it("returns false for unknown id", () => {
    expect(deleteEmail("nonexistent")).toBe(false);
  });
});

describe("searchEmails", () => {
  it("searches by subject", () => {
    createEmail(providerId, { ...baseOpts, subject: "Welcome aboard" });
    createEmail(providerId, { ...baseOpts, subject: "Password reset" });
    const results = searchEmails("Welcome");
    expect(results.length).toBe(1);
    expect(results[0]!.subject).toBe("Welcome aboard");
  });

  it("searches by from_address", () => {
    createEmail(providerId, { ...baseOpts, from: "alice@example.com" });
    createEmail(providerId, { ...baseOpts, from: "bob@example.com" });
    const results = searchEmails("alice");
    expect(results.length).toBe(1);
    expect(results[0]!.from_address).toBe("alice@example.com");
  });

  it("searches by to_addresses", () => {
    createEmail(providerId, { ...baseOpts, to: ["charlie@example.com"] });
    createEmail(providerId, { ...baseOpts, to: ["dave@example.com"] });
    const results = searchEmails("charlie");
    expect(results.length).toBe(1);
    expect(results[0]!.to_addresses).toEqual(["charlie@example.com"]);
  });

  it("respects limit option", () => {
    for (let i = 0; i < 5; i++) {
      createEmail(providerId, { ...baseOpts, subject: `Match ${i}` });
    }
    const results = searchEmails("Match", { limit: 3 });
    expect(results.length).toBe(3);
  });

  it("clamps bad search limits", () => {
    for (let i = 0; i < 5; i++) {
      createEmail(providerId, { ...baseOpts, subject: `Match ${i}` });
    }

    expect(searchEmails("Match", { limit: 0 }).length).toBe(1);
    expect(searchEmails("Match", { limit: -10 }).length).toBe(1);
    expect(searchEmails("Match", { limit: Number.NaN }).length).toBe(5);
    expect(searchEmails("Match", { limit: Number.POSITIVE_INFINITY }).length).toBe(5);
  });

  it("supports offset paging after filtering (newest first)", async () => {
    await stub.seed({
      messages: [0, 1, 2, 3].map((i) =>
        outboundMessage({
          id: `paged-${i}`,
          subject: `Paged Match ${i}`,
          created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      ),
    });

    const results = searchEmails("Paged Match", { limit: 2, offset: 1 });

    expect(results.map((email) => email.subject)).toEqual(["Paged Match 2", "Paged Match 1"]);
  });

  it("never surfaces idempotency keys on search rows", () => {
    createEmail(providerId, { ...baseOpts, subject: "Find sensitive", idempotency_key: "search-dedupe-secret" });

    const [email] = searchEmails("sensitive", { limit: 1 });

    expect(email).toBeDefined();
    expect("idempotency_key" in email!).toBe(false);
    expect(JSON.stringify(email)).not.toContain("search-dedupe-secret");
  });

  it("returns empty array for no matches", () => {
    createEmail(providerId, baseOpts);
    const results = searchEmails("nonexistent-term-xyz");
    expect(results.length).toBe(0);
  });

  it("is case-insensitive", () => {
    createEmail(providerId, { ...baseOpts, subject: "IMPORTANT Notice" });
    const results = searchEmails("important");
    expect(results.length).toBe(1);
  });
});
