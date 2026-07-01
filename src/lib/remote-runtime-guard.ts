export const REMOTE_STORAGE_RUNTIME_ERROR =
  "Deprecated Mailery mode 'remote' is now treated as self_hosted. Use MAILERY_MODE=self_hosted.";

export function readStorageMode(): string | null {
  const mode = process.env["MAILERY_MODE"]?.trim()
    || process.env["HASNA_EMAILS_MODE"]?.trim()
    || process.env["HASNA_EMAILS_STORAGE_MODE"]?.trim()
    || process.env["EMAILS_STORAGE_MODE"]?.trim();
  if (!mode) return null;
  const normalized = mode.toLowerCase().replace(/-/g, "_");
  if (normalized === "remote" || normalized === "hybrid") return "self_hosted";
  return normalized;
}

export function isRemoteStorageMode(): boolean {
  return false;
}

export function remoteRuntimeErrorForEntrypoint(entrypoint: string): string | null {
  void entrypoint;
  return null;
}

export function assertRemoteRuntimeSupported(entrypoint: string): void {
  const error = remoteRuntimeErrorForEntrypoint(entrypoint);
  if (error) throw new Error(error);
}
