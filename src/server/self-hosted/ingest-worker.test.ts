import { describe, it, expect } from "bun:test";
import { ingestS3Object, processInboundNotification, shouldDeleteIngestResult, validateIngestWorkerConfig, type IngestDeps } from "./ingest-worker.js";
import type { MessageInput, MessageRecord } from "./store.js";

const OBJECT_KEY = "inbound/hasna.com/msgkey123";
const BUCKET = "emails-inbound-123456789012";

const sesNotification = JSON.stringify({
  notificationType: "Received",
  mail: { messageId: "msgkey123", source: "alice@external.com", timestamp: "2026-07-02T10:00:00.000Z" },
  receipt: {
    recipients: ["andrei@hasna.com"],
    action: { type: "S3", bucketName: BUCKET, objectKey: OBJECT_KEY },
  },
});

const rawEmail = [
  `From: Alice <alice@external.com>`,
  `To: andrei@hasna.com`,
  `Subject: Hello there`,
  `Message-ID: <real-rfc-id@external.com>`,
  `Date: Thu, 02 Jul 2026 09:59:00 +0000`,
  ``,
  `body text`,
  ``,
].join("\r\n");

function makeDeps(overrides: Partial<IngestDeps> & { existing?: string | null } = {}): {
  deps: IngestDeps;
  upserts: MessageInput[];
  fetched: string[];
  quarantines: Array<{ sourceId: string; reason: string; envelopeRecipients: string[] }>;
} {
  const upserts: MessageInput[] = [];
  const fetched: string[] = [];
  const quarantines: Array<{ sourceId: string; reason: string; envelopeRecipients: string[] }> = [];
  const deps: IngestDeps = {
    store: {
      resolveInboundRecipients: async (recipients) => ({
        groups: recipients.length > 0 ? [{ tenantId: "tenant-a", recipients }] : [],
        unresolved: recipients.length > 0 ? [] : recipients,
      }),
      quarantineInbound: async (input) => { quarantines.push(input); },
      forTenant: () => ({
        findMessageIdByKey: async () => overrides.existing ?? null,
        upsertMessage: async (input: MessageInput) => {
          upserts.push(input);
          return {
            record: { id: "row-1", ...input } as unknown as MessageRecord,
            inserted: true,
          };
        },
      }),
    },
    fetchObject: async (bucket: string, key: string) => {
      fetched.push(`${bucket}/${key}`);
      return Buffer.from(rawEmail);
    },
    now: () => "2026-07-02T12:00:00.000Z",
    ...(overrides.store ? { store: overrides.store } : {}),
    ...(overrides.fetchObject ? { fetchObject: overrides.fetchObject } : {}),
  };
  return { deps, upserts, fetched, quarantines };
}

