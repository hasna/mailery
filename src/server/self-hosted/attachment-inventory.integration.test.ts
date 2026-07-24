// Attachment-metadata inventory + bulk-search-underreport fix (MP-00034).
//
// Runs the REAL request pipeline (handleSelfHostedRequest) against a real
// Postgres (EMAILS_TEST_POSTGRES_URL). Proves:
//   - Step 2 regression: GET /v1/messages?search=<filename> now matches
//     attachment filename/content_type (previously body/subject only -> 0 hits).
//   - GET /v1/attachments streams full per-attachment metadata that matches the
//     per-ID truth, never leaks content_base64, and paginates exact-once
//     (no dup/skip, ordered, robust to a concurrent insert).
//   - POST /v1/attachments/batch returns metadata keyed by message_id, reports
//     unknown ids, and rejects empty / oversized / malformed batches (400).
//   - Tenant isolation: another tenant's attachments never surface.
//   - Malformed cursor -> 400.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mintApiKey, verifyApiKey } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient, MigrationLedger, type PoolQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore, MAX_ATTACHMENT_BATCH_IDS } from "./store.js";
import { handleSelfHostedRequest, type SelfHostedServiceDeps } from "./service.js";
import { AuthStore } from "./auth/store.js";
import { RateLimiter } from "./auth/rate-limit.js";
import type { SelfHostedKeyStore } from "./keys.js";
import type { AuthMailerConfig } from "./auth/mailer.js";

const SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod-0123456789";
const databaseUrl = process.env["EMAILS_TEST_POSTGRES_URL"];
const pgClient: PoolQueryClient | null = databaseUrl
  ? createQueryClient(createPgPool({ connectionString: databaseUrl, env: { PGSSLMODE: "disable" } }))
  : null;

const stubKeyStore: SelfHostedKeyStore = { insertMinted: async () => {}, list: async () => [], revoke: async () => false };
const MAILER: AuthMailerConfig = { from: "n@hasna.studio", verifyUrlBase: "x", resetUrlBase: "x", inviteUrlBase: "x", productName: "t" };

function makeDeps(): SelfHostedServiceDeps {
  return {
    client: pgClient!,
    store: new EmailsSelfHostedStore(pgClient!),
    verifier: verifyApiKey({ app: "emails", signingSecret: SIGNING_SECRET }),
    sender: { provider: "ses", send: async () => `mock-${crypto.randomUUID()}` },
    migrations: emailsSelfHostedMigrations(),
    version: "test",
    authStore: new AuthStore(pgClient!),
    keyStore: stubKeyStore,
    signingSecret: SIGNING_SECRET,
    rateLimiter: new RateLimiter({ rules: {} }),
    mailer: MAILER,
    env: process.env,
  };
}

function reqOf(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["x-api-key"] = opts.token;
  return new Request(`http://svc${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
}
async function call(deps: SelfHostedServiceDeps, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await handleSelfHostedRequest(deps, reqOf(method, path, opts));
  return { status: res!.status, body: (await res!.json().catch(() => ({}))) as any };
}
async function makeTenant(slug: string) {
  const t = await pgClient!.one<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slug, slug]);
  const minted = mintApiKey({ app: "emails", scopes: ["emails:*"], signingSecret: SIGNING_SECRET });
  await pgClient!.execute(`INSERT INTO api_key_tenants (kid, tenant_id) VALUES ($1, $2)`, [minted.kid, t.id]);
  return { tenantId: t.id, token: minted.token };
}

interface AttSpec { filename: string; content_type: string; size: number; sha256: string; content_base64: string }
function att(filename: string, contentType: string, payload: string, sha = ""): AttSpec {
  return { filename, content_type: contentType, size: payload.length, sha256: sha || filename.padEnd(64, "0").slice(0, 64), content_base64: Buffer.from(payload).toString("base64") };
}
async function importMsg(
  deps: SelfHostedServiceDeps,
  token: string,
  opts: { receivedAt: string; subject?: string; text?: string; attachments?: AttSpec[]; messageId?: string },
): Promise<string> {
  const res = await call(deps, "POST", "/v1/messages", {
    token,
    body: {
      from: "sender@ext.example",
      to: ["me@iso.example"],
      subject: opts.subject ?? "subject",
      text: opts.text ?? "body",
      received_at: opts.receivedAt,
      message_id: opts.messageId ?? `<${crypto.randomUUID()}@ext>`,
      attachments: opts.attachments ?? [],
    },
  });
  expect(res.status).toBe(201);
  return res.body.message.id as string;
}

/** Drain the full inventory with a small page size; return every item in order. */
async function drainInventory(deps: SelfHostedServiceDeps, token: string, limit: number): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const q = `/v1/attachments?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call(deps, "GET", q, { token });
    expect(page.status).toBe(200);
    items.push(...page.body.items);
    if (!page.body.next_cursor) return items;
    cursor = page.body.next_cursor;
  }
  throw new Error("inventory pagination did not terminate");
}
const keyOf = (i: any) => `${i.message_id}#${i.attachment_index}`;

