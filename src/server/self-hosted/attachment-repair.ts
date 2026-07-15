import {
  MAX_ATTACHMENT_DOWNLOAD_BYTES,
  decodeAttachmentPayload,
} from "../../lib/attachment-download.js";
import { parseInboundMime } from "../../lib/inbound-mime.js";
import { createHash } from "node:crypto";
import type {
  InboundAttachmentRepairBinding,
  InboundAttachmentRepairUpdate,
  InboundSourceProvenance,
} from "./store.js";

export const MAX_ATTACHMENT_REPAIR_RAW_BYTES = 128 * 1024 * 1024;

export interface AttachmentRepairState {
  attachments: unknown[];
  provenance: InboundSourceProvenance | null;
}

export interface AttachmentRepairTenantStore {
  /** Exact tenant + message id + upstream object-key binding. */
  getAttachmentRepairState(messageId: string, sourceKey: string): Promise<AttachmentRepairState | null>;
  /** Compare-and-swap only the attachments JSON; no timestamp or other column. */
  replaceAttachmentPayload(
    messageId: string,
    sourceKey: string,
    provenance: InboundSourceProvenance,
    expected: unknown[],
    replacement: unknown[],
  ): Promise<boolean>;
}

export interface AttachmentRepairDeps {
  /** Deployment-owned canonical ingest bucket; never caller supplied. */
  canonicalBucket: string;
  resolveInboundRecipients(recipients: string[]): Promise<{
    groups: Array<{ tenantId: string; recipients: string[] }>;
    unresolved: string[];
  }>;
  /** Complete persisted set across every tenant, independent of supplied recipients. */
  listAttachmentRepairBindings(bucket: string, sourceKey: string): Promise<InboundAttachmentRepairBinding[]>;
  /** Recheck the complete set and commit every CAS in one transaction. */
  replaceAttachmentPayloadsAtomically(
    expectedBindings: readonly InboundAttachmentRepairBinding[],
    updates: readonly InboundAttachmentRepairUpdate[],
  ): Promise<boolean>;
  fetchObject(bucket: string, key: string): Promise<Buffer>;
  parseMime?: (raw: Buffer) => Promise<{ attachments: unknown[] }>;
}

export interface AttachmentRepairInput {
  key: string;
  recipients: string[];
  canaryMessageIds: string[];
  /** False by default. True is allowed only after exact-ID dry-run review. */
  apply?: boolean;
  /** Testable/operator guard; it may only lower the hard source-object cap. */
  maxRawBytes?: number;
}

export type AttachmentRepairItemStatus =
  | "would_repair"
  | "repaired"
  | "already_complete"
  | "not_found"
  | "not_in_canary"
  | "ambiguous_binding"
  | "metadata_mismatch"
  | "concurrent_change"
  | "error";

export interface AttachmentRepairItem {
  tenant_id: string;
  message_id?: string;
  status: AttachmentRepairItemStatus;
  attachments?: number;
  reason?: string;
}

export interface AttachmentRepairResult {
  key: string;
  apply: boolean;
  items: AttachmentRepairItem[];
}

/**
 * Normalize the exact-ID canary without changing its caller-provided order.
 * Repeating an ID after trimming is an operator input error, never an implicit
 * request to collapse the canary set.
 */
export function normalizeAttachmentRepairCanaryMessageIds(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const messageId of normalized) {
    if (seen.has(messageId)) {
      throw new Error("attachment repair rejects duplicate normalized canary message-id values");
    }
    seen.add(messageId);
  }
  return normalized;
}

type AttachmentMetadata = { filename: string; content_type: string; size: number };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadata(value: unknown): AttachmentMetadata | null {
  const item = record(value);
  if (!item) return null;
  if (typeof item["filename"] !== "string" || typeof item["content_type"] !== "string") return null;
  if (!Number.isSafeInteger(item["size"]) || Number(item["size"]) < 0) return null;
  return {
    filename: item["filename"],
    content_type: item["content_type"],
    size: Number(item["size"]),
  };
}

function sameMetadata(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  return left.every((value, index) => {
    const a = metadata(value);
    const b = metadata(right[index]);
    return Boolean(a && b && a.filename === b.filename && a.content_type === b.content_type && a.size === b.size);
  });
}

