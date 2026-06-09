import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildGmailArchiveKeys,
  migrateS3Prefix,
  uploadGmailArchiveAttachment,
  verifyGmailArchive,
} from "./gmail-archive.js";

describe("buildGmailArchiveKeys", () => {
  it("builds deterministic Gmail archive keys by profile and message", () => {
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

  it("does not statically load the AWS S3 SDK for key-only callers", () => {
    const source = readFileSync(join(import.meta.dir, "gmail-archive.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']@aws-sdk\/client-s3["'];/m);
    expect(source).toContain('import("@aws-sdk/client-s3")');
  });
});

describe("Gmail archive S3 helpers", () => {
  it("uploads attachments into the profile/message archive prefix", async () => {
    const sent: unknown[] = [];
    const result = await uploadGmailArchiveAttachment({
      bucket: "hasna-xyz-opensource-emails-prod",
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
      s3_url: "s3://hasna-xyz-opensource-emails-prod/gmail/maxim_staris.ro/attachments/msg_1/invoice_final.pdf",
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
      bucket: "hasna-xyz-opensource-emails-prod",
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
    const listTokens: Array<string | undefined> = [];
    const result = await migrateS3Prefix({
      sourceBucket: "hasna-mail-maximstaris",
      targetBucket: "hasna-xyz-opensource-emails-prod",
      sourcePrefix: "emails/",
      targetPrefix: "legacy/maximstaris",
      client: {
        send: async (command) => {
          const input = (command as { input?: { CopySource?: string; Key?: string; ContinuationToken?: string } }).input;
          if (input?.CopySource) {
            copied.push({ source: input.CopySource, key: input.Key });
            return {};
          }
          listTokens.push(input?.ContinuationToken);
          if (!input?.ContinuationToken) {
            return {
              Contents: [{ Key: "emails/a.eml" }],
              IsTruncated: true,
              NextContinuationToken: "next-page",
            };
          }
          return { Contents: [{ Key: "emails/folder/b.eml" }], IsTruncated: false };
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
    expect(listTokens).toEqual([undefined, "next-page"]);
  });

  it("resumes S3 prefix migration from a continuation token", async () => {
    const listTokens: Array<string | undefined> = [];
    const copied: Array<{ source?: string; key?: string }> = [];
    const result = await migrateS3Prefix({
      sourceBucket: "old",
      targetBucket: "new",
      sourcePrefix: "gmail/profile/metadata/",
      targetPrefix: "gmail/profile/metadata",
      continuationToken: "page-42",
      limit: 1,
      client: {
        send: async (command) => {
          const input = (command as { input?: { ContinuationToken?: string; CopySource?: string; Key?: string } }).input;
          if (input?.CopySource) {
            copied.push({ source: input.CopySource, key: input.Key });
            return {};
          }
          listTokens.push(input?.ContinuationToken);
          return {
            Contents: [{ Key: "gmail/profile/metadata/message.json" }],
            NextContinuationToken: "page-43",
          };
        },
      },
    });

    expect(listTokens).toEqual(["page-42"]);
    expect(copied).toEqual([
      { source: "old/gmail/profile/metadata/message.json", key: "gmail/profile/metadata/message.json" },
    ]);
    expect(result.nextContinuationToken).toBe("page-43");
  });

  it("streams objects through separate source and target clients", async () => {
    const sourceCalls: string[] = [];
    const targetCalls: Array<{ key?: string; body?: unknown; copySource?: string }> = [];
    const result = await migrateS3Prefix({
      sourceBucket: "hasna-mail-maximstaris",
      targetBucket: "hasna-xyz-opensource-emails-prod",
      sourcePrefix: "emails/",
      targetPrefix: "legacy/maximstaris",
      sourceClient: {
        send: async (command) => {
          const input = (command as { input?: { Key?: string; Prefix?: string } }).input;
          if (input?.Key) {
            sourceCalls.push(`get:${input.Key}`);
            return { Body: Buffer.from("raw-eml"), ContentType: "message/rfc822" };
          }
          sourceCalls.push(`list:${input?.Prefix}`);
          return { Contents: [{ Key: "emails/a.eml" }], IsTruncated: false };
        },
      },
      targetClient: {
        send: async (command) => {
          const input = (command as { input?: { Key?: string; Body?: unknown; CopySource?: string } }).input;
          targetCalls.push({ key: input?.Key, body: input?.Body, copySource: input?.CopySource });
          return {};
        },
      },
    });

    expect(result).toMatchObject({ scanned: 1, copied: 1 });
    expect(sourceCalls).toEqual(["list:emails/", "get:emails/a.eml"]);
    expect(targetCalls).toEqual([
      { key: "legacy/maximstaris/a.eml", body: Buffer.from("raw-eml"), copySource: undefined },
    ]);
  });
});