beforeAll(async () => {
  if (!pgClient) return;
  await pgClient.execute("DROP SCHEMA IF EXISTS public CASCADE");
  await pgClient.execute("CREATE SCHEMA public");
  await new MigrationLedger(pgClient, emailsSelfHostedMigrations()).migrate();
});
afterAll(async () => { await pgClient?.close(); });

describe.skipIf(!pgClient)("MP-00034 bulk search underreport fix", () => {
  it("GET /v1/messages?search=<filename> matches attachment-only signals (regression)", async () => {
    const deps = makeDeps();
    const t = await makeTenant("srch");
    // Term appears ONLY in an attachment filename — never in subject/body.
    await importMsg(deps, t.token, {
      receivedAt: "2026-01-01T00:00:00.000Z",
      subject: "quarterly numbers",
      text: "see the file",
      attachments: [att("invoice-Q3.pdf", "application/pdf", "PDF")],
    });
    // Decoy message with the same subject/body but NO matching attachment.
    await importMsg(deps, t.token, { receivedAt: "2026-01-02T00:00:00.000Z", subject: "quarterly numbers", text: "see the file" });

    const byFilename = await call(deps, "GET", `/v1/messages?search=invoice-Q3.pdf`, { token: t.token });
    expect(byFilename.status).toBe(200);
    expect(byFilename.body.messages.length).toBe(1);
    expect(byFilename.body.messages[0].attachment_count).toBe(1);

    // content_type is also part of the match surface.
    const byType = await call(deps, "GET", `/v1/messages?q=application/pdf`, { token: t.token });
    expect(byType.body.messages.length).toBe(1);

    // A term in no field still matches nothing (no false positives).
    const none = await call(deps, "GET", `/v1/messages?search=zzz-nonexistent-token`, { token: t.token });
    expect(none.body.messages.length).toBe(0);
  });
});

