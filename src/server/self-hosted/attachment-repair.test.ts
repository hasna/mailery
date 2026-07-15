import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { emailsSelfHostedMigrations } from "./migrations.js";
import { EmailsSelfHostedStore } from "./store.js";
import {
  repairExistingS3ObjectAttachments,
  type AttachmentRepairDeps,
  type AttachmentRepairState,
} from "./attachment-repair.js";

const parsedAttachments = [{
  filename: "invoice.txt",
  content_type: "text/plain",
  size: 5,
  content_base64: "aGVsbG8=",
}];
const rawMime = Buffer.from("raw mime");
const canonicalProvenance = {
  tenant_id: "tenant-a",
  message_id: "message-1",
  bucket: "canonical-inbound-bucket",
  object_key: "inbound/example/message-1",
  raw_sha256: createHash("sha256").update(rawMime).digest("hex"),
  established_via: "canonical_replay" as const,
};

function fixture(overrides: {
  state?: AttachmentRepairState | null;
  fetchError?: Error;
  parsed?: typeof parsedAttachments;
  raw?: Buffer;
} = {}) {
  let state = overrides.state === undefined
    ? {
        attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }],
        provenance: canonicalProvenance,
      }
    : overrides.state;
  const before = JSON.parse(JSON.stringify({
    id: "message-1",
    is_read: false,
    is_starred: true,
    labels: ["existing"],
    body_text: "unchanged",
    updated_at: "2026-01-02T03:04:05.000Z",
    attachments: state?.attachments ?? [],
  }));
  const row = JSON.parse(JSON.stringify(before));
  let writes = 0;
  const deps: AttachmentRepairDeps = {
    canonicalBucket: canonicalProvenance.bucket,
    resolveInboundRecipients: async () => ({
      groups: [{ tenantId: "tenant-a", recipients: ["owner@example.com"] }],
      unresolved: [],
    }),
    listAttachmentRepairBindings: async (bucket, key) =>
      state?.provenance && bucket === canonicalProvenance.bucket && key === input.key
        ? [{
            tenantId: "tenant-a",
            messageId: "message-1",
            attachments: state.attachments,
            provenance: state.provenance,
          }]
        : [],
    replaceAttachmentPayloadsAtomically: async (bindings, updates) => {
      const binding = bindings[0];
      const update = updates[0];
      if (bindings.length !== 1 || updates.length !== 1 || !binding || !update) return false;
      if (binding.provenance.raw_sha256 !== canonicalProvenance.raw_sha256) return false;
      if (JSON.stringify(state?.attachments) !== JSON.stringify(update.expected)) return false;
      writes++;
      row.attachments = update.replacement;
      state = { attachments: update.replacement, provenance: binding.provenance };
      return true;
    },
    fetchObject: async () => {
      if (overrides.fetchError) throw overrides.fetchError;
      return overrides.raw ?? rawMime;
    },
    parseMime: async () => ({ attachments: overrides.parsed ?? parsedAttachments }),
  };
  return { deps, before, row, writes: () => writes };
}

const input = {
  key: "inbound/example/message-1",
  recipients: ["owner@example.com"],
  canaryMessageIds: ["message-1"],
};

function provenanceStoreClient(options: {
  inserted?: typeof canonicalProvenance | null;
  existing?: typeof canonicalProvenance | null;
}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client: TypedQueryClient = {
    async query() { return { rows: [], rowCount: 0 }; },
    async many() { return []; },
    async one() { throw new Error("not used"); },
    async execute() {},
    async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO inbound_message_sources")) {
        return (options.inserted ?? null) as T | null;
      }
      if (sql.includes("FROM inbound_message_sources")) {
        return (options.existing ?? null) as T | null;
      }
      return null;
    },
  };
  return { client, calls };
}

