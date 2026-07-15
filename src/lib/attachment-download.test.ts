import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  attachmentDownloadTestBoundary,
  decodeAttachmentPayload,
  writeAttachmentFile,
} from "./attachment-download.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attachment download boundary", () => {
  it("strictly decodes canonical base64 and reports actual bytes plus SHA-256", () => {
    const result = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);

    expect(result).toMatchObject({
      state: "available",
      index: 0,
      filename: "invoice.txt",
      content_type: "text/plain",
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  it("distinguishes metadata-only content from a missing attachment", () => {
    expect(decodeAttachmentPayload({
      code: "attachment_content_unavailable",
      attachment: { filename: "invoice.pdf", content_type: "application/pdf", size: 123 },
    }, 2, 1024)).toEqual({
      state: "content_unavailable",
      index: 2,
      filename: "invoice.pdf",
      content_type: "application/pdf",
      bytes: 123,
    });
    expect(decodeAttachmentPayload({ code: "attachment_not_found" }, 2, 1024))
      .toEqual({ state: "not_found", index: 2 });
  });

  it("rejects malformed base64, declared-size drift, and oversized payloads", () => {
    const base = { filename: "x.bin", content_type: "application/octet-stream" };
    expect(() => decodeAttachmentPayload({ attachment: { ...base, size: 1, content_base64: "%%%=" } }, 0, 16))
      .toThrow(/base64/i);
    expect(() => decodeAttachmentPayload({ attachment: { ...base, size: 6, content_base64: "aGVsbG8=" } }, 0, 16))
      .toThrow(/size/i);
    expect(() => decodeAttachmentPayload({ attachment: { ...base, size: 5, content_base64: "aGVsbG8=" } }, 0, 4))
      .toThrow(/limit/i);
  });

  it("accepts only an RFC token/token MIME type", () => {
    const attachment = (contentType: string) => ({
      attachment: {
        filename: "x.bin",
        content_type: contentType,
        size: 1,
        content_base64: "eA==",
      },
    });
    expect(() => decodeAttachmentPayload(attachment("text/(plain)"), 0, 16)).toThrow(/MIME/i);
    expect(() => decodeAttachmentPayload(attachment("text/plain; charset=utf-8"), 0, 16)).toThrow(/MIME/i);
    expect(() => decodeAttachmentPayload(attachment("application/vnd.example+json"), 0, 16)).not.toThrow();
  });

  it("rejects terminal C0/C1, ESC, and bidi-control filenames before display or write", () => {
    const attachment = (filename: string) => ({
      attachment: {
        filename,
        content_type: "text/plain",
        size: 1,
        content_base64: "eA==",
      },
    });
    for (const filename of ["escape\u001b[31m.txt", "c1\u0085.txt", "bidi\u202Etxt.exe"]) {
      expect(() => decodeAttachmentPayload(attachment(filename), 0, 16)).toThrow(/unsafe/i);
    }
  });

  it("writes atomically with mode 0600, neutralizes traversal names, and never overwrites", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-attachment-"));
    dirs.push(dir);
    writeFileSync(join(dir, "invoice.txt"), "existing");
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "../invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    const saved = await writeAttachmentFile(content, dir);
    expect(saved.path.startsWith(`${dir}/`)).toBe(true);
    expect(saved.path).not.toBe(join(dir, "invoice.txt"));
    expect(readFileSync(join(dir, "invoice.txt"), "utf8")).toBe("existing");
    expect(readFileSync(saved.path, "utf8")).toBe("hello");
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
  });

  it("creates every missing output-directory component private to the effective user", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-recursive-"));
    dirs.push(parent);
    const first = join(parent, "first");
    const outputDir = join(first, "second");
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await writeAttachmentFile(content, outputDir);
    const effectiveUid = process.geteuid();
    for (const directory of [first, outputDir]) {
      expect(statSync(directory).uid).toBe(effectiveUid);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects a pre-existing output directory that is not private to the effective user", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-private-"));
    dirs.push(parent);
    const outputDir = join(parent, "output");
    mkdirSync(outputDir, { mode: 0o700 });
    chmodSync(outputDir, 0o750);
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(writeAttachmentFile(content, outputDir)).rejects.toThrow(/private|permissions/i);
    expect(readdirSync(outputDir)).toEqual([]);

    chmodSync(outputDir, 0o700);
    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, outputDir, {
      outputDirectoryOwnerUid: () => (process.geteuid?.() ?? 0) + 1,
    })).rejects.toThrow(/owned|effective user/i);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("rejects an output path whose ancestor entry can be renamed by other users", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-ancestor-"));
    dirs.push(parent);
    const shared = join(parent, "shared");
    const outputDir = join(shared, "output");
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    chmodSync(shared, 0o777);
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(writeAttachmentFile(content, outputDir)).rejects.toThrow(/ancestor|rename|permissions/i);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("rejects a foreign-owned non-writable ancestor without requiring chown", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-foreign-owner-"));
    dirs.push(parent);
    const foreignOwned = join(parent, "foreign-owned");
    const outputDir = join(foreignOwned, "output");
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    chmodSync(foreignOwned, 0o711);
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");
    const effectiveUid = process.geteuid();

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, outputDir, {
      ancestorOwnerUid: (path, actualUid) => path === foreignOwned ? effectiveUid + 1 : actualUid,
    })).rejects.toThrow(/ancestor.*owned|trusted.*owner|effective user/i);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("revalidates ancestor ownership after publishing and removes only its own inode", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-owner-rebind-"));
    dirs.push(parent);
    const trustedParent = join(parent, "trusted");
    const outputDir = join(trustedParent, "output");
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");
    const effectiveUid = process.geteuid();
    let foreignOwned = false;

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, outputDir, {
      afterCandidatePublish: () => { foreignOwned = true; },
      ancestorOwnerUid: (path, actualUid) =>
        foreignOwned && path === trustedParent ? effectiveUid + 1 : actualUid,
    })).rejects.toThrow(/ancestor.*owned|trusted.*owner|effective user/i);
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("rejects a symlinked ancestor before creating a missing output directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-ancestor-link-"));
    dirs.push(parent);
    const attackerDir = join(parent, "attacker");
    const linkedParent = join(parent, "linked-parent");
    const outputDir = join(linkedParent, "new-output");
    mkdirSync(attackerDir, { mode: 0o700 });
    symlinkSync(attackerDir, linkedParent, "dir");
    const attackerMtime = statSync(attackerDir, { bigint: true }).mtimeNs;
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(writeAttachmentFile(content, outputDir)).rejects.toThrow(/ancestor.*changed|symlink/i);
    expect(readdirSync(attackerDir)).toEqual([]);
    expect(statSync(attackerDir, { bigint: true }).mtimeNs).toBe(attackerMtime);
  });

  it("keeps a stable output-directory identity across a controlled symlink swap", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-swap-"));
    dirs.push(parent);
    const outputDir = join(parent, "output");
    const displacedDir = join(parent, "displaced-output");
    const attackerDir = join(parent, "attacker-target");
    mkdirSync(outputDir, { mode: 0o700 });
    mkdirSync(attackerDir, { mode: 0o700 });
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, outputDir, {
      beforeDescriptorWrite: async () => {
        renameSync(outputDir, displacedDir);
        symlinkSync(attackerDir, outputDir, "dir");
      },
    })).rejects.toThrow(/output directory.*changed|stable output directory/i);

    expect(readdirSync(attackerDir)).toEqual([]);
    expect(readdirSync(displacedDir)).toEqual([]);
  });

  it("never publishes a replacement for the validated temporary attachment inode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-attachment-temp-swap-"));
    dirs.push(dir);
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");
    let replacement: string | undefined;

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, dir, {
      beforeTemporaryPublish: async (temporary) => {
        replacement = join(dir, basename(temporary));
        unlinkSync(temporary);
        writeFileSync(temporary, "substituted", { mode: 0o600 });
      },
    })).rejects.toThrow(/temporary attachment.*changed|attachment inode.*changed/i);

    expect(replacement).toBeDefined();
    expect(readFileSync(replacement!, "utf8")).toBe("substituted");
    expect(readdirSync(dir)).toEqual([basename(replacement!)]);
  });

  it("rejects a post-link candidate replacement without deleting the foreign inode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-attachment-final-swap-"));
    dirs.push(dir);
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");
    let replacement: string | undefined;

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, dir, {
      afterCandidatePublish: async (candidate) => {
        replacement = join(dir, basename(candidate));
        unlinkSync(candidate);
        writeFileSync(candidate, "foreign replacement", { mode: 0o600 });
      },
    })).rejects.toThrow(/published attachment.*changed|attachment inode.*changed/i);

    expect(replacement).toBeDefined();
    expect(readFileSync(replacement!, "utf8")).toBe("foreign replacement");
  });

  it("rejects a post-link ancestor rebind and removes only its displaced inode", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-parent-rebind-"));
    dirs.push(parent);
    const trustedParent = join(parent, "trusted");
    const outputDir = join(trustedParent, "output");
    const displacedParent = join(parent, "displaced");
    const attackerDir = join(parent, "attacker");
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    mkdirSync(attackerDir, { mode: 0o700 });
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, outputDir, {
      afterCandidatePublish: async () => {
        renameSync(trustedParent, displacedParent);
        symlinkSync(attackerDir, trustedParent, "dir");
      },
    })).rejects.toThrow(/output directory.*changed|ancestor.*changed|stable output directory/i);

    expect(readdirSync(attackerDir)).toEqual([]);
    expect(readdirSync(join(displacedParent, "output"))).toEqual([]);
  });

  it("closes the output directory descriptor when secure descriptor paths are unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-attachment-descriptor-"));
    dirs.push(dir);
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");
    let openedFd: number | undefined;

    await expect(attachmentDownloadTestBoundary.writeAttachmentFile(content, dir, {
      resolveStableDirectory: (fd) => {
        openedFd = fd;
        throw new Error("secure attachment writes require descriptor-relative filesystem support");
      },
    })).rejects.toThrow(/descriptor-relative filesystem support/i);

    expect(openedFd).toBeDefined();
    expect(existsSync(`/proc/self/fd/${openedFd}`)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects a static symlink output directory without creating attacker-controlled files", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-symlink-"));
    dirs.push(parent);
    const attackerDir = join(parent, "attacker-target");
    const outputDir = join(parent, "output");
    mkdirSync(attackerDir);
    symlinkSync(attackerDir, outputDir, "dir");
    const content = decodeAttachmentPayload({
      attachment: {
        filename: "invoice.txt",
        content_type: "text/plain",
        size: 5,
        content_base64: "aGVsbG8=",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(writeAttachmentFile(content, outputDir)).rejects.toThrow(/output directory/i);
    expect(readdirSync(attackerDir)).toEqual([]);
  });

  it("rejects an overlong UTF-8 filename component before creating the output directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "emails-attachment-parent-"));
    dirs.push(parent);
    const outputDir = join(parent, "new-output");
    const content = decodeAttachmentPayload({
      attachment: {
        filename: `${"💥".repeat(70)}.txt`,
        content_type: "text/plain",
        size: 1,
        content_base64: "eA==",
      },
    }, 0, 16);
    if (content.state !== "available") throw new Error("fixture must be available");

    await expect(writeAttachmentFile(content, outputDir)).rejects.toThrow(/filename.*UTF-8|UTF-8.*filename/i);
    expect(existsSync(outputDir)).toBe(false);
  });
});
