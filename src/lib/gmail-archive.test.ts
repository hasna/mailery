import { describe, expect, it } from "bun:test";
import {
  buildGmailArchiveKeys,
  migrateS3Prefix,
  uploadGmailArchiveAttachment,
  verifyGmailArchive,
} from "./gmail-archive.js";

describe("buildGmailArchiveKeys", () => {
  it("builds deterministic prod-emails Gmail keys by profile and message", () => {
    expect(buildGmailArchiveKeys({
      prefix: "gmail",
      profile: "andrei@hasna.com",
      messageId: "190971d5a7402e62",
    })).toEqual({
      raw: "gmail/andrei_hasna.com/raw/190971d5a7402e62.eml",
      metadata: "gmail/andrei_hasna.com/metadata/190971d5a7402e62.json",
      manifest: "gmail/andrei_hasna.com/manifests/190971d5a7402e62.json",
      attachmentsPrefix: "gmail/andrei_hasna.com/attachments/190971d5a7402e62/",
    });
  });

  it("normalizes unsafe path segments", () => {
    expect(buildGmailArchiveKeys({
      prefix: "/gmail/",
      profile: "../default profile",
      messageId: "msg/id",
    })).toEqual({
      raw: "gmail/.._default_profile/raw/msg_id.eml",
      metadata: "gmail/.._default_profile/metadata/msg_id.json",
      manifest: "gmail/.._default_profile/manifests/msg_id.json",
      attachmentsPrefix: "gmail/.._default_profile/attachments/msg_id/",
    });
  });
});

describe("Gmail archive S3 helpers", () => {
  it("uploads attachments into the profile/message archive prefix", async () => {
    const sent: unknown[] = [];
    const result = await uploadGmailArchiveAttachment({
      bucket: "prod-emails",
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
      s3_url: "s3://prod-emails/gmail/maxim_staris.ro/attachments/msg_1/invoice_final.pdf",
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
      bucket: "prod-emails",
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

  it("plans and copies legacy S3 prefixes to a target prefix", async () => {
    const copied: Array<{ source?: string; key?: string }> = [];
    const result = await migrateS3Prefix({
      sourceBucket: "hasna-mail-maximstaris",
      targetBucket: "prod-emails",
      sourcePrefix: "emails/",
      targetPrefix: "legacy/maximstaris",
      client: {
        send: async (command) => {
          const input = (command as { input?: { CopySource?: string; Key?: string } }).input;
          if (input?.CopySource) {
            copied.push({ source: input.CopySource, key: input.Key });
            return {};
          }
          return { Contents: [{ Key: "emails/a.eml" }, { Key: "emails/folder/b.eml" }] };
        },
      },
    });

    expect(result.copied).toBe(2);
    expect(result.objects).toEqual([
      { source: "emails/a.eml", target: "legacy/maximstaris/a.eml" },
      { source: "emails/folder/b.eml", target: "legacy/maximstaris/folder/b.eml" },
    ]);
    expect(copied).toEqual([
      { source: "hasna-mail-maximstaris/emails/a.eml", key: "legacy/maximstaris/a.eml" },
      { source: "hasna-mail-maximstaris/emails/folder/b.eml", key: "legacy/maximstaris/folder/b.eml" },
    ]);
  });
});