function contentState(attachments: unknown[]): "complete" | "missing" | "invalid" {
  if (attachments.length === 0) return "invalid";
  let missing = false;
  for (let index = 0; index < attachments.length; index++) {
    const item = record(attachments[index]);
    if (!item || !metadata(item)) return "invalid";
    if (typeof item["content_base64"] !== "string") {
      missing = true;
      continue;
    }
    try {
      const decoded = decodeAttachmentPayload({ attachment: item }, index, MAX_ATTACHMENT_DOWNLOAD_BYTES);
      if (decoded.state !== "available") return "invalid";
    } catch {
      return "invalid";
    }
  }
  return missing ? "missing" : "complete";
}

function replacementPayload(existing: unknown[], parsed: unknown[]): unknown[] | null {
  if (!sameMetadata(existing, parsed)) return null;
  const replacement: unknown[] = [];
  for (let index = 0; index < existing.length; index++) {
    const oldRecord = record(existing[index]);
    const parsedRecord = record(parsed[index]);
    if (!oldRecord || !parsedRecord || typeof parsedRecord["content_base64"] !== "string") return null;
    try {
      const parsedContent = decodeAttachmentPayload({ attachment: parsedRecord }, index, MAX_ATTACHMENT_DOWNLOAD_BYTES);
      if (parsedContent.state !== "available") return null;
      if (typeof oldRecord["content_base64"] === "string") {
        const oldContent = decodeAttachmentPayload({ attachment: oldRecord }, index, MAX_ATTACHMENT_DOWNLOAD_BYTES);
        if (oldContent.state !== "available" || oldContent.sha256 !== parsedContent.sha256) return null;
      }
    } catch {
      return null;
    }
    replacement.push({ ...oldRecord, content_base64: parsedRecord["content_base64"] });
  }
  return replacement;
}

/**
 * Repair attachment payloads for one exact S3 object without using the generic
 * message upsert path. A non-empty exact-ID canary is mandatory and dry-run is
 * the default. All reads/updates remain tenant scoped.
 */
