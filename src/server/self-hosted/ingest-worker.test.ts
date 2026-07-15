import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  attachmentRepairResultSucceeded,
  finalizeInboundProvenanceAudit,
  finalizeAttachmentRepairCanary,
  ingestS3Object,
  inboundProvenanceAuditSucceeded,
  processInboundNotification,
  redactedInboundProvenanceAuditReport,
  redactedInboundProvenanceFenceReport,
  redactedAttachmentRepairReport,
  shouldDeleteIngestResult,
  validateAttachmentRepairCanaryOptions,
  validateInboundProvenanceAuditOptions,
  validateIngestWorkerConfig,
  type IngestDeps,
} from "./ingest-worker.js";
import type { InboundSourceProvenance, MessageInput, MessageRecord } from "./store.js";

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

function makeDeps(overrides: Partial<IngestDeps> & {
  existing?: string | null;
  provenance?: InboundSourceProvenance | null;
} = {}): {
  deps: IngestDeps;
  upserts: MessageInput[];
  fetched: string[];
  quarantines: Array<{ sourceId: string; reason: string; envelopeRecipients: string[] }>;
  provenances: Array<{ messageId: string; bucket: string; objectKey: string; rawSha256: string }>;
} {
  const upserts: MessageInput[] = [];
  const fetched: string[] = [];
  const quarantines: Array<{ sourceId: string; reason: string; envelopeRecipients: string[] }> = [];
  const provenances: Array<{ messageId: string; bucket: string; objectKey: string; rawSha256: string }> = [];
  const deps: IngestDeps = {
    store: {
      resolveInboundRecipients: async (recipients) => ({
        groups: recipients.length > 0 ? [{ tenantId: "tenant-a", recipients }] : [],
        unresolved: recipients.length > 0 ? [] : recipients,
      }),
      quarantineInbound: async (input) => { quarantines.push(input); },
      forTenant: () => ({
        findMessageIdByKey: async () => overrides.existing ?? null,
        getInboundSourceProvenance: async () => overrides.provenance ?? null,
        recordInboundSourceProvenance: async (input) => {
          provenances.push(input);
          return "recorded" as const;
        },
        createInboundMessageWithProvenance: async (input: MessageInput, provenance) => {
          upserts.push(input);
          provenances.push({ messageId: "row-1", ...provenance });
          return {
            record: { id: "row-1", ...input } as unknown as MessageRecord,
            inserted: true,
            provenance: "recorded" as const,
          };
        },
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
  return { deps, upserts, fetched, quarantines, provenances };
}

describe("processInboundNotification", () => {
  it("keeps the database-clock fence report aggregate and identity-free", () => {
    const fenceAt = "2026-07-15T13:00:00.123Z";
    const report = redactedInboundProvenanceFenceReport(fenceAt);
    expect(report).toEqual({ fence_at: fenceAt });
    expect(Object.keys(report)).toEqual(["fence_at"]);
  });

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
    const { deps, upserts, fetched, provenances } = makeDeps();
    const r = await processInboundNotification(deps, sesNotification, BUCKET);

    expect(r.status).toBe("ingested");
    expect(r.key).toBe(OBJECT_KEY);
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(upserts).toHaveLength(1);
    expect(provenances).toHaveLength(1);
    expect(provenances[0]).toMatchObject({
      messageId: "row-1",
      bucket: BUCKET,
      objectKey: OBJECT_KEY,
      rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

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

  it("persists a new message and its immutable provenance through one atomic store operation", async () => {
    let atomicCalls = 0;
    const { deps } = makeDeps({
      store: {
        resolveInboundRecipients: async (recipients) => ({
          groups: [{ tenantId: "tenant-a", recipients }],
          unresolved: [],
        }),
        quarantineInbound: async () => {},
        forTenant: () => ({
          findMessageIdByKey: async () => null,
          getInboundSourceProvenance: async () => null,
          recordInboundSourceProvenance: async () => { throw new Error("new-message provenance must be atomic"); },
          upsertMessage: async () => { throw new Error("new-message upsert must not precede provenance"); },
          createInboundMessageWithProvenance: async (input: MessageInput) => {
            atomicCalls++;
            return {
              record: { id: "atomic-row", ...input } as unknown as MessageRecord,
              inserted: true,
              provenance: "recorded" as const,
            };
          },
        }),
      } as unknown as IngestDeps["store"],
    });

    const result = await ingestS3Object(deps, BUCKET, OBJECT_KEY, { recipients: ["andrei@hasna.com"] });
    expect(result).toMatchObject({ status: "ingested", id: "atomic-row", inserted: true });
    expect(atomicCalls).toBe(1);
  });

  it("bootstraps missing legacy provenance only through the configured ingestion bucket", async () => {
    const { deps, upserts, fetched, provenances } = makeDeps({ existing: "existing-row" });
    const r = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(r.status).toBe("duplicate");
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(upserts).toEqual([]);
    expect(provenances).toHaveLength(1);
    expect(provenances[0]).toMatchObject({
      messageId: "existing-row",
      bucket: BUCKET,
      objectKey: OBJECT_KEY,
      rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("fails before fetch when existing provenance names another bucket", async () => {
    const { deps, fetched, upserts, provenances } = makeDeps({
      existing: "existing-row",
      provenance: {
        tenant_id: "tenant-a",
        message_id: "existing-row",
        bucket: "wrong-bucket",
        object_key: OBJECT_KEY,
        raw_sha256: "a".repeat(64),
        established_via: "normal_ingest",
      },
    });
    const result = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(result).toMatchObject({ status: "error", reason: "provenance_conflict" });
    expect(fetched).toEqual([]);
    expect(upserts).toEqual([]);
    expect(provenances).toEqual([]);
    expect(shouldDeleteIngestResult(result)).toBe(false);
  });

  it("fetches and hash-validates an exact existing provenance binding before a terminal duplicate", async () => {
    const rawSha256 = createHash("sha256").update(rawEmail).digest("hex");
    const { deps, fetched, upserts, provenances } = makeDeps({
      existing: "existing-row",
      provenance: {
        tenant_id: "tenant-a",
        message_id: "existing-row",
        bucket: BUCKET,
        object_key: OBJECT_KEY,
        raw_sha256: rawSha256,
        established_via: "normal_ingest",
      },
    });
    const result = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(result).toMatchObject({ status: "duplicate", id: "existing-row", inserted: false });
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(upserts).toEqual([]);
    expect(provenances).toEqual([]);
    expect(shouldDeleteIngestResult(result)).toBe(true);
  });

  it("leaves a fully provenanced duplicate for redelivery when canonical bytes changed", async () => {
    const { deps, fetched, upserts, provenances } = makeDeps({
      existing: "existing-row",
      provenance: {
        tenant_id: "tenant-a",
        message_id: "existing-row",
        bucket: BUCKET,
        object_key: OBJECT_KEY,
        raw_sha256: "a".repeat(64),
        established_via: "normal_ingest",
      },
    });
    const result = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(result).toMatchObject({ status: "error", reason: "provenance_hash_mismatch" });
    expect(fetched).toEqual([`${BUCKET}/${OBJECT_KEY}`]);
    expect(upserts).toEqual([]);
    expect(provenances).toEqual([]);
    expect(shouldDeleteIngestResult(result)).toBe(false);
  });

  it("leaves a fully provenanced duplicate for redelivery when canonical fetch fails", async () => {
    let fetches = 0;
    const { deps, upserts, provenances } = makeDeps({
      existing: "existing-row",
      provenance: {
        tenant_id: "tenant-a",
        message_id: "existing-row",
        bucket: BUCKET,
        object_key: OBJECT_KEY,
        raw_sha256: createHash("sha256").update(rawEmail).digest("hex"),
        established_via: "normal_ingest",
      },
      fetchObject: async () => {
        fetches++;
        throw new Error("AccessDenied");
      },
    });
    const result = await processInboundNotification(deps, sesNotification, BUCKET);
    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("AccessDenied") });
    expect(fetches).toBe(1);
    expect(upserts).toEqual([]);
    expect(provenances).toEqual([]);
    expect(shouldDeleteIngestResult(result)).toBe(false);
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
          getInboundSourceProvenance: async () => null,
          recordInboundSourceProvenance: async () => "recorded" as const,
          createInboundMessageWithProvenance: async (input) => {
            const rows = writes.get(tenantId) ?? [];
            rows.push(input);
            writes.set(tenantId, rows);
            return {
              record: { id: `${tenantId}-row`, ...input } as unknown as MessageRecord,
              inserted: true,
              provenance: "recorded" as const,
            };
          },
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

describe("attachment repair runner boundary", () => {
  const options = {
    objectKeys: [OBJECT_KEY],
    recipients: ["andrei@hasna.com"],
    canaryMessageIds: ["message-1"],
  };
  const successful = {
    key: OBJECT_KEY,
    apply: false,
    items: [{ tenant_id: "tenant-a", message_id: "message-1", status: "would_repair" as const, attachments: 1 }],
  };

  it("rejects multiple keys and duplicate normalized IDs but preserves a complete unique same-object message set", () => {
    expect(() => validateAttachmentRepairCanaryOptions({ ...options, objectKeys: ["one", "two"], apply: true }))
      .toThrow(/exactly one --object-key/);
    expect(() => validateAttachmentRepairCanaryOptions({ ...options, objectKeys: ["one", "one"], apply: true }))
      .toThrow(/exactly one --object-key/);
    expect(() => validateAttachmentRepairCanaryOptions({ ...options, canaryMessageIds: ["one", "two", " one "], apply: true }))
      .toThrow(/duplicate.*message-id/i);
    expect(validateAttachmentRepairCanaryOptions({ ...options, canaryMessageIds: ["two", " one "], apply: true }))
      .toEqual({ objectKey: OBJECT_KEY, messageIds: ["two", "one"] });
    expect(() => validateAttachmentRepairCanaryOptions({ ...options, canaryMessageIds: [], apply: true }))
      .toThrow(/at least one --message-id/);
  });

  it("emits item-level redacted output and throws for every non-success result", () => {
    const emitted: string[] = [];
    expect(finalizeAttachmentRepairCanary(successful, (line) => emitted.push(line))).toEqual([successful]);
    const report = JSON.parse(emitted[0]!) as Record<string, unknown>;
    expect(report).not.toHaveProperty("key");
    expect(JSON.stringify(report)).not.toContain(OBJECT_KEY);
    expect(report).toHaveProperty("object_key_sha256");
    expect(report).toHaveProperty("items");

    for (const status of ["not_found", "not_in_canary", "ambiguous_binding", "metadata_mismatch", "concurrent_change", "error"] as const) {
      const failure = { ...successful, items: [{ tenant_id: "tenant-a", status }] };
      expect(attachmentRepairResultSucceeded(failure)).toBe(false);
      expect(() => finalizeAttachmentRepairCanary(failure, () => {})).toThrow(/did not complete/);
    }
  });

  it("server entrypoints reject bucket overrides and multi-key apply with nonzero exits before DB/AWS", () => {
    const run = (extra: string[]) => Bun.spawnSync({
      cmd: [process.execPath, "run", "src/server/index.ts", "attachment-repair-canary", ...extra],
      cwd: process.cwd(),
      env: { ...process.env, EMAILS_DATABASE_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const common = ["--message-id", "message-1", "--recipient", "andrei@hasna.com", "--apply"];
    const multiple = run(["--object-key", "one", "--object-key", "two", ...common]);
    expect(multiple.exitCode).not.toBe(0);
    expect(multiple.stderr.toString()).toContain("exactly one --object-key");
    const bucket = run(["--object-key", "one", "--bucket", "wrong", ...common]);
    expect(bucket.exitCode).not.toBe(0);
    expect(bucket.stderr.toString()).toContain("does not accept --bucket");
    const duplicateIds = run([
      "--object-key", "one",
      "--message-id", "message-1",
      "--message-id", " message-1 ",
      "--recipient", "andrei@hasna.com",
      "--apply",
    ]);
    expect(duplicateIds.exitCode).not.toBe(0);
    expect(duplicateIds.stderr.toString()).toMatch(/duplicate.*message-id/i);

    for (const command of ["ingest-worker", "ingest-s3-backfill"]) {
      const canonicalOnly = Bun.spawnSync({
        cmd: [process.execPath, "run", "src/server/index.ts", command, "--bucket", "wrong"],
        cwd: process.cwd(),
        env: { ...process.env, EMAILS_DATABASE_URL: "", EMAILS_INGEST_S3_BUCKET: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(canonicalOnly.exitCode).not.toBe(0);
      expect(canonicalOnly.stderr.toString()).toContain("does not accept --bucket");
    }
  });
});

describe("post-fence inbound provenance audit boundary", () => {
  const clean = {
    since: "2026-07-15T11:00:00.000Z",
    tenants_scanned: 3,
    candidate_messages: 12,
    valid_provenance: 12,
    missing_provenance: 0,
    invalid_provenance: 0,
  };

  it("requires one explicit valid ISO cutoff before any database access", () => {
    expect(validateInboundProvenanceAuditOptions({ since: "2026-07-15T11:00:00Z" }))
      .toEqual({ since: "2026-07-15T11:00:00.000Z" });
    expect(validateInboundProvenanceAuditOptions({ since: "2026-07-15T13:00:00+02:00" }))
      .toEqual({ since: "2026-07-15T11:00:00.000Z" });
    expect(() => validateInboundProvenanceAuditOptions({ since: "" })).toThrow(/--since/);
    expect(() => validateInboundProvenanceAuditOptions({ since: "not-a-date" })).toThrow(/ISO 8601/);
    expect(() => validateInboundProvenanceAuditOptions({ since: "07/15/2026 11:00:00" })).toThrow(/ISO 8601/);
    expect(() => validateInboundProvenanceAuditOptions({ since: "2026-07-15" })).toThrow(/ISO 8601/);
    expect(() => validateInboundProvenanceAuditOptions({ since: "2026-02-30T11:00:00Z" })).toThrow(/ISO 8601/);
    expect(() => validateInboundProvenanceAuditOptions({ since: "2026-07-15T24:00:00Z" })).toThrow(/ISO 8601/);
  });

  it("emits aggregate-only output and fails nonzero semantics for every gap", () => {
    const emitted: string[] = [];
    expect(inboundProvenanceAuditSucceeded(clean)).toBe(true);
    expect(finalizeInboundProvenanceAudit(clean, (line) => emitted.push(line))).toEqual(clean);
    expect(JSON.parse(emitted[0]!)).toEqual({
      status: "pass",
      ...clean,
      gaps: 0,
    });

    const gap = { ...clean, valid_provenance: 10, missing_provenance: 1, invalid_provenance: 1 };
    expect(inboundProvenanceAuditSucceeded(gap)).toBe(false);
    expect(redactedInboundProvenanceAuditReport(gap)).toEqual({
      status: "fail",
      ...gap,
      gaps: 2,
    });
    expect(() => finalizeInboundProvenanceAudit(gap, () => {})).toThrow(/provenance audit found 2 gap/i);
    expect(JSON.stringify(redactedInboundProvenanceAuditReport(gap))).not.toMatch(/tenant-[a-z]|object[_-]?key|message[_-]?id|recipient|subject|content/i);
  });
});
