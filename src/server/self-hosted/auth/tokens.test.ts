import { describe, expect, it } from "bun:test";
import {
  hashToken,
  INVITE_TOKEN_PREFIX,
  isSessionToken,
  mintInviteToken,
  mintResetToken,
  mintSessionToken,
  RESET_TOKEN_PREFIX,
  SESSION_TOKEN_PREFIX,
  verifyToken,
} from "./tokens.js";

describe("opaque auth tokens", () => {
  it("mints a prefixed session token carrying 256 bits of entropy", () => {
    const { token, tokenHash } = mintSessionToken();
    expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    // base64url of 32 bytes = 43 chars, after the prefix.
    expect(token.length - SESSION_TOKEN_PREFIX.length).toBe(43);
    // sha256 hex is 64 chars and matches hashToken(token).
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reset and invite tokens carry their own prefixes", () => {
    expect(mintResetToken().token.startsWith(RESET_TOKEN_PREFIX)).toBe(true);
    expect(mintInviteToken().token.startsWith(INVITE_TOKEN_PREFIX)).toBe(true);
  });

  it("mints unique tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mintSessionToken().token);
    expect(seen.size).toBe(200);
  });

  it("verifyToken accepts the right token and rejects tampered/foreign ones", () => {
    const { token, tokenHash } = mintSessionToken();
    expect(verifyToken(token, tokenHash)).toBe(true);
    expect(verifyToken(`${token}x`, tokenHash)).toBe(false);
    expect(verifyToken(mintSessionToken().token, tokenHash)).toBe(false);
  });

  it("verifyToken is safe on malformed input", () => {
    expect(verifyToken("", "")).toBe(false);
    expect(verifyToken("emss_abc", "")).toBe(false);
    // @ts-expect-error runtime robustness against non-strings
    expect(verifyToken(null, null)).toBe(false);
  });

  it("hashToken never returns the plaintext and is stable", () => {
    const { token } = mintSessionToken();
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    expect(h1).toBe(h2);
    expect(h1).not.toContain(token);
  });

  it("isSessionToken distinguishes by prefix", () => {
    expect(isSessionToken(mintSessionToken().token)).toBe(true);
    expect(isSessionToken("hasna_somekey")).toBe(false);
    expect(isSessionToken("esk_sendkey")).toBe(false);
    expect(isSessionToken(mintResetToken().token)).toBe(false);
  });
});
