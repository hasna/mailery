import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_DOWNLOAD_BYTES = MAX_ATTACHMENT_DOWNLOAD_BYTES;
const MAX_ATTACHMENT_FILENAME_UTF8_BYTES = 240;
const MIME_TYPE_RE = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+\/[!#$%&'*+.^_`|~A-Za-z0-9-]+$/;

export interface AvailableAttachmentContent {
  state: "available";
  index: number;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  data: Uint8Array;
}

export interface UnavailableAttachmentContent {
  state: "content_unavailable";
  index: number;
  filename: string;
  content_type: string;
  bytes: number;
}

export interface MissingAttachmentContent {
  state: "not_found";
  index: number;
}

export type AttachmentContent =
  | AvailableAttachmentContent
  | UnavailableAttachmentContent
  | MissingAttachmentContent;

export interface SavedAttachment {
  index: number;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  path: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validIndex(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("attachment index must be a non-negative integer");
  return index;
}

export function normalizeAttachmentByteLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_ATTACHMENT_DOWNLOAD_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
    throw new Error(`attachment byte limit must be between 1 and ${MAX_ATTACHMENT_DOWNLOAD_BYTES}`);
  }
  return limit;
}

function wellFormedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} contains unsafe characters`);
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} contains unsafe characters`);
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${label} contains unsafe characters`);
    }
  }
  return value;
}

export function validateAttachmentFilename(value: unknown): string {
  return wellFormedText(value, "attachment filename", 1024);
}

function attachmentMetadata(value: unknown): { filename: string; content_type: string; size: number; record: Record<string, unknown> } {
  const record = object(value, "attachment");
  const filename = validateAttachmentFilename(record["filename"]);
  const content_type = wellFormedText(record["content_type"], "attachment content type", 255);
  if (!MIME_TYPE_RE.test(content_type)) {
    throw new Error("attachment content type must be a valid MIME type");
  }
  const size = record["size"];
  if (!Number.isSafeInteger(size) || Number(size) < 0) throw new Error("attachment size must be a non-negative integer");
  return { filename, content_type, size: Number(size), record };
}

function decodeCanonicalBase64(value: unknown, declaredSize: number, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("attachment content must be canonical base64");
  }
  if (declaredSize > maxBytes || value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error(`attachment exceeds byte limit ${maxBytes}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("attachment content must be canonical base64");
  if (decoded.byteLength !== declaredSize) {
    throw new Error(`attachment size mismatch: declared ${declaredSize}, decoded ${decoded.byteLength}`);
  }
  if (decoded.byteLength > maxBytes) throw new Error(`attachment exceeds byte limit ${maxBytes}`);
  return decoded;
}

/** Decode and validate the authenticated attachment endpoint response. */
export function decodeAttachmentPayload(payload: unknown, index: number, maxBytes?: number): AttachmentContent {
  validIndex(index);
  const limit = normalizeAttachmentByteLimit(maxBytes);
  const wrapper = object(payload, "attachment response");
  const code = wrapper["code"];
  if (code === "attachment_not_found") return { state: "not_found", index };
  if (code === "attachment_content_unavailable") {
    const meta = attachmentMetadata(wrapper["attachment"]);
    if (meta.size > limit) throw new Error(`attachment exceeds byte limit ${limit}`);
    return {
      state: "content_unavailable",
      index,
      filename: meta.filename,
      content_type: meta.content_type,
      bytes: meta.size,
    };
  }
  const meta = attachmentMetadata(wrapper["attachment"]);
  const data = decodeCanonicalBase64(meta.record["content_base64"], meta.size, limit);
  return {
    state: "available",
    index,
    filename: meta.filename,
    content_type: meta.content_type,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}

function safeFilename(raw: string, index: number): string {
  const leaf = basename(raw.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  if (!leaf || leaf === "." || leaf === "..") return `attachment-${index + 1}`;
  if (Buffer.byteLength(leaf, "utf8") > MAX_ATTACHMENT_FILENAME_UTF8_BYTES) {
    throw new Error(`attachment filename exceeds the ${MAX_ATTACHMENT_FILENAME_UTF8_BYTES}-byte UTF-8 component limit`);
  }
  return leaf;
}

function truncateUtf8(value: string, byteLimit: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > byteLimit) break;
    output += character;
    bytes += next;
  }
  return output;
}

