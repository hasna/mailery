import { describe, it, expect } from "bun:test";
import {
  resolveCloudflareAuth,
  cloudflareAuthEnv,
  describeCloudflareAuth,
} from "./cloudflare-auth.js";

describe("resolveCloudflareAuth — priority", () => {
  it("prefers an explicit config token", () => {
    const auth = resolveCloudflareAuth({ configToken: "cfg-token", env: { CLOUDFLARE_API_TOKEN: "env-token" } });
    expect(auth).toEqual({ kind: "token", token: "cfg-token" });
  });

  it("falls back to CLOUDFLARE_API_TOKEN env", () => {
    const auth = resolveCloudflareAuth({ env: { CLOUDFLARE_API_TOKEN: "env-token" } });
    expect(auth).toEqual({ kind: "token", token: "env-token" });
  });

  it("uses config global key + email when no token", () => {
    const auth = resolveCloudflareAuth({ configApiKey: "gk", configEmail: "a@b.com", env: {} });
    expect(auth).toEqual({ kind: "global", apiKey: "gk", email: "a@b.com" });
  });

  it("prefers an injected environment token over config global credentials", () => {
    const auth = resolveCloudflareAuth({
      configApiKey: "gk",
      configEmail: "a@b.com",
      env: { CLOUDFLARE_API_TOKEN: "env-token" },
    });
    expect(auth).toEqual({ kind: "token", token: "env-token" });
  });

  it("uses CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL env", () => {
    const auth = resolveCloudflareAuth({ env: { CLOUDFLARE_API_KEY: "gk", CLOUDFLARE_EMAIL: "a@b.com" } });
    expect(auth).toEqual({ kind: "global", apiKey: "gk", email: "a@b.com" });
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveCloudflareAuth({ env: {} })).toBeUndefined();
  });

  it("does not treat a bare global key without email as global", () => {
    // key present but no email → not enough for global; no token either → undefined
    expect(resolveCloudflareAuth({ env: { CLOUDFLARE_API_KEY: "gk" } })).toBeUndefined();
  });
});

describe("cloudflareAuthEnv — connector env mapping", () => {
  it("maps a token to CLOUDFLARE_API_TOKEN", () => {
    expect(cloudflareAuthEnv({ kind: "token", token: "t" })).toEqual({ CLOUDFLARE_API_TOKEN: "t" });
  });

  it("maps global to CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL", () => {
    expect(cloudflareAuthEnv({ kind: "global", apiKey: "gk", email: "a@b.com" })).toEqual({
      CLOUDFLARE_API_KEY: "gk",
      CLOUDFLARE_EMAIL: "a@b.com",
    });
  });
});

describe("describeCloudflareAuth — for doctor output", () => {
  it("describes token mode without leaking the secret", () => {
    const s = describeCloudflareAuth({ kind: "token", token: "supersecret" });
    expect(s).toContain("scoped token");
    expect(s).not.toContain("supersecret");
  });

  it("describes global mode with the email", () => {
    const s = describeCloudflareAuth({ kind: "global", apiKey: "gk", email: "a@b.com" });
    expect(s).toContain("global key");
    expect(s).toContain("a@b.com");
    expect(s).not.toContain("gk");
  });
});
