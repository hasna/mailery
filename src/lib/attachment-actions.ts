import { localFileUrl } from "./local-actions.js";
import { validateAttachmentFilename } from "./attachment-download.js";

export interface AttachmentMetaLike {
  filename: string;
  content_type?: string;
  size?: number;
  /**
   * Whether the backing store holds payload bytes for this entry. `undefined`
   * means the source did not report availability (local mode, or a self-hosted
   * serve older than the content_available contract) — treat as unknown.
   */
  content_available?: boolean;
}

export interface AttachmentPathLike {
  filename: string;
  content_type?: string;
  local_path?: string;
  s3_url?: string;
}

export interface AttachmentDetail {
  filename: string;
  content_type: string;
  size: number;
  location?: string;
  location_type?: "local" | "s3";
  file_url?: string;
  openable: boolean;
  /**
   * Position in the AUTHENTICATED metadata array — the only value accepted as a
   * download index. Undefined for path-only extras, which have no metadata entry
   * and therefore cannot be downloaded by index. Never infer this from a
   * renderer's own loop counter: nameless entries are skipped below, so display
   * position and download index diverge.
   */
  index?: number;
  /**
   * Whether a deliberate `--download` of this entry can return bytes.
   * `false` = metadata-only (the download answers "no stored content").
   * `undefined` = unknown; render exactly as before, never as unavailable.
   */
  content_available?: boolean;
}

export function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function mergeAttachmentDetails(
  meta: readonly AttachmentMetaLike[] = [],
  paths: readonly AttachmentPathLike[] = [],
): AttachmentDetail[] {
  const details: AttachmentDetail[] = [];
  // `index` is the metadata position, NOT the position in `details`: a nameless
  // entry is skipped for display but still occupies its download index.
  meta.forEach((attachment, index) => {
    if (!attachment.filename) return;
    validateAttachmentFilename(attachment.filename);
    details.push({
      filename: attachment.filename,
      content_type: attachment.content_type ?? "application/octet-stream",
      size: Number.isFinite(attachment.size) ? Number(attachment.size) : 0,
      openable: false,
      index,
      // Carried only when the source actually stated it, so "unknown" stays
      // distinguishable from "unavailable" downstream.
      ...(typeof attachment.content_available === "boolean"
        ? { content_available: attachment.content_available }
        : {}),
    });
  });

  // Attachment names are not unique. Match each path to one metadata entry so
  // two same-named attachments keep distinct indexes instead of collapsing in
  // a filename-keyed map.
  const usedPaths = new Set<number>();
  for (const current of details) {
    const pathIndex = paths.findIndex((path, index) =>
      !usedPaths.has(index) && path.filename === current.filename,
    );
    if (pathIndex < 0) continue;
    usedPaths.add(pathIndex);
    const path = paths[pathIndex]!;
    if (path.local_path) {
      current.location = path.local_path;
      current.location_type = "local";
      current.file_url = localFileUrl(path.local_path);
      current.openable = true;
    } else if (path.s3_url) {
      current.location = path.s3_url;
      current.location_type = "s3";
      current.openable = false;
    }
  }

  for (let index = 0; index < paths.length; index++) {
    if (usedPaths.has(index)) continue;
    const path = paths[index]!;
    if (!path.filename) continue;
    validateAttachmentFilename(path.filename);
    const current: AttachmentDetail = {
      filename: path.filename,
      content_type: path.content_type ?? "application/octet-stream",
      size: 0,
      openable: false,
    };
    if (path.local_path) {
      current.location = path.local_path;
      current.location_type = "local";
      current.file_url = localFileUrl(path.local_path);
      current.openable = true;
    } else if (path.s3_url) {
      current.location = path.s3_url;
      current.location_type = "s3";
      current.openable = false;
    }
    details.push(current);
  }

  return details;
}