function collisionName(filename: string, attempt: number): string {
  if (attempt === 0) return filename;
  let extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length) || "attachment";
  const suffix = `-${attempt}`;
  if (Buffer.byteLength(extension, "utf8") + Buffer.byteLength(suffix, "utf8") >= MAX_ATTACHMENT_FILENAME_UTF8_BYTES) {
    extension = "";
  }
  const stemBudget = MAX_ATTACHMENT_FILENAME_UTF8_BYTES
    - Buffer.byteLength(suffix, "utf8")
    - Buffer.byteLength(extension, "utf8");
  return `${truncateUtf8(stem, Math.max(1, stemBudget))}${suffix}${extension}`;
}

async function removeCreatedDirectoryChain(directory: string, firstCreated: string): Promise<void> {
  const boundary = resolve(firstCreated);
  let current = directory;
  while (current === boundary || current.startsWith(`${boundary}/`)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    if (current === boundary) return;
    current = dirname(current);
  }
}

interface AttachmentWriteHooks {
  /** @internal Deterministic regression seam for directory-swap tests. */
  beforeDescriptorWrite?: () => Promise<void> | void;
  /** @internal Deterministic regression seam for temp-entry replacement tests. */
  beforeTemporaryPublish?: (temporary: string) => Promise<void> | void;
  /** @internal Deterministic regression seam for final-entry replacement tests. */
  afterCandidatePublish?: (candidate: string) => Promise<void> | void;
  /** @internal Force descriptor-path resolution failure for leak tests. */
  resolveStableDirectory?: (fd: number) => string;
  /** @internal Simulate an output-directory ownership mismatch without chown. */
  outputDirectoryOwnerUid?: () => number;
  /** @internal Simulate ancestor ownership without requiring privileged chown. */
  ancestorOwnerUid?: (path: string, actualUid: number) => number;
}

function stableDirectoryPath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  throw new Error("secure attachment writes require descriptor-relative filesystem support");
}

async function assertStableDirectory(
  directory: string,
  opened: { dev: number; ino: number },
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [current, canonical] = await Promise.all([lstat(directory), realpath(directory)]);
  } catch {
    throw new Error("attachment output directory changed after it was opened");
  }
  if (current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== opened.dev
    || current.ino !== opened.ino
    || canonical !== directory) {
    throw new Error("attachment output directory changed after it was opened");
  }
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const GROUP_OR_OTHER_PERMISSION_BITS = 0o077;
const GROUP_OR_OTHER_WRITE_BITS = 0o022;
const STICKY_BIT = 0o1000;

function currentEffectiveUid(): number {
  // The descriptor-relative implementation and the POSIX ownership/mode model
  // below are deliberately Linux-only. Fail closed on platforms where either
  // half of that contract cannot be established.
  if (process.platform !== "linux" || typeof process.geteuid !== "function") {
    throw new Error("secure attachment writes require Linux effective-user filesystem checks");
  }
  const uid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("secure attachment writes require a valid effective user id");
  }
  return uid;
}

async function inspectCanonicalDirectory(path: string): Promise<Stats> {
  let before: Stats;
  let after: Stats;
  let canonical: string;
  try {
    before = await lstat(path);
    canonical = await realpath(path);
    after = await lstat(path);
  } catch {
    throw new Error("attachment output directory or ancestor changed during validation");
  }
  if (before.isSymbolicLink()
    || after.isSymbolicLink()
    || !before.isDirectory()
    || !after.isDirectory()
    || !sameFileIdentity(before, after)
    || canonical !== path) {
    throw new Error("attachment output directory or ancestor changed during validation");
  }
  return after;
}

