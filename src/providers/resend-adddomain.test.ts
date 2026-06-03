import { describe, it, expect } from "bun:test";
import { ResendAdapter } from "./resend.js";

function adapterWith(createImpl: any) {
  const a = new ResendAdapter({ id: "p", name: "resend", type: "resend", api_key: "re_x", active: true } as any);
  (a as any).client = { domains: { create: createImpl } };
  return a;
}

describe("ResendAdapter.addDomain", () => {
  it("throws a clear error when Resend returns an error (plan limit)", async () => {
    const a = adapterWith(async () => ({ data: null, error: { message: "Your plan includes 1 domain. Upgrade to add more." } }));
    await expect(a.addDomain("x.com")).rejects.toThrow(/Your plan includes 1 domain/);
  });
  it("succeeds when Resend returns data with no error", async () => {
    const a = adapterWith(async () => ({ data: { id: "d1" }, error: null }));
    await expect(a.addDomain("x.com")).resolves.toBeUndefined();
  });
});