export async function repairExistingS3ObjectAttachments(
  deps: AttachmentRepairDeps,
  input: AttachmentRepairInput,
): Promise<AttachmentRepairResult> {
  const apply = input.apply === true;
  if (!input.key.trim()) throw new Error("attachment repair requires an exact object key");
  if (!deps.canonicalBucket.trim()) throw new Error("attachment repair requires the deployment canonical bucket");
  const canaryIds = normalizeAttachmentRepairCanaryMessageIds(input.canaryMessageIds);
  if (canaryIds.length === 0) throw new Error("attachment repair requires at least one exact canary message id");
  const maxRawBytes = input.maxRawBytes ?? MAX_ATTACHMENT_REPAIR_RAW_BYTES;
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0 || maxRawBytes > MAX_ATTACHMENT_REPAIR_RAW_BYTES) {
    throw new Error(`attachment repair source byte limit must be between 1 and ${MAX_ATTACHMENT_REPAIR_RAW_BYTES}`);
  }

  const route = await deps.resolveInboundRecipients(input.recipients);
  const result: AttachmentRepairResult = { key: input.key, apply, items: [] };
  if (route.unresolved.length > 0 || route.groups.length === 0) {
    result.items.push({ tenant_id: "unresolved", status: "error", reason: "recipient route is incomplete" });
    return result;
  }

  let bindings: InboundAttachmentRepairBinding[];
  try {
    bindings = await deps.listAttachmentRepairBindings(deps.canonicalBucket, input.key);
  } catch (error) {
    result.items.push({
      tenant_id: "unresolved",
      status: "error",
      reason: error instanceof Error ? error.message : "persisted object bindings could not be read",
    });
    return result;
  }
  bindings.sort((left, right) =>
    `${left.tenantId}\0${left.messageId}`.localeCompare(`${right.tenantId}\0${right.messageId}`));
  if (bindings.length === 0) {
    for (const group of route.groups) result.items.push({ tenant_id: group.tenantId, status: "not_found" });
    return result;
  }

  const routeTenantIds = new Set(route.groups.map((group) => group.tenantId));
  const bindingTenantIds = new Set(bindings.map((binding) => binding.tenantId));
  const bindingIds = new Set(bindings.map((binding) => binding.messageId));
  const exactRouteSet = routeTenantIds.size === bindingTenantIds.size
    && [...routeTenantIds].every((tenantId) => bindingTenantIds.has(tenantId));
  const exactCanarySet = bindingIds.size === bindings.length
    && bindingIds.size === canaryIds.length
    && canaryIds.every((messageId) => bindingIds.has(messageId));
  if (!exactRouteSet) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "ambiguous_binding",
        reason: "trusted recipient routes do not equal the complete persisted object binding set",
      });
    }
    return result;
  }
  if (!exactCanarySet) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "not_in_canary",
        reason: "the canary does not equal the complete persisted object binding set",
      });
    }
    return result;
  }

  const firstProvenance = bindings[0]!.provenance;
  const validBindings = bindings.every((binding) =>
    binding.provenance.tenant_id === binding.tenantId
      && binding.provenance.message_id === binding.messageId
      && binding.provenance.object_key === input.key
      && binding.provenance.bucket === deps.canonicalBucket
      && binding.provenance.bucket === firstProvenance.bucket
      && binding.provenance.raw_sha256 === firstProvenance.raw_sha256
      && /^[0-9a-f]{64}$/.test(binding.provenance.raw_sha256));
  if (!validBindings) {
    for (const binding of bindings) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "ambiguous_binding",
        reason: "persisted rows do not bind to one immutable object and byte digest",
      });
    }
    return result;
  }

  const states = bindings.map((binding) => ({ binding, state: contentState(binding.attachments) }));
  if (states.some(({ state }) => state === "invalid")) {
    for (const { binding, state } of states) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: state === "invalid" ? "error" : state === "complete" ? "already_complete" : "error",
        attachments: binding.attachments.length,
        ...(state === "invalid" ? { reason: "existing attachment metadata is invalid" } : {}),
      });
    }
    return result;
  }
  const missing = states.filter(({ state }) => state === "missing");
  if (missing.length === 0) {
    for (const { binding } of states) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: "already_complete",
        attachments: binding.attachments.length,
      });
    }
    return result;
  }

  let parsed: { attachments: unknown[] };
  try {
    const raw = await deps.fetchObject(firstProvenance.bucket, firstProvenance.object_key);
    if (raw.byteLength === 0) throw new Error("S3 object is empty");
    if (raw.byteLength > maxRawBytes) throw new Error(`S3 object exceeds attachment repair source byte limit ${maxRawBytes}`);
    const rawSha256 = createHash("sha256").update(raw).digest("hex");
    if (rawSha256 !== firstProvenance.raw_sha256) throw new Error("S3 object bytes do not match immutable canonical source provenance");
    parsed = await (deps.parseMime ?? parseInboundMime)(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "attachment source could not be read";
    for (const binding of bindings) {
      result.items.push({ tenant_id: binding.tenantId, message_id: binding.messageId, status: "error", reason });
    }
    return result;
  }

  const updates: InboundAttachmentRepairUpdate[] = [];
  for (const { binding, state } of states) {
    const replacement = state === "complete"
      ? binding.attachments
      : replacementPayload(binding.attachments, parsed.attachments);
    if (!replacement) {
      for (const candidate of bindings) {
        result.items.push({
          tenant_id: candidate.tenantId,
          message_id: candidate.messageId,
          status: "metadata_mismatch",
          reason: "parsed attachment count/order/metadata/content does not match every stored row",
        });
      }
      return result;
    }
    updates.push({
      tenantId: binding.tenantId,
      messageId: binding.messageId,
      expected: binding.attachments,
      replacement,
    });
  }
  if (!apply) {
    for (const { binding, state } of states) {
      result.items.push({
        tenant_id: binding.tenantId,
        message_id: binding.messageId,
        status: state === "complete" ? "already_complete" : "would_repair",
        attachments: binding.attachments.length,
      });
    }
    return result;
  }
  const updated = await deps.replaceAttachmentPayloadsAtomically(bindings, updates);
  for (const { binding, state } of states) {
    result.items.push({
      tenant_id: binding.tenantId,
      message_id: binding.messageId,
      status: state === "complete" ? "already_complete" : updated ? "repaired" : "concurrent_change",
      attachments: binding.attachments.length,
    });
  }
  return result;
}
