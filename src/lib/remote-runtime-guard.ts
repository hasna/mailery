export const REMOTE_STORAGE_RUNTIME_ERROR =
  "HASNA_EMAILS_STORAGE_MODE=remote is reserved for a future remote source-of-truth runtime. Mailery runtime commands still use local SQLite today. Use HASNA_EMAILS_STORAGE_MODE=hybrid, or run storage pull|push explicitly.";

export function readStorageMode(): string | null {
  const mode = process.env["HASNA_EMAILS_STORAGE_MODE"]?.trim() || process.env["EMAILS_STORAGE_MODE"]?.trim();
  return mode ? mode.toLowerCase() : null;
}

export function isRemoteStorageMode(): boolean {
  return readStorageMode() === "remote";
}

export function remoteRuntimeErrorForEntrypoint(entrypoint: string): string | null {
  if (!isRemoteStorageMode()) return null;
  return `${entrypoint}: ${REMOTE_STORAGE_RUNTIME_ERROR}`;
}

export function assertRemoteRuntimeSupported(entrypoint: string): void {
  const error = remoteRuntimeErrorForEntrypoint(entrypoint);
  if (error) throw new Error(error);
}