async function assertTrustedOutputPath(
  directory: string,
  opened: Stats,
  effectiveUid: number,
  ownerUidOverride?: number,
  ancestorOwnerUid?: AttachmentWriteHooks["ancestorOwnerUid"],
): Promise<void> {
  await assertStableDirectory(directory, opened);
  let childPath = directory;
  let child = await inspectCanonicalDirectory(childPath);
  if (!sameFileIdentity(child, opened)) {
    throw new Error("attachment output directory changed after it was opened");
  }
  if ((ownerUidOverride ?? child.uid) !== effectiveUid) {
    throw new Error("attachment output directory must be owned by the effective user");
  }
  if ((child.mode & GROUP_OR_OTHER_PERMISSION_BITS) !== 0) {
    throw new Error("attachment output directory must have private permissions");
  }

  await assertProtectedAncestorEntries(directory, child, effectiveUid, ancestorOwnerUid);
}

async function assertProtectedAncestorEntries(
  initialChildPath: string,
  initialChild: Stats,
  effectiveUid: number,
  ownerUid?: AttachmentWriteHooks["ancestorOwnerUid"],
): Promise<void> {
  // Every parent owns the namespace entry for its child. A parent therefore
  // must either deny group/other renames, or provide sticky-directory
  // protection for a child entry owned by this effective user. This permits
  // conventional /tmp paths while rejecting shared mutable ancestors.
  let childPath = initialChildPath;
  let child = initialChild;
  while (true) {
    const parentPath = dirname(childPath);
    if (parentPath === childPath) break;
    const parent = await inspectCanonicalDirectory(parentPath);
    const parentUid = ownerUid?.(parentPath, parent.uid) ?? parent.uid;
    if (parentUid !== effectiveUid && parentUid !== 0) {
      throw new Error("attachment output directory ancestor must have a trusted owner");
    }
    if ((parent.mode & GROUP_OR_OTHER_WRITE_BITS) !== 0
      && ((parent.mode & STICKY_BIT) === 0 || child.uid !== effectiveUid)) {
      throw new Error("attachment output directory ancestor permits unsafe entry renames");
    }
    childPath = parentPath;
    child = parent;
  }
}

async function createPrivateDirectoryChain(
  directory: string,
  effectiveUid: number,
  ancestorOwnerUid?: AttachmentWriteHooks["ancestorOwnerUid"],
): Promise<string | undefined> {
  const missing: string[] = [];
  let existingPath = directory;
  while (true) {
    try {
      await lstat(existingPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(existingPath);
      const parentPath = dirname(existingPath);
      if (parentPath === existingPath) {
        throw new Error("attachment output directory has no existing filesystem ancestor");
      }
      existingPath = parentPath;
    }
  }

  const existing = await inspectCanonicalDirectory(existingPath);
  await assertProtectedAncestorEntries(existingPath, existing, effectiveUid, ancestorOwnerUid);
  let firstCreated: string | undefined;
  let deepestCreated: string | undefined;
  try {
    for (const path of missing.reverse()) {
      let created = false;
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (created) {
        firstCreated ??= path;
        deepestCreated = path;
      }
      const current = await inspectCanonicalDirectory(path);
      if (current.uid !== effectiveUid) {
        throw new Error("new attachment output directories must be owned by the effective user");
      }
      if ((current.mode & GROUP_OR_OTHER_PERMISSION_BITS) !== 0) {
        throw new Error("new attachment output directories must have private permissions");
      }
      await assertProtectedAncestorEntries(path, current, effectiveUid, ancestorOwnerUid);
    }
  } catch (error) {
    if (firstCreated && deepestCreated) {
      await removeCreatedDirectoryChain(deepestCreated, firstCreated);
    }
    throw error;
  }
  return firstCreated;
}

async function unlinkIfSameIdentity(
  path: string,
  expected: { dev: number; ino: number },
): Promise<void> {
  try {
    const current = await lstat(path);
    if (!current.isFile() || !sameFileIdentity(current, expected)) return;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function descriptorSha256(
  file: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
  label = "temporary attachment",
): Promise<string> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedBytes)));
  let position = 0;
  while (position < expectedBytes) {
    const { bytesRead } = await file.read(
      chunk,
      0,
      Math.min(chunk.byteLength, expectedBytes - position),
      position,
    );
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await file.read(extra, 0, 1, position);
  if (position !== expectedBytes || extraBytes !== 0) {
    throw new Error(`${label} size changed during validation`);
  }
  return hash.digest("hex");
}

