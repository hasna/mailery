import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderConfigError } from "../types/index.js";
import { getAdapter } from "./index.js";
import type { Provider } from "../types/index.js";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: "provider-1",
    name: "Provider",
    type: "sandbox",
    active: true,
    ...overrides,
  } as Provider;
}

describe("getAdapter", () => {
  it("keeps constructor-level validation without importing provider SDK modules", () => {
    expect(() => getAdapter(provider({ type: "resend", api_key: null }))).toThrow(ProviderConfigError);
    expect(() => getAdapter(provider({ type: "imap" as Provider["type"] }))).toThrow("Unknown provider type: imap");
  });

  it("preserves optional SES-only MAIL FROM support on the lazy adapter", () => {
    expect(typeof getAdapter(provider({ type: "ses" })).setMailFrom).toBe("function");
    expect(getAdapter(provider({ type: "resend", api_key: "re_test" })).setMailFrom).toBeUndefined();
    expect(getAdapter(provider({ type: "sandbox" })).setMailFrom).toBeUndefined();
  });

  it("uses dynamic provider adapter imports so CLI startup does not load provider SDKs", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']\.\/(resend|ses|sandbox)\.js["'];/m);
    expect(source).toContain('import("./resend.js")');
    expect(source).toContain('import("./ses.js")');
    expect(source).toContain('import("./sandbox.js")');
  });
});
