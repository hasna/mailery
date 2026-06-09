export interface GmailArchiveKeyInput {
  profile: string;
  messageId: string;
  prefix?: string;
}

export interface GmailArchiveKeys {
  raw: string;
  metadata: string;
  manifest: string;
  attachmentsPrefix: string;
}

export function safeGmailArchiveSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]+/g, "_");
}

export function buildGmailArchiveKeys(input: GmailArchiveKeyInput): GmailArchiveKeys {
  const prefix = (input.prefix ?? "gmail").replace(/^\/+|\/+$/g, "");
  const profile = safeGmailArchiveSegment(input.profile || "default");
  const messageId = safeGmailArchiveSegment(input.messageId);
  return {
    raw: `${prefix}/${profile}/raw/${messageId}.eml`,
    metadata: `${prefix}/${profile}/metadata/${messageId}.json`,
    manifest: `${prefix}/${profile}/manifests/${messageId}.json`,
    attachmentsPrefix: `${prefix}/${profile}/attachments/${messageId}/`,
  };
}
