// Opaque bearer tokens for self-hosted auth — sessions, password resets, invites.
//
// Design ref: docs/design/multi-tenancy-auth.md §4.2. These are opaque random
// tokens (256-bit), NOT JWTs, so they can be revoked instantly by flipping a DB
// row. Only the sha256 hash is stored (mirroring the send-key pattern in
// store.ts: `hashSendToken` / `send_key_secrets.key_hash`); the plaintext is
// returned to the client exactly once at mint time and never persisted. Lookups
// are a constant-time indexed hash equality.
//
// Pure module (crypto only, no DB) — unit-tested.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Session bearer token prefix. Dispatched on by the auth resolver (§4.3). */
export const SESSION_TOKEN_PREFIX = "emss_";
/** Password-reset token prefix. */
export const RESET_TOKEN_PREFIX = "emrt_";
/** Invitation token prefix. */
export const INVITE_TOKEN_PREFIX = "emiv_";

/** Bytes of entropy per token. 32 bytes = 256 bits. */
export const TOKEN_ENTROPY_BYTES = 32;

export interface MintedToken {
  /** The plaintext token — returned to the client ONCE, never stored. */
  readonly token: string;
  /** The sha256 hex of the token — this is what is stored at rest. */
  readonly tokenHash: string;
}

/** sha256 hex of a token — the only form persisted (`*.token_hash`). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mint(prefix: string): MintedToken {
  const token = `${prefix}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashToken(token) };
}

/** Mint an opaque session token (`emss_…`) + its at-rest hash. */
export function mintSessionToken(): MintedToken {
  return mint(SESSION_TOKEN_PREFIX);
}

/** Mint an opaque password-reset token (`emrt_…`) + its at-rest hash. */
export function mintResetToken(): MintedToken {
  return mint(RESET_TOKEN_PREFIX);
}

/** Mint an opaque invitation token (`emiv_…`) + its at-rest hash. */
export function mintInviteToken(): MintedToken {
  return mint(INVITE_TOKEN_PREFIX);
}

/**
 * Constant-time check that a presented token hashes to `expectedHash`. Compares
 * the hex digests with `timingSafeEqual` so a match cannot be found by timing.
 * Returns false on any shape mismatch rather than throwing.
 */
export function verifyToken(token: string, expectedHash: string): boolean {
  if (typeof token !== "string" || typeof expectedHash !== "string") return false;
  const actual = hashToken(token);
  if (actual.length !== expectedHash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expectedHash, "utf8"));
  } catch {
    return false;
  }
}

/** Whether a credential looks like a self-hosted session token. */
export function isSessionToken(token: string): boolean {
  return typeof token === "string" && token.startsWith(SESSION_TOKEN_PREFIX);
}