describe("immutable inbound source provenance", () => {
  it("records only an exact tenant/message/source binding without an update path", async () => {
    const f = provenanceStoreClient({ inserted: canonicalProvenance });
    const store = new EmailsSelfHostedStore(f.client).forTenant(canonicalProvenance.tenant_id);

    expect(await store.recordInboundSourceProvenance({
      messageId: canonicalProvenance.message_id,
      bucket: canonicalProvenance.bucket,
      objectKey: canonicalProvenance.object_key,
      rawSha256: canonicalProvenance.raw_sha256,
      establishedVia: canonicalProvenance.established_via,
    })).toBe("recorded");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.sql).toContain("INSERT INTO inbound_message_sources");
    expect(f.calls[0]?.sql).toContain("m.tenant_id = $1 AND m.id = $2");
    expect(f.calls[0]?.sql).toContain("m.source_id = $4 OR m.message_id = $4");
    expect(f.calls[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(f.calls[0]?.sql).not.toMatch(/DO\s+UPDATE/i);
    expect(f.calls[0]?.params).toEqual([
      canonicalProvenance.tenant_id,
      canonicalProvenance.message_id,
      canonicalProvenance.bucket,
      canonicalProvenance.object_key,
      canonicalProvenance.raw_sha256,
      canonicalProvenance.established_via,
    ]);
  });

  it("distinguishes an idempotent replay, a conflict, and an unbound message", async () => {
    const candidate = {
      messageId: canonicalProvenance.message_id,
      bucket: canonicalProvenance.bucket,
      objectKey: canonicalProvenance.object_key,
      rawSha256: canonicalProvenance.raw_sha256,
      establishedVia: canonicalProvenance.established_via,
    };
    const matching = provenanceStoreClient({ existing: canonicalProvenance });
    expect(await new EmailsSelfHostedStore(matching.client)
      .forTenant(canonicalProvenance.tenant_id)
      .recordInboundSourceProvenance(candidate)).toBe("existing_match");

    const conflicting = provenanceStoreClient({
      existing: { ...canonicalProvenance, bucket: "different-bucket" },
    });
    expect(await new EmailsSelfHostedStore(conflicting.client)
      .forTenant(canonicalProvenance.tenant_id)
      .recordInboundSourceProvenance(candidate)).toBe("conflict");

    const missing = provenanceStoreClient({});
    expect(await new EmailsSelfHostedStore(missing.client)
      .forTenant(canonicalProvenance.tenant_id)
      .recordInboundSourceProvenance(candidate)).toBe("not_found");
  });

  it("defines 0017 as force-RLS and rejects both UPDATE and direct DELETE", () => {
    const migration = emailsSelfHostedMigrations().find(
      (candidate) => candidate.id === "0017_inbound_message_source_provenance",
    );
    expect(migration).toBeDefined();
    expect(migration!.sql).toContain("BEFORE UPDATE OR DELETE ON inbound_message_sources");
    expect(migration!.sql).toContain("ALTER TABLE inbound_message_sources ENABLE ROW LEVEL SECURITY");
    expect(migration!.sql).toContain("ALTER TABLE inbound_message_sources FORCE ROW LEVEL SECURITY");
    expect(migration!.sql).toContain("tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid");
    expect(migration!.sql).toMatch(/FOREIGN KEY\s*\(tenant_id,\s*message_id\)\s*REFERENCES messages\s*\(tenant_id,\s*id\)/i);
    expect(migration!.sql).not.toMatch(/message_id\s+text\s+NOT NULL\s+REFERENCES messages\s*\(id\)/i);
  });

  it("keys global repair discovery and advisory locking by exact canonical bucket plus object key", async () => {
    const executeCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const manyCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const tx: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async get() { return null; },
      async one() { throw new Error("not used"); },
      async execute(sql, params = []) { executeCalls.push({ sql, params }); },
      async many<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        manyCalls.push({ sql, params });
        if (sql.includes("FROM tenants")) return [{ id: "tenant-a" }] as T[];
        if (sql.includes("FROM messages m") && sql.includes("LEFT JOIN inbound_message_sources")) {
          return [{
            tenant_id: "tenant-a",
            message_id: "message-1",
            source_tenant_id: "tenant-a",
            source_message_id: "message-1",
            bucket: canonicalProvenance.bucket,
            object_key: canonicalProvenance.object_key,
            raw_sha256: canonicalProvenance.raw_sha256,
            established_via: canonicalProvenance.established_via,
            attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }],
          }] as T[];
        }
        return [];
      },
    };
    let transactions = 0;
    const root = new EmailsSelfHostedStore({
      ...tx,
      transaction: async <T>(fn: (client: TypedQueryClient) => Promise<T>) => {
        transactions++;
        return fn(tx);
      },
    } as never);
    const binding = {
      tenantId: "tenant-a",
      messageId: "message-1",
      attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }],
      provenance: canonicalProvenance,
    };

    expect(await root.replaceAttachmentPayloadsAtomically([binding], [{
      tenantId: binding.tenantId,
      messageId: binding.messageId,
      expected: binding.attachments,
      replacement: binding.attachments,
    }])).toBe(true);
    expect(transactions).toBe(1);
    const advisoryLock = executeCalls.find((call) => call.sql.includes("pg_advisory_xact_lock"));
    expect(advisoryLock?.sql).toContain("encode($1::bytea, 'hex')");
    expect(advisoryLock?.params).toHaveLength(1);
    expect(advisoryLock?.params[0]).toBeInstanceOf(Buffer);
    expect((advisoryLock?.params[0] as Buffer).toString("utf8"))
      .toBe(`${canonicalProvenance.bucket}\0${canonicalProvenance.object_key}`);
    const bindingRead = manyCalls.find((call) =>
      call.sql.includes("FROM messages m") && call.sql.includes("LEFT JOIN inbound_message_sources"));
    expect(bindingRead?.sql).toContain("m.source_id = $2 OR m.message_id = $2");
    expect(bindingRead?.params).toEqual(["tenant-a", canonicalProvenance.object_key]);
  });

  it("rejects a subset, superset, or duplicate atomic update set before opening a transaction", async () => {
    let transactions = 0;
    const root = new EmailsSelfHostedStore({
      transaction: async () => { transactions++; throw new Error("must not open transaction"); },
    } as never);
    const second = {
      tenantId: "tenant-b",
      messageId: "message-2",
      attachments: [],
      provenance: { ...canonicalProvenance, tenant_id: "tenant-b", message_id: "message-2" },
    };
    const first = {
      tenantId: "tenant-a",
      messageId: "message-1",
      attachments: [],
      provenance: canonicalProvenance,
    };
    const update = (binding: typeof first) => ({
      tenantId: binding.tenantId,
      messageId: binding.messageId,
      expected: binding.attachments,
      replacement: binding.attachments,
    });

    expect(await root.replaceAttachmentPayloadsAtomically([first, second], [update(first)])).toBe(false);
    expect(await root.replaceAttachmentPayloadsAtomically([first], [update(first), update(first)])).toBe(false);
    expect(await root.replaceAttachmentPayloadsAtomically([first], [
      update(first),
      { tenantId: "tenant-c", messageId: "message-3", expected: [], replacement: [] },
    ])).toBe(false);
    expect(transactions).toBe(0);
  });
});

