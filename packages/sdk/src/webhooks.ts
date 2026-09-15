// Receiver-side helpers for Mailery webhooks. Zero-dependency: HMAC-SHA256 via
// WebCrypto (Bun, Node 18+, browsers, edge runtimes). The wire format is
// documented in docs/API.md "Webhooks":
//
//   Mailery-Timestamp: <unix seconds>
//   Mailery-Signature: v1=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
//
// Always verify over the RAW request body bytes (before any JSON parsing or
// re-serialization) and reject timestamps outside the replay window.

import type { MaileryWebhookEvent } from "./types.js";

export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

export interface VerifyWebhookSignatureInput {
  /** The endpoint's signing secret, shown once at create/rotate. */
  secret: string;
  /** Raw request body exactly as received. */
  body: string | Uint8Array;
  /** Value of the Mailery-Signature header. */
  signature: string | null | undefined;
  /** Value of the Mailery-Timestamp header. */
  timestamp: string | number | null | undefined;
  /** Replay tolerance in seconds (default 300). */
  toleranceSeconds?: number;
  /** Injectable clock in unix seconds (tests). */
  nowSeconds?: number;
}

export type VerifyWebhookSignatureResult =
  | { ok: true }
  | { ok: false; reason: "malformed_signature" | "malformed_timestamp" | "timestamp_out_of_tolerance" | "signature_mismatch" };

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmacSha256(secret: string, message: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error("verifyWebhookSignature requires WebCrypto (globalThis.crypto.subtle)");
  const encoder = new TextEncoder();
  const key = await subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, message));
}

/**
 * Verify a Mailery webhook delivery. Returns `{ ok: true }` or a reason; it
 * never throws on bad input (only when WebCrypto is unavailable).
 */
export async function verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<VerifyWebhookSignatureResult> {
  const tolerance = input.toleranceSeconds ?? WEBHOOK_REPLAY_WINDOW_SECONDS;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "malformed_timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };
  const candidates = String(input.signature ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (candidates.length === 0) return { ok: false, reason: "malformed_signature" };
  const encoder = new TextEncoder();
  const bodyBytes = typeof input.body === "string" ? encoder.encode(input.body) : input.body;
  const prefix = encoder.encode(`${Math.trunc(ts)}.`);
  const message = new Uint8Array(prefix.length + bodyBytes.length);
  message.set(prefix, 0);
  message.set(bodyBytes, prefix.length);
  const expected = await hmacSha256(input.secret, message);
  for (const candidate of candidates) {
    const presented = hexToBytes(candidate);
    if (presented && constantTimeEqual(presented, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature_mismatch" };
}

/**
 * Verify and parse in one step: resolves to the typed event on success and
 * throws an Error naming the failure reason otherwise.
 */
export async function parseWebhookEvent<TData = Record<string, unknown>>(input: VerifyWebhookSignatureInput): Promise<MaileryWebhookEvent<TData>> {
  const result = await verifyWebhookSignature(input);
  if (!result.ok) throw new Error(`webhook signature verification failed: ${result.reason}`);
  const text = typeof input.body === "string" ? input.body : new TextDecoder().decode(input.body);
  return JSON.parse(text) as MaileryWebhookEvent<TData>;
}
