import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildGmailArchiveKeys,
  migrateS3Prefix,
  uploadGmailArchiveAttachment,
  verifyGmailArchive,
} from "./gmail-archive.js";

describe("legacy Gmail archive helpers", () => {
  it("builds deterministic archive keys for existing Gmail imports", () => {
    expect(buildGmailArchiveKeys({
      prefix: "gmail",
      profile: "user@example.com",
      messageId: "190971d5a7402e62",
    })).toEqual({
      raw: "gmail/user_example.com/raw/190971d5a7402e62.eml",
      metadata: "gmail/user_example.com/metadata/190971d5a7402e62.json",
      manifest: "gmail/user_example.com/manifests/190971d5a7402e62.json",
      attachmentsPrefix: "gmail/user_example.com/attachments/190971d5a7402e62/",
    });
  });

  it("keeps AWS S3 behind lazy imports for key-only callers", () => {
    const source = readFileSync(join(import.meta.dir, "gmail-archive.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']@aws-sdk\/client-s3["'];/m);
    expect(source).toContain('import("@aws-sdk/client-s3")');
  });

  it("uploads attachments into the legacy archive prefix", async () => {
    const sent: unknown[] = [];
    const result = await uploadGmailArchiveAttachment({
      bucket: "example-mail-archive",
      prefix: "gmail",
      profile: "maxim@staris.ro",
      messageId: "msg/1",
      filename: "invoice final.pdf",
      body: Buffer.from("pdf"),
      contentType: "application/pdf",
      client: { send: async (command) => { sent.push(command); return {}; } },
    });

    expect(result).toEqual({
      filename: "invoice final.pdf",
      key: "gmail/maxim_staris.ro/attachments/msg_1/invoice_final.pdf",
      s3_url: "s3://example-mail-archive/gmail/maxim_staris.ro/attachments/msg_1/invoice_final.pdf",
    });
    expect(sent).toHaveLength(1);
  });

  it("verifies required raw metadata manifest and attachment objects", async () => {
    const existing = new Set([
      "gmail/profile/raw/msg.eml",
      "gmail/profile/metadata/msg.json",
      "gmail/profile/manifests/msg.json",
    ]);
    const result = await verifyGmailArchive({
      bucket: "example-mail-archive",
      profile: "profile",
      messageId: "msg",
      expectedAttachments: ["invoice.pdf"],
      client: {
        send: async (command) => {
          const key = (command as { input?: { Key?: string } }).input?.Key ?? "";
          if (!existing.has(key)) throw new Error("missing");
          return {};
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["gmail/profile/attachments/msg/invoice.pdf"]);
  });

  it("plans legacy S3 prefix migration without copying in dry-run mode", async () => {
    const copied: unknown[] = [];
    const result = await migrateS3Prefix({
      sourceBucket: "old",
      targetBucket: "new",
      sourcePrefix: "emails/",
      targetPrefix: "legacy/maximstaris",
      dryRun: true,
      client: {
        send: async (command) => {
          const input = (command as { input?: { CopySource?: string; Prefix?: string } }).input;
          if (input?.CopySource) copied.push(input);
          return { Contents: [{ Key: "emails/a.eml" }], IsTruncated: false };
        },
      },
    });

    expect(result).toMatchObject({
      scanned: 1,
      copied: 0,
      dryRun: true,
      objects: [{ source: "emails/a.eml", target: "legacy/maximstaris/a.eml" }],
    });
    expect(copied).toEqual([]);
  });
});
