import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerS3Source,
  retireS3Source,
  listS3Sources,
  listLiveS3Sources,
} from "./s3-sync.js";
import { syncS3Inbox } from "./s3-sync.remote.js";
import { s3SyncLocalTestBoundary } from "./s3-sync.local.js";

// S3 → mailbox ingestion (syncS3Inbox) runs on the self-hosted server: the thin
// client has no local inbound store to write into, so it is a loud stub. The S3
// *source registry* (register/list/retire) is pure client config backed by the
// local config file with no database dependency, so it remains functional and is
// covered here.

const originalHome = process.env["HOME"];
let tmpHome = "";

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "emails-s3-source-"));
  process.env["HOME"] = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe("syncS3Inbox (self-hosted stub)", () => {
  it("throws because S3 inbound ingestion runs on the self-hosted server", async () => {
    await expect(syncS3Inbox({ bucket: "test-bucket", providerId: "p1" })).rejects.toThrow(
      /syncS3Inbox is not available in the self-hosted client/,
    );
  });

  it("throws for a source-id driven sync too", async () => {
    await expect(syncS3Inbox({ sourceId: "s3-anything" })).rejects.toThrow(
      /S3 inbound ingestion runs on the self-hosted server/,
    );
  });
});

describe("local S3 attachment storage planning", () => {
  it("keeps colliding sanitized names in distinct indexed local paths and S3 keys", () => {
    const plans = s3SyncLocalTestBoundary.buildAttachmentStoragePlans([
      {
        filename: "invoice?.pdf",
        contentType: "application/pdf",
        size: 5,
        content: Buffer.from("first"),
      },
      {
        filename: "invoice*.pdf",
        contentType: "application/pdf",
        size: 6,
        content: Buffer.from("second"),
      },
    ]);

    expect(plans.map((plan) => plan.index)).toEqual([0, 1]);
    expect(plans.map((plan) => plan.filename)).toEqual(["invoice?.pdf", "invoice*.pdf"]);
    expect(new Set(plans.map((plan) => plan.storageLeaf)).size).toBe(2);
    expect(plans[0]!.storageLeaf).toStartWith("000000-");
    expect(plans[1]!.storageLeaf).toStartWith("000001-");
    expect(plans.every((plan) => Buffer.byteLength(plan.storageLeaf, "utf8") <= 240)).toBe(true);

    const outputDir = join(tmpHome, "stored-attachments");
    mkdirSync(outputDir, { recursive: true });
    const paths = plans.map((plan) => s3SyncLocalTestBoundary.storeLocalAttachment(plan, outputDir));
    expect(paths.map((path) => path.index)).toEqual([0, 1]);
    expect(paths.map((path) => path.filename)).toEqual(["invoice?.pdf", "invoice*.pdf"]);
    expect(new Set(paths.map((path) => path.local_path)).size).toBe(2);
    expect(readFileSync(paths[0]!.local_path!, "utf8")).toBe("first");
    expect(readFileSync(paths[1]!.local_path!, "utf8")).toBe("second");

    const keys = plans.map((plan) =>
      s3SyncLocalTestBoundary.attachmentS3Key("mail/", "message-id", plan.storageLeaf));
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.startsWith("mail/message-id/"))).toBe(true);
  });
});

describe("S3 source registry (client config)", () => {
  it("registers a source and lists it back", () => {
    const source = registerS3Source({
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "eu-west-1",
      providerId: "prov-1",
      status: "live",
      liveSyncEnabled: true,
    });

    expect(source).toMatchObject({
      type: "s3",
      bucket: "inbound-bucket",
      prefix: "inbound/example.com/",
      region: "eu-west-1",
      provider_id: "prov-1",
      status: "live",
      live_sync_enabled: true,
    });

    const listed = listS3Sources();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ bucket: "inbound-bucket", status: "live" });
  });

  it("dedupes by bucket + prefix and preserves created_at on update", () => {
    const first = registerS3Source({ bucket: "b", prefix: "inbound/", providerId: "p1", status: "live" });
    const second = registerS3Source({ bucket: "b", prefix: "inbound/", providerId: "p2", status: "live" });

    const listed = listS3Sources();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider_id).toBe("p2");
    expect(second.created_at).toBe(first.created_at);
  });

  it("only surfaces live sources from listLiveS3Sources", () => {
    registerS3Source({ id: "s3-live", bucket: "live-bucket", prefix: "a/", providerId: "p1", status: "live", liveSyncEnabled: true });
    registerS3Source({ id: "s3-legacy", bucket: "legacy-bucket", prefix: "b/", providerId: "p1", status: "legacy" });

    const live = listLiveS3Sources();
    expect(live.map((s) => s.id)).toEqual(["s3-live"]);
  });

  it("retires a source so it drops out of the live set", () => {
    const source = registerS3Source({ id: "s3-retire", bucket: "retire-bucket", prefix: "inbound/", providerId: "p1", status: "live", liveSyncEnabled: true });
    expect(listLiveS3Sources().map((s) => s.id)).toEqual(["s3-retire"]);

    const retired = retireS3Source(source.id);
    expect(retired.status).toBe("retired");
    expect(retired.live_sync_enabled).toBe(false);
    expect(listLiveS3Sources()).toHaveLength(0);
    expect(listS3Sources().map((s) => s.status)).toEqual(["retired"]);
  });

  it("throws when retiring an unknown source", () => {
    expect(() => retireS3Source("does-not-exist")).toThrow(/S3 source not found/);
  });
});
