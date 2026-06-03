/**
 * Email threading helpers — PURE. RFC 5322 Message-ID generation and the
 * In-Reply-To / References chain that groups a conversation.
 *
 * Threading rule (RFC 5322 §3.6.4): a reply's In-Reply-To is the PARENT's
 * Message-ID; its References is the parent's References PLUS the parent's
 * Message-ID (the full ancestry), so deep threads chain back to the root.
 */

export function generateMessageId(domain: string, localPart?: string): string {
  const id = localPart ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `<${id}@${domain}>`;
}

export interface ParentRef {
  message_id: string;
  references: string[];
}

export interface ThreadingHeaders {
  inReplyTo: string;
  references: string[];
  inReplyToHeader: string;
  referencesHeader: string;
}

export function buildThreadingHeaders(parent: ParentRef): ThreadingHeaders {
  const references = [...parent.references];
  if (!references.includes(parent.message_id)) references.push(parent.message_id);
  return {
    inReplyTo: parent.message_id,
    references,
    inReplyToHeader: parent.message_id,
    referencesHeader: references.join(" "),
  };
}

export function parseReferences(header: string | undefined | null): string[] {
  if (!header) return [];
  // Prefer extracting <...> Message-IDs (robust to space/comma separators).
  const matches = header.match(/<[^>]+>/g);
  if (matches) return matches;
  return header.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