/**
 * Persist a fully validated attachment without following symlinked output
 * directories, exposing partial files, or overwriting an existing file.
 * The returned path and digest are validated together at return time; another
 * process running as the same effective UID, or a privileged root process, can
 * still mutate that path later.
 */
async function writeAttachmentFileWithHooks(
  content: AvailableAttachmentContent,
  outputDir: string,
  hooks: AttachmentWriteHooks = {},
): Promise<SavedAttachment> {
  if (content.state !== "available") throw new Error("only available attachment content can be written");
  if (!outputDir.trim()) throw new Error("attachment output directory is required");
  const directory = resolve(outputDir);
  // Validate the final component before any mkdir side effect. This also makes
  // an overlong Unicode name fail with a stable product error instead of an
  // operating-system ENAMETOOLONG after leaving an empty output directory.
  const leaf = safeFilename(content.filename, content.index);
  const effectiveUid = currentEffectiveUid();
  let firstCreated: string | undefined;
  try {
    firstCreated = await createPrivateDirectoryChain(directory, effectiveUid, hooks.ancestorOwnerUid);
    let directoryHandle: Awaited<ReturnType<typeof open>>;
    try {
      directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error("attachment output directory must be a real directory without symlinks");
      }
      throw error;
    }
    let temporary: string | undefined;
    let temporaryIdentityForCleanup: { dev: number; ino: number } | null = null;
    let savedName: string | null = null;
    let savedSha256: string | null = null;
    let savedIdentity: { dev: number; ino: number } | null = null;
    try {
      const descriptorDirectory = hooks.resolveStableDirectory?.(directoryHandle.fd)
        ?? stableDirectoryPath(directoryHandle.fd);
      const openedDirectory = await directoryHandle.stat();
      if (!openedDirectory.isDirectory()) {
        throw new Error("attachment output directory must be a real directory without symlinks");
      }
      await assertTrustedOutputPath(
        directory,
        openedDirectory,
        effectiveUid,
        hooks.outputDirectoryOwnerUid?.(),
        hooks.ancestorOwnerUid,
      );
      await hooks.beforeDescriptorWrite?.();

      temporary = join(descriptorDirectory, `.attachment-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx+", 0o600);
      try {
        const openedTemporaryIdentity = await file.stat();
        if (!openedTemporaryIdentity.isFile()) {
          throw new Error("temporary attachment must be a regular file");
        }
        temporaryIdentityForCleanup = {
          dev: openedTemporaryIdentity.dev,
          ino: openedTemporaryIdentity.ino,
        };
        await file.writeFile(content.data);
        await file.sync();
        await file.chmod(0o600);
        const temporaryIdentity = await file.stat();
        if (!temporaryIdentity.isFile()
          || temporaryIdentity.size !== content.bytes
          || !sameFileIdentity(openedTemporaryIdentity, temporaryIdentity)) {
          throw new Error("temporary attachment changed before publication");
        }
        await hooks.beforeTemporaryPublish?.(temporary);
        const temporarySha256 = await descriptorSha256(file, content.bytes);
        if (temporarySha256 !== content.sha256) {
          throw new Error("temporary attachment digest changed before publication");
        }
        const temporaryPathIdentity = await lstat(temporary);
        if (!temporaryPathIdentity.isFile()
          || temporaryPathIdentity.size !== content.bytes
          || !sameFileIdentity(temporaryIdentity, temporaryPathIdentity)) {
          throw new Error("temporary attachment inode changed before publication");
        }

        for (let attempt = 0; attempt < 10_000; attempt++) {
          const candidateName = collisionName(leaf, attempt);
          const candidate = join(descriptorDirectory, candidateName);
          let candidateLinked = false;
          try {
            await link(temporary, candidate);
            candidateLinked = true;
            const publishedPathIdentity = await lstat(candidate);
            if (!publishedPathIdentity.isFile()
              || publishedPathIdentity.size !== content.bytes
              || !sameFileIdentity(temporaryIdentity, publishedPathIdentity)) {
              throw new Error("temporary attachment inode changed before publication");
            }
            // Run the deterministic seam after the legacy link/lstat/digest
            // checks, at the exact point where a peer-writable directory used
            // to permit final-path substitution.
            await hooks.afterCandidatePublish?.(candidate);

            let publishedFile: Awaited<ReturnType<typeof open>>;
            try {
              publishedFile = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
            } catch (error) {
              if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
                throw new Error("published attachment changed during validation");
              }
              throw error;
            }
            let publishedSha256: string;
            try {
              const publishedDescriptorIdentity = await publishedFile.stat();
              if (!publishedDescriptorIdentity.isFile()
                || publishedDescriptorIdentity.size !== content.bytes
                || !sameFileIdentity(temporaryIdentity, publishedDescriptorIdentity)) {
                throw new Error("published attachment inode changed during validation");
              }
              publishedSha256 = await descriptorSha256(
                publishedFile,
                content.bytes,
                "published attachment",
              );
              const finalPathIdentity = await lstat(candidate);
              if (!finalPathIdentity.isFile()
                || finalPathIdentity.size !== content.bytes
                || !sameFileIdentity(publishedDescriptorIdentity, finalPathIdentity)) {
                throw new Error("published attachment inode changed during validation");
              }
            } finally {
              await publishedFile.close();
            }
            if (publishedSha256 !== content.sha256) {
              throw new Error("published attachment digest changed during validation");
            }
            savedSha256 = publishedSha256;
            savedIdentity = { dev: temporaryIdentity.dev, ino: temporaryIdentity.ino };
            savedName = candidateName;
            break;
          } catch (error) {
            if (candidateLinked) {
              await unlinkIfSameIdentity(candidate, temporaryIdentity).catch(() => {});
            }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      } finally {
        await file.close();
      }
      if (!savedName) throw new Error("could not allocate a collision-free attachment path");
      try {
        await assertTrustedOutputPath(
          directory,
          openedDirectory,
          effectiveUid,
          hooks.outputDirectoryOwnerUid?.(),
          hooks.ancestorOwnerUid,
        );
      } catch (error) {
        if (savedIdentity) {
          await unlinkIfSameIdentity(join(descriptorDirectory, savedName), savedIdentity).catch(() => {});
        }
        savedName = null;
        savedIdentity = null;
        throw error;
      }
    } finally {
      // Includes short writes, fsync/chmod errors, and exhausted collisions.
      if (temporary && temporaryIdentityForCleanup) {
        await unlinkIfSameIdentity(temporary, temporaryIdentityForCleanup).catch(() => {});
      }
      await directoryHandle.close();
    }
    if (!savedName || !savedSha256) throw new Error("could not allocate a collision-free attachment path");
    return {
      index: content.index,
      filename: content.filename,
      content_type: content.content_type,
      bytes: content.bytes,
      sha256: savedSha256,
      path: join(directory, savedName),
    };
  } catch (error) {
    if (firstCreated) await removeCreatedDirectoryChain(directory, firstCreated);
    throw error;
  }
}

/** Persist one validated attachment through the secure public write boundary. */
export async function writeAttachmentFile(
  content: AvailableAttachmentContent,
  outputDir: string,
): Promise<SavedAttachment> {
  return writeAttachmentFileWithHooks(content, outputDir);
}

/** @internal Source-only deterministic seams; not re-exported by the package. */
export const attachmentDownloadTestBoundary = {
  writeAttachmentFile: writeAttachmentFileWithHooks,
};