describe.skipIf(!pgClient)("MP-00034 attachment inventory route", () => {
  it("streams full metadata that matches the per-ID truth and never leaks content_base64", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-truth");
    const id = await importMsg(deps, t.token, {
      receivedAt: "2026-02-01T00:00:00.000Z",
      attachments: [
        att("a.pdf", "application/pdf", "AAAA", "a".repeat(64)),
        att("b.png", "image/png", "BB", "b".repeat(64)),
      ],
    });
    const inv = await call(deps, "GET", `/v1/attachments`, { token: t.token });
    expect(inv.status).toBe(200);
    const mine = inv.body.items.filter((i: any) => i.message_id === id);
    expect(mine.length).toBe(2);
    expect(mine.map((i: any) => i.attachment_index)).toEqual([0, 1]);
    expect(mine[0]).toMatchObject({ filename: "a.pdf", content_type: "application/pdf", size_bytes: 4, sha256: "a".repeat(64), direction: "inbound" });
    expect(mine[0].received_at).toBe("2026-02-01T00:00:00.000Z");
    for (const item of mine) expect("content_base64" in item).toBe(false);

    // The inventory count for this message equals the per-ID detail truth.
    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(mine.length).toBe(detail.body.message.attachments.length);
  });

  // #36: an inventory row proves METADATA exists, not bytes. On the live serve
  // the overwhelming majority of rows are legacy imports whose payloads were
  // never carried over, and GET /v1/messages/{id}/attachments/{n} answers 409
  // for them. A cataloging client that cannot tell the two apart either has to
  // attempt a download per row or silently records metadata-only rows as
  // complete. Inventory, batch and the per-ID detail must all agree, and must
  // agree with what the content route actually does.
  it("marks metadata-only rows unavailable across inventory, batch and detail — and the content route agrees", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-availability");
    const id = await importMsg(deps, t.token, {
      receivedAt: "2026-02-02T00:00:00.000Z",
      attachments: [
        // Metadata only — exactly the shape the legacy import produced.
        { filename: "legacy.pdf", content_type: "application/pdf", size: 2048, sha256: "c".repeat(64) } as never,
        att("stored.pdf", "application/pdf", "CCCC", "d".repeat(64)),
      ],
    });

    const inv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: t.token });
    const mine = inv.body.items.filter((i: any) => i.message_id === id);
    expect(mine.map((i: any) => [i.filename, i.content_available]))
      .toEqual([["legacy.pdf", false], ["stored.pdf", true]]);

    const batch = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [id] } });
    expect(batch.body.by_message_id[id].map((i: any) => [i.filename, i.content_available]))
      .toEqual([["legacy.pdf", false], ["stored.pdf", true]]);

    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(detail.body.message.attachments.map((a: any) => [a.filename, a.content_available]))
      .toEqual([["legacy.pdf", false], ["stored.pdf", true]]);
    for (const a of detail.body.message.attachments) expect("content_base64" in a).toBe(false);

    // The flag is a PREDICTION of the content route; prove it holds.
    const unavailable = await call(deps, "GET", `/v1/messages/${encodeURIComponent(id)}/attachments/0`, { token: t.token });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.code).toBe("attachment_content_unavailable");
    const available = await call(deps, "GET", `/v1/messages/${encodeURIComponent(id)}/attachments/1`, { token: t.token });
    expect(available.status).toBe(200);
    expect(available.body.attachment.content_base64).toBe(Buffer.from("CCCC").toString("base64"));
  });

  it("paginates exact-once across attachments — no dup/skip, correct order", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-keyset");
    // 5 messages, distinct received_at (fully determines cross-message order),
    // varied attachment counts incl. zero (a no-attachment message emits no rows).
    const specs = [
      { rx: "2026-03-05T00:00:00.000Z", n: 3 },
      { rx: "2026-03-04T00:00:00.000Z", n: 1 },
      { rx: "2026-03-03T00:00:00.000Z", n: 0 },
      { rx: "2026-03-02T00:00:00.000Z", n: 2 },
      { rx: "2026-03-01T00:00:00.000Z", n: 4 },
    ];
    const created: { id: string; rx: string; n: number }[] = [];
    for (const s of specs) {
      const attachments = Array.from({ length: s.n }, (_, k) => att(`f${k}.bin`, "application/octet-stream", `p${k}`));
      const id = await importMsg(deps, t.token, { receivedAt: s.rx, attachments });
      created.push({ id, rx: s.rx, n: s.n });
    }
    const totalAtt = specs.reduce((a, s) => a + s.n, 0); // 10

    // Expected order: received_at DESC, then attachment_index ASC.
    const expected: string[] = [];
    for (const c of [...created].sort((a, b) => (a.rx < b.rx ? 1 : -1))) {
      for (let k = 0; k < c.n; k++) expected.push(`${c.id}#${k}`);
    }

    for (const limit of [1, 2, 3, 10, 500]) {
      const items = await drainInventory(deps, t.token, limit);
      const keys = items.map(keyOf);
      expect(keys.length).toBe(totalAtt);
      expect(new Set(keys).size).toBe(totalAtt); // no duplicates
      expect(keys).toEqual(expected); // exact order, no skips
    }
  });

  it("paginates exact-once when messages share a sort_ts (id tie-break)", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-tiebreak");
    // Three messages with the SAME received_at -> same sort_ts, so cross-message
    // order falls entirely to the id DESC tie-break. Each has 2 attachments.
    const rx = "2026-08-08T08:08:08.000Z";
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await importMsg(deps, t.token, { receivedAt: rx, attachments: [att(`t${i}-0.bin`, "application/octet-stream", "a"), att(`t${i}-1.bin`, "application/octet-stream", "b")] }));
    }
    const expectedKeys = ids.flatMap((id) => [`${id}#0`, `${id}#1`]);
    for (const limit of [1, 2, 3, 5, 500]) {
      const items = await drainInventory(deps, t.token, limit);
      const keys = items.map(keyOf);
      expect(keys.length).toBe(6);
      expect(new Set(keys).size).toBe(6); // no dup
      expect(new Set(keys)).toEqual(new Set(expectedKeys)); // no skip
      // Each message's two attachments are adjacent and index-ascending (the
      // tie-break orders whole messages, then attachment_index within them).
      for (const id of ids) {
        const p0 = keys.indexOf(`${id}#0`);
        const p1 = keys.indexOf(`${id}#1`);
        expect(p1).toBe(p0 + 1);
      }
    }
  });

  it("a bigint-overflow attachment size does not 500 or wedge the scan; endpoints agree", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-bigsize");
    // size beyond bigint range is caller-supplied and stored unvalidated by the
    // import path — it must not crash the keyset scan (regression: it used to 500
    // and wedge every page from that row onward).
    const poison = await call(deps, "POST", "/v1/messages", {
      token: t.token,
      body: {
        from: "s@ext.example", to: ["me@iso.example"], subject: "s", text: "b",
        received_at: "2026-09-02T00:00:00.000Z", message_id: "<bigsize@ext>",
        attachments: [{ filename: "huge.bin", content_type: "application/octet-stream", size: 1e30, sha256: "e".repeat(64) }],
      },
    });
    expect(poison.status).toBe(201);
    const poisonId = poison.body.message.id;
    // An older message so the scan must page PAST the poison row.
    await importMsg(deps, t.token, { receivedAt: "2026-09-01T00:00:00.000Z", attachments: [att("after.bin", "application/octet-stream", "x")] });

    const inv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: t.token });
    expect(inv.status).toBe(200); // no 500
    const invPoison = inv.body.items.find((i: any) => i.message_id === poisonId);
    expect(invPoison).toBeDefined();
    expect(inv.body.items.some((i: any) => i.filename === "after.bin")).toBe(true); // not wedged

    const batch = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [poisonId] } });
    expect(batch.status).toBe(200);
    // The two endpoints normalize size identically (no null-vs-number skew).
    expect(invPoison.size_bytes).toBe(batch.body.by_message_id[poisonId][0].size_bytes);
  });

  it("last page yields next_cursor=null; an empty inventory returns [] and null", async () => {
    const deps = makeDeps();
    const empty = await makeTenant("inv-empty");
    const e = await call(deps, "GET", `/v1/attachments?limit=50`, { token: empty.token });
    expect(e.body.items).toEqual([]);
    expect(e.body.next_cursor).toBeNull();

    const t = await makeTenant("inv-exact");
    await importMsg(deps, t.token, { receivedAt: "2026-04-01T00:00:00.000Z", attachments: [att("x.txt", "text/plain", "x"), att("y.txt", "text/plain", "y")] });
    // limit exactly equals the row count: a full page still exposes a cursor,
    // and the follow-up page is empty with a null cursor (no over-read).
    const p1 = await call(deps, "GET", `/v1/attachments?limit=2`, { token: t.token });
    expect(p1.body.items.length).toBe(2);
    expect(p1.body.next_cursor).not.toBeNull();
    const p2 = await call(deps, "GET", `/v1/attachments?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`, { token: t.token });
    expect(p2.body.items).toEqual([]);
    expect(p2.body.next_cursor).toBeNull();
  });

  it("keeps index alignment and never errors on malformed attachment elements", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-malformed");
    // Element 1 is a bare string (not an object); element 2 has a fractional
    // size. Both must still occupy their array position so attachment_index
    // stays aligned with GET /v1/messages/{id}/attachments/{index}.
    const res = await call(deps, "POST", "/v1/messages", {
      token: t.token,
      body: {
        from: "s@ext.example", to: ["me@iso.example"], subject: "s", text: "b",
        received_at: "2026-05-20T00:00:00.000Z", message_id: "<malformed@ext>",
        attachments: [
          att("good.pdf", "application/pdf", "G"),
          "i-am-not-an-object",
          { filename: "frac.bin", content_type: "application/octet-stream", size: 1024.9, sha256: "d".repeat(64) },
        ],
      },
    });
    expect(res.status).toBe(201);
    const id = res.body.message.id;

    const inv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: t.token });
    expect(inv.status).toBe(200);
    const mine = inv.body.items.filter((i: any) => i.message_id === id);
    // All three positions surface; the malformed one is not silently dropped.
    expect(mine.map((i: any) => i.attachment_index)).toEqual([0, 1, 2]);
    expect(mine[0].filename).toBe("good.pdf");
    expect(mine[1]).toMatchObject({ filename: null, content_type: null, size_bytes: null, sha256: null });
    expect(mine[2].size_bytes).toBe(1024); // fractional size floored, not a 500

    // Inventory row count matches the per-ID truth (jsonb_array_length).
    const detail = await call(deps, "GET", `/v1/messages/${id}`, { token: t.token });
    expect(mine.length).toBe(detail.body.message.attachments.length);
  });

  it("a concurrent insert ahead of the cursor does not dup or skip the in-flight scan", async () => {
    const deps = makeDeps();
    const t = await makeTenant("inv-concurrent");
    const base: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await importMsg(deps, t.token, { receivedAt: `2026-05-0${i + 1}T00:00:00.000Z`, attachments: [att(`b${i}.bin`, "application/octet-stream", `b${i}`)] });
      base.push(id);
    }
    // Page 1 (limit 2) then insert a NEWER message (sorts to the very front,
    // i.e. ahead of the cursor / already passed).
    const p1 = await call(deps, "GET", `/v1/attachments?limit=2`, { token: t.token });
    const seen = p1.body.items.map(keyOf);
    const intruderId = await importMsg(deps, t.token, { receivedAt: "2026-05-09T00:00:00.000Z", attachments: [att("intruder.bin", "application/octet-stream", "zzz")] });

    let cursor = p1.body.next_cursor;
    while (cursor) {
      const page = await call(deps, "GET", `/v1/attachments?limit=2&cursor=${encodeURIComponent(cursor)}`, { token: t.token });
      seen.push(...page.body.items.map(keyOf));
      cursor = page.body.next_cursor;
    }
    // Every original attachment appears exactly once; the ahead-of-cursor
    // intruder does NOT corrupt the in-flight scan (it was already "passed").
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of base) expect(seen).toContain(`${id}#0`);
    expect(seen).not.toContain(`${intruderId}#0`);
    // A fresh scan started now DOES include the intruder (at the front).
    const fresh = await drainInventory(deps, t.token, 3);
    expect(fresh.map(keyOf)).toContain(`${intruderId}#0`);
    expect(fresh[0].message_id).toBe(intruderId);
  });
});

