import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ARGON2ID_PARAMS,
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  parseArgon2Phc,
  verifyPassword,
  verifyPasswordOrEqualizeTiming,
} from "./password.js";

describe("password (argon2id via Bun.password)", () => {
  it("hashes to an argon2id PHC string with the current policy params", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    const parsed = parseArgon2Phc(hash);
    expect(parsed?.algorithm).toBe("argon2id");
    expect(parsed?.memoryCost).toBe(DEFAULT_ARGON2ID_PARAMS.memoryCost);
    expect(parsed?.timeCost).toBe(DEFAULT_ARGON2ID_PARAMS.timeCost);
  });

  it("produces a distinct hash each time (random salt) but both verify", async () => {
    const a = await hashPassword("s3cret-pass");
    const b = await hashPassword("s3cret-pass");
    expect(a).not.toBe(b);
    expect(await verifyPassword("s3cret-pass", a)).toBe(true);
    expect(await verifyPassword("s3cret-pass", b)).toBe(true);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("right-password");
    expect(await verifyPassword("right-password", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("rejects empty passwords at hash time", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });

  it("verify returns false (never throws) on a malformed/empty hash", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-phc-string")).toBe(false);
    expect(await verifyPassword("x", "$argon2id$garbage")).toBe(false);
  });

  it("needsRehash: false for a current-policy hash", async () => {
    const hash = await hashPassword("pw");
    expect(needsRehash(hash)).toBe(false);
  });

  it("needsRehash: true for weaker params, non-argon2id, and garbage", async () => {
    const weaker = await hashPassword("pw", { memoryCost: 8192, timeCost: 1 });
    expect(needsRehash(weaker)).toBe(true);
    // A bcrypt-shaped PHC is not argon2id.
    expect(needsRehash("$2b$12$abcdefghijklmnopqrstuv")).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
    // Still valid against a lower target if it meets it (raising floor only).
    expect(needsRehash(weaker, { memoryCost: 8192, timeCost: 1 })).toBe(false);
  });

  it("parseArgon2Phc: null for non-PHC input", () => {
    expect(parseArgon2Phc("")).toBeNull();
    expect(parseArgon2Phc("plaintext")).toBeNull();
    expect(parseArgon2Phc("$")).toBeNull();
  });

  it("dummyPasswordHash is a valid, cached argon2id hash", async () => {
    const first = await dummyPasswordHash();
    const second = await dummyPasswordHash();
    expect(first).toBe(second); // cached
    expect(first.startsWith("$argon2id$")).toBe(true);
  });

  it("verifyPasswordOrEqualizeTiming: false for unknown account, true only on real match", async () => {
    expect(await verifyPasswordOrEqualizeTiming("anything", null)).toBe(false);
    expect(await verifyPasswordOrEqualizeTiming("anything", undefined)).toBe(false);
    const hash = await hashPassword("real-pw");
    expect(await verifyPasswordOrEqualizeTiming("real-pw", hash)).toBe(true);
    expect(await verifyPasswordOrEqualizeTiming("bad-pw", hash)).toBe(false);
  });
});