describe("processInboundNotification", () => {
  it("requires all durable worker configuration before startup", () => {
    expect(() => validateIngestWorkerConfig({ bucket: BUCKET, databaseUrl: "postgres://example" })).toThrow(/QUEUE_URL/);
    expect(() => validateIngestWorkerConfig({ queueUrl: "https://sqs.example/q", databaseUrl: "postgres://example" })).toThrow(/S3_BUCKET/);
    expect(() => validateIngestWorkerConfig({ queueUrl: "https://sqs.example/q", bucket: BUCKET })).toThrow(/DATABASE_URL/);
    expect(() => validateIngestWorkerConfig({ queueUrl: "https://sqs.example/q", bucket: BUCKET, databaseUrl: "postgres://example" })).not.toThrow();
  });

  it("deletes only terminal success and duplicate results", () => {
    expect(shouldDeleteIngestResult({ status: "ingested" })).toBe(true);
    expect(shouldDeleteIngestResult({ status: "duplicate" })).toBe(true);
    expect(shouldDeleteIngestResult({ status: "quarantined" })).toBe(true);
    expect(shouldDeleteIngestResult({ status: "error" })).toBe(false);
  });

  it("ingests a new inbound message keyed on the S3 object key", async () => {
    const { deps, upserts, fetched } = makeDeps();
    const r = await processInboundNotification(deps, sesNotification, BUCKET);

    expect(r.status).toBe("ingested");
    expect(r.key).toBe(OBJECT_KEY);
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(upserts).toHaveLength(1);

    const w = upserts[0]!;
    // Dedup identity: both source_id and message_id are the object key so the
    // live drain never duplicates the history backfill (which stored the key in
    // message_id).
    expect(w.source_id).toBe(OBJECT_KEY);
    expect(w.message_id).toBe(OBJECT_KEY);
    expect(w.direction).toBe("inbound");
    expect(w.status).toBe("received");
    expect(w.to_addrs).toEqual(["andrei@hasna.com"]);
    expect(w.cc_addrs).toEqual([]);
    expect(w.from_addr).toContain("alice@external.com");
    // The Date header wins over the SES timestamp for received_at.
    expect(w.received_at).toBe("2026-07-02T09:59:00.000Z");
    // The real RFC Message-ID is retained in headers, not lost.
    expect(w.headers?.["message-id"]).toContain("real-rfc-id@external.com");
  });

  it("ingests a listed S3 object directly for one-shot backfills", async () => {
    const { deps, upserts, fetched } = makeDeps();
    const r = await ingestS3Object(deps, BUCKET, OBJECT_KEY, { recipients: ["andrei@hasna.com"] });

    expect(r.status).toBe("ingested");
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(upserts[0]).toMatchObject({
      source_id: OBJECT_KEY,
      message_id: OBJECT_KEY,
      direction: "inbound",
      status: "received",
    });
  });

  it("skips (as duplicate) when the key already exists", async () => {
    const { deps, upserts, fetched } = makeDeps({ existing: "existing-row" });
    const r = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(r.status).toBe("duplicate");
    expect(fetched).toEqual([]); // never fetched from S3
    expect(upserts).toEqual([]);
  });

  it("routes only from the SES envelope and ignores spoofed MIME recipients", async () => {
    const spoofed = [
      "From: attacker@external.com",
      "To: victim@other-tenant.example",
      "Cc: hidden@other-tenant.example",
      "Subject: spoof",
      "",
      "body",
    ].join("\r\n");
    const { deps, upserts } = makeDeps({ fetchObject: async () => Buffer.from(spoofed) });
    const result = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(result.status).toBe("ingested");
    expect(upserts[0]!.to_addrs).toEqual(["andrei@hasna.com"]);
    expect(upserts[0]!.cc_addrs).toEqual([]);
  });

  it("splits one object into tenant-scoped writes and deduplicates within each tenant", async () => {
    const writes = new Map<string, MessageInput[]>();
    const { deps, fetched } = makeDeps({
      store: {
        resolveInboundRecipients: async () => ({
          groups: [
            { tenantId: "tenant-a", recipients: ["a@one.example"] },
            { tenantId: "tenant-b", recipients: ["b@two.example"] },
          ],
          unresolved: [],
        }),
        quarantineInbound: async () => {},
        forTenant: (tenantId) => ({
          findMessageIdByKey: async () => null,
          upsertMessage: async (input) => {
            const rows = writes.get(tenantId) ?? [];
            rows.push(input);
            writes.set(tenantId, rows);
            return { record: { id: `${tenantId}-row`, ...input } as unknown as MessageRecord, inserted: true };
          },
        }),
      },
    });
    const result = await ingestS3Object(deps, BUCKET, OBJECT_KEY, {
      recipients: ["a@one.example", "b@two.example"],
    });
    expect(result).toMatchObject({ status: "ingested", tenant_ids: ["tenant-a", "tenant-b"] });
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(writes.get("tenant-a")?.[0]?.to_addrs).toEqual(["a@one.example"]);
    expect(writes.get("tenant-b")?.[0]?.to_addrs).toEqual(["b@two.example"]);
  });

  it("quarantines an event with no route and never fetches or writes raw mail", async () => {
    const captured: Array<{ sourceId: string; reason: string; envelopeRecipients: string[] }> = [];
    const { deps, fetched, upserts } = makeDeps({
      store: {
        resolveInboundRecipients: async (recipients) => ({ groups: [], unresolved: recipients }),
        quarantineInbound: async (input) => { captured.push(input); },
        forTenant: () => { throw new Error("must not enter a tenant"); },
      },
    });
    const result = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(result).toMatchObject({ status: "quarantined", reason: "no_tenant_route" });
    expect(fetched).toEqual([]);
    expect(upserts).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.envelopeRecipients).toEqual(["andrei@hasna.com"]);
  });

  it("leaves notifications with no object key for redrive/DLQ", async () => {
    const { deps } = makeDeps();
    const r = await processInboundNotification(deps, JSON.stringify({ hello: "world" }), BUCKET);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("no_object_key");
    expect(shouldDeleteIngestResult(r)).toBe(false);
  });

  it("does not trust a notification bucket and fails when worker bucket is missing", async () => {
    const { deps, fetched } = makeDeps();
    const r = await processInboundNotification(deps, sesNotification, undefined);
    expect(r).toMatchObject({ status: "error", reason: "no_bucket" });
    expect(fetched).toEqual([]);
    expect(shouldDeleteIngestResult(r)).toBe(false);
  });

  it("falls back to the SES timestamp when the mail has no Date header", async () => {
    const noDate = [`From: a@b.com`, `To: andrei@hasna.com`, `Subject: x`, ``, `hi`, ``].join("\r\n");
    const { deps, upserts } = makeDeps({ fetchObject: async () => Buffer.from(noDate) });
    const r = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(r.status).toBe("ingested");
    expect(upserts[0]!.received_at).toBe("2026-07-02T10:00:00.000Z"); // mail.timestamp
  });

  it("returns error (leaves message for redelivery) when S3 fetch fails", async () => {
    const { deps } = makeDeps({
      fetchObject: async () => {
        throw new Error("AccessDenied");
      },
    });
    const r = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(r.status).toBe("error");
    expect(r.error).toContain("AccessDenied");
    expect(shouldDeleteIngestResult(r)).toBe(false);
  });
});