describe.skipIf(!pgClient)("MP-00034 attachment batch-by-ids route", () => {
  it("returns metadata keyed by message_id, reports unknown ids, excludes content_base64", async () => {
    const deps = makeDeps();
    const t = await makeTenant("batch-ok");
    const id1 = await importMsg(deps, t.token, { receivedAt: "2026-06-01T00:00:00.000Z", attachments: [att("r.pdf", "application/pdf", "R"), att("s.png", "image/png", "S")] });
    const id2 = await importMsg(deps, t.token, { receivedAt: "2026-06-02T00:00:00.000Z", attachments: [] });
    const bogus = crypto.randomUUID();

    const res = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [id1, id2, bogus] } });
    expect(res.status).toBe(200);
    expect(res.body.max_batch_size).toBe(MAX_ATTACHMENT_BATCH_IDS);
    expect(res.body.by_message_id[id1].length).toBe(2);
    expect(res.body.by_message_id[id1][0]).toEqual({ attachment_index: 0, filename: "r.pdf", content_type: "application/pdf", size_bytes: 1, sha256: "r.pdf".padEnd(64, "0").slice(0, 64), content_available: true });
    expect("content_base64" in res.body.by_message_id[id1][0]).toBe(false);
    expect(res.body.by_message_id[id2]).toEqual([]);
    expect(res.body.unknown_ids).toEqual([bogus]);
  });

  it("rejects empty, oversized, and malformed message_ids with 400", async () => {
    const deps = makeDeps();
    const t = await makeTenant("batch-bad");
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [] } })).status).toBe(400);
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: "nope" } })).status).toBe(400);
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: {} })).status).toBe(400);
    expect((await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: [123] } })).status).toBe(400);
    const oversized = Array.from({ length: MAX_ATTACHMENT_BATCH_IDS + 1 }, () => crypto.randomUUID());
    const big = await call(deps, "POST", `/v1/attachments/batch`, { token: t.token, body: { message_ids: oversized } });
    expect(big.status).toBe(400);
    expect(big.body.code).toBe("batch_too_large");
    expect(big.body.max_batch_size).toBe(MAX_ATTACHMENT_BATCH_IDS);
  });
});

