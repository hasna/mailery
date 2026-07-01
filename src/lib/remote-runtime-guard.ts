export const REMOTE_STORAGE_RUNTIME_ERROR =
  "HASNA_EMAILS_STORAGE_MODE=remote now runs Mailery with self-hosted PostgreSQL as the source of truth and local SQLite as an explicit runtime cache.";

export function readStorageMode(): string | null {
  const mode = process.env["HASNA_EMAILS_STORAGE_MODE"]?.trim() || process.env["EMAILS_STORAGE_MODE"]?.trim();
  return mode ? mode.toLowerCase() : null;
}

export function isRemoteStorageMode(): boolean {
  return readStorageMode() === "remote";
}

export function remoteRuntimeErrorForEntrypoint(entrypoint: string): string | null {
  void entrypoint;
  return null;
}

export function assertRemoteRuntimeSupported(entrypoint: string): void {
  const error = remoteRuntimeErrorForEntrypoint(entrypoint);
  if (error) throw new Error(error);
}