describe("historical attachment repair", () => {
  it("rejects duplicate normalized canary IDs before route, DB, or AWS reads", async () => {
    let reads = 0;
    let writes = 0;
    const deps: AttachmentRepairDeps = {
      canonicalBucket: canonicalProvenance.bucket,
      resolveInboundRecipients: async () => { reads++; throw new Error("must not route"); },
      listAttachmentRepairBindings: async () => { reads++; return []; },
      replaceAttachmentPayloadsAtomically: async () => { writes++; return true; },
      fetchObject: async () => { reads++; return rawMime; },
    };

    await expect(repairExistingS3ObjectAttachments(deps, {
      ...input,
      canaryMessageIds: ["message-1", " message-1 "],
      apply: true,
    })).rejects.toThrow(/duplicate.*canary message-id/i);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it("uses exact tenant/source binding and an attachment-only CAS without timestamp mutation", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client: TypedQueryClient = {
      async query() { return { rows: [], rowCount: 0 }; },
      async many() { return []; },
      async one() { throw new Error("not used"); },
      async execute() {},
      async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
        calls.push({ sql, params });
        if (sql.includes("SELECT m.attachments")) {
          return {
            attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }],
            source_tenant_id: canonicalProvenance.tenant_id,
            source_message_id: canonicalProvenance.message_id,
            bucket: canonicalProvenance.bucket,
            object_key: canonicalProvenance.object_key,
            raw_sha256: canonicalProvenance.raw_sha256,
            established_via: canonicalProvenance.established_via,
          } as T;
        }
        if (sql.includes("UPDATE messages SET attachments")) return { id: "message-1" } as T;
        return null;
      },
    };
    const store = new EmailsSelfHostedStore(client).forTenant("tenant-a");
    const before = [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }];
    const after = [{ ...before[0], content_base64: "aGVsbG8=" }];

    expect(await store.getAttachmentRepairState("message-1", input.key)).toEqual({
      attachments: before,
      provenance: canonicalProvenance,
    });
    expect(await store.replaceAttachmentPayload("message-1", input.key, canonicalProvenance, before, after)).toBe(true);
    expect(calls[0]?.sql).toContain("m.id = $1 AND m.tenant_id = $2");
    expect(calls[0]?.sql).toContain("m.source_id = $3 OR m.message_id = $3");
    expect(calls[0]?.sql).not.toMatch(/LIMIT\s+1/i);
    expect(calls[0]?.params).toEqual(["message-1", "tenant-a", input.key]);
    expect(calls[1]?.sql).toMatch(/^UPDATE messages SET attachments = \$1::jsonb/);
    expect(calls[1]?.sql).not.toContain("updated_at");
    expect(calls[1]?.sql).not.toContain("ON CONFLICT");
    expect(calls[1]?.params).toEqual([
      JSON.stringify(after), "message-1", "tenant-a", input.key,
      canonicalProvenance.bucket, canonicalProvenance.raw_sha256, JSON.stringify(before),
    ]);
  });

  it("is dry-run by default and requires an exact message-ID canary", async () => {
    const f = fixture();
    const result = await repairExistingS3ObjectAttachments(f.deps, input);
    expect(result.items).toEqual([{ tenant_id: "tenant-a", message_id: "message-1", status: "would_repair", attachments: 1 }]);
    expect(f.writes()).toBe(0);
    expect(f.row).toEqual(f.before);

    const denied = await repairExistingS3ObjectAttachments(f.deps, { ...input, canaryMessageIds: ["different-id"], apply: true });
    expect(denied.items[0]?.status).toBe("not_in_canary");
    expect(f.writes()).toBe(0);
  });

  it("updates only attachment payload and is idempotent", async () => {
    const f = fixture();
    const first = await repairExistingS3ObjectAttachments(f.deps, { ...input, apply: true });
    expect(first.items[0]?.status).toBe("repaired");
    expect(f.writes()).toBe(1);
    expect({ ...f.row, attachments: f.before.attachments }).toEqual(f.before);

    const second = await repairExistingS3ObjectAttachments(f.deps, { ...input, apply: true });
    expect(second.items[0]?.status).toBe("already_complete");
    expect(f.writes()).toBe(1);
  });

  it("does not mutate when S3 is missing or parsed MIME does not match metadata", async () => {
    const missing = fixture({ fetchError: new Error("NoSuchKey") });
    const failed = await repairExistingS3ObjectAttachments(missing.deps, { ...input, apply: true });
    expect(failed.items[0]?.status).toBe("error");
    expect(missing.writes()).toBe(0);
    expect(missing.row).toEqual(missing.before);

    const malformed = fixture({ parsed: [] });
    const mismatch = await repairExistingS3ObjectAttachments(malformed.deps, { ...input, apply: true });
    expect(mismatch.items[0]?.status).toBe("metadata_mismatch");
    expect(malformed.writes()).toBe(0);
    expect(malformed.row).toEqual(malformed.before);
  });

  it("does not parse or mutate an oversized source object", async () => {
    const f = fixture();
    let parsed = false;
    f.deps.fetchObject = async () => Buffer.from("ninebytes");
    f.deps.parseMime = async () => {
      parsed = true;
      return { attachments: parsedAttachments };
    };

    const result = await repairExistingS3ObjectAttachments(f.deps, {
      ...input,
      apply: true,
      maxRawBytes: 8,
    });
    expect(result.items[0]?.status).toBe("error");
    expect(parsed).toBe(false);
    expect(f.writes()).toBe(0);
    expect(f.row).toEqual(f.before);
  });

  it("reports a compare-and-swap race without overwriting concurrent state", async () => {
    const f = fixture();
    f.deps.replaceAttachmentPayloadsAtomically = async () => false;

    const result = await repairExistingS3ObjectAttachments(f.deps, { ...input, apply: true });
    expect(result.items[0]?.status).toBe("concurrent_change");
    expect(f.writes()).toBe(0);
    expect(f.row).toEqual(f.before);
  });

  it("fails closed for unresolved tenant routing and ambiguous exact canaries", async () => {
    const unresolved = fixture();
    unresolved.deps.resolveInboundRecipients = async () => ({ groups: [], unresolved: ["unknown@example.com"] });
    const denied = await repairExistingS3ObjectAttachments(unresolved.deps, { ...input, apply: true });
    expect(denied.items[0]?.status).toBe("error");
    expect(unresolved.writes()).toBe(0);

    const ambiguous = fixture();
    ambiguous.deps.listAttachmentRepairBindings = async () => [{
      tenantId: "tenant-a",
      messageId: "message-1",
      attachments: [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }],
      provenance: canonicalProvenance,
    }];
    const result = await repairExistingS3ObjectAttachments(ambiguous.deps, {
      ...input,
      canaryMessageIds: ["message-1", "message-2"],
      apply: true,
    });
    expect(result.items[0]?.status).toBe("not_in_canary");
    expect(ambiguous.writes()).toBe(0);
    expect(ambiguous.row).toEqual(ambiguous.before);
  });

  it("rejects when trusted routes omit or add a tenant relative to persisted bindings", async () => {
    const f = fixture();
    f.deps.resolveInboundRecipients = async () => ({
      groups: [
        { tenantId: "tenant-a", recipients: ["a@example.com"] },
        { tenantId: "tenant-b", recipients: ["b@example.com"] },
      ],
      unresolved: [],
    });

    const result = await repairExistingS3ObjectAttachments(f.deps, { ...input, apply: true });
    expect(result.items.every((item) => item.status === "ambiguous_binding")).toBe(true);
    expect(f.writes()).toBe(0);
    expect(f.row).toEqual(f.before);
  });

  it("never accepts wrong-source bytes with the same key and attachment metadata", async () => {
    const f = fixture({ raw: Buffer.from("forged wrong-bucket MIME bytes") });
    const fetched: string[] = [];
    const originalFetch = f.deps.fetchObject;
    f.deps.fetchObject = async (bucket, key) => {
      fetched.push(`${bucket}/${key}`);
      return originalFetch(bucket, key);
    };
    const result = await repairExistingS3ObjectAttachments(f.deps, { ...input, apply: true });
    expect(result.items[0]?.status).not.toBe("repaired");
    expect(fetched).toEqual([`${canonicalProvenance.bucket}/${canonicalProvenance.object_key}`]);
    expect(f.writes()).toBe(0);
    expect(f.row).toEqual(f.before);
  });

  it("preflights the complete global binding set and atomically repairs permitted same-object rows", async () => {
    const secondProvenance = {
      ...canonicalProvenance,
      tenant_id: "tenant-b",
      message_id: "message-2",
    };
    const missing = [{ filename: "invoice.txt", content_type: "text/plain", size: 5 }];
    let atomicCalls = 0;
    let writes = 0;
    const deps = {
      canonicalBucket: canonicalProvenance.bucket,
      resolveInboundRecipients: async () => ({
        groups: [
          { tenantId: "tenant-a", recipients: ["a@example.com"] },
          { tenantId: "tenant-b", recipients: ["b@example.com"] },
        ],
        unresolved: [],
      }),
      listAttachmentRepairBindings: async (bucket: string, key: string) => {
        expect(bucket).toBe(canonicalProvenance.bucket);
        expect(key).toBe(canonicalProvenance.object_key);
        return [
        { tenantId: "tenant-a", messageId: "message-1", attachments: missing, provenance: canonicalProvenance },
        { tenantId: "tenant-b", messageId: "message-2", attachments: missing, provenance: secondProvenance },
        ];
      },
      replaceAttachmentPayloadsAtomically: async (_bindings: unknown[], updates: unknown[]) => {
        atomicCalls++;
        writes += updates.length;
        return true;
      },
      fetchObject: async () => rawMime,
      parseMime: async () => ({ attachments: parsedAttachments }),
    } as unknown as AttachmentRepairDeps;

    const result = await repairExistingS3ObjectAttachments(deps, {
      ...input,
      recipients: ["a@example.com", "b@example.com"],
      canaryMessageIds: ["message-1", "message-2"],
      apply: true,
    });
    expect(result.items.map((item) => [item.tenant_id, item.message_id, item.status])).toEqual([
      ["tenant-a", "message-1", "repaired"],
      ["tenant-b", "message-2", "repaired"],
    ]);
    expect(atomicCalls).toBe(1);
    expect(writes).toBe(2);
  });

  it("rejects a canary that omits any globally persisted same-object binding", async () => {
    let fetched = false;
    let writes = 0;
    const deps = {
      canonicalBucket: canonicalProvenance.bucket,
      resolveInboundRecipients: async () => ({
        groups: [
          { tenantId: "tenant-a", recipients: ["a@example.com"] },
          { tenantId: "tenant-b", recipients: ["b@example.com"] },
        ],
        unresolved: [],
      }),
      listAttachmentRepairBindings: async () => [
        { tenantId: "tenant-a", messageId: "message-1", attachments: [], provenance: canonicalProvenance },
        {
          tenantId: "tenant-b",
          messageId: "message-2",
          attachments: [],
          provenance: { ...canonicalProvenance, tenant_id: "tenant-b", message_id: "message-2" },
        },
      ],
      replaceAttachmentPayloadsAtomically: async () => { writes++; return true; },
      fetchObject: async () => { fetched = true; return rawMime; },
    } as unknown as AttachmentRepairDeps;

    const result = await repairExistingS3ObjectAttachments(deps, {
      ...input,
      recipients: ["a@example.com", "b@example.com"],
      canaryMessageIds: ["message-1"],
      apply: true,
    });
    expect(result.items.every((item) => item.status === "not_in_canary")).toBe(true);
    expect(fetched).toBe(false);
    expect(writes).toBe(0);
  });
});