describe.skipIf(!pgClient)("MP-00034 tenant isolation + malformed cursor", () => {
  it("another tenant's attachments never surface via inventory or batch", async () => {
    const deps = makeDeps();
    const a = await makeTenant("iso-att-a");
    const b = await makeTenant("iso-att-b");
    const aId = await importMsg(deps, a.token, { receivedAt: "2026-07-01T00:00:00.000Z", attachments: [att("a-secret.pdf", "application/pdf", "A")] });
    const bId = await importMsg(deps, b.token, { receivedAt: "2026-07-02T00:00:00.000Z", attachments: [att("b-secret.pdf", "application/pdf", "B")] });

    const aInv = await call(deps, "GET", `/v1/attachments?limit=500`, { token: a.token });
    const aMsgIds = new Set(aInv.body.items.map((i: any) => i.message_id));
    expect(aMsgIds.has(aId)).toBe(true);
    expect(aMsgIds.has(bId)).toBe(false);
    expect(aInv.body.items.some((i: any) => i.filename === "b-secret.pdf")).toBe(false);

    // A asking for B's id gets it back only as unknown — never its metadata.
    const cross = await call(deps, "POST", `/v1/attachments/batch`, { token: a.token, body: { message_ids: [bId, aId] } });
    expect(cross.body.by_message_id[bId]).toBeUndefined();
    expect(cross.body.unknown_ids).toEqual([bId]);
    expect(cross.body.by_message_id[aId].length).toBe(1);
  });

  it("a malformed cursor is rejected with 400", async () => {
    const deps = makeDeps();
    const t = await makeTenant("bad-cursor");
    for (const bad of ["not-base64!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ ts: "nope", id: "x", idx: 0 })).toString("base64url")]) {
      const res = await call(deps, "GET", `/v1/attachments?cursor=${encodeURIComponent(bad)}`, { token: t.token });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_cursor");
    }
  });
});
