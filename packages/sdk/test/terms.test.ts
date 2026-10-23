import { describe, expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";
import { callTool } from "../src/mcp.js";
const version = "a".repeat(64);
describe("Terms SDK and MCP contract", () => {
  test("SDK shows exact version, retrieves archive, and forwards explicit acceptance", async () => {
    const calls: Array<{ path: string; body: unknown; auth: unknown }> = [];
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", retries: 0, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string>).authorization });
      if (path.includes("/versions/")) return new Response("<html>Exact archived Terms</html>");
      return Response.json({ version, url: `/api/v1/terms/versions/${version}`, acceptedAt: "2026-10-23T00:00:00Z" });
    }});
    expect((await client.getCurrentTerms()).version).toBe(version);
    expect(await client.getTermsVersion(version)).toContain("Exact archived Terms");
    await client.acceptTerms({ acceptedTerms: true, termsVersion: version });
    expect(calls[0]!.auth).toBeUndefined();
    expect(calls[1]!.path).toBe(`/api/v1/terms/versions/${version}`);
    expect(calls[2]!.body).toEqual({ acceptedTerms: true, termsVersion: version });
    expect(calls[2]!.auth).toBe("Bearer synthetic");
  });
  test("MCP never fills silent acceptance, but forwards an explicit exact version", async () => {
    let calls = 0;
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", retries: 0, fetch: async () => { calls++; return Response.json({ version }); } });
    for (const acceptedTerms of [undefined, false, "true"]) {
      const result = await callTool("accept_terms", { acceptedTerms, termsVersion: version }, client);
      expect(result.isError).toBe(true);
    }
    expect(calls).toBe(0);
    const result = await callTool("accept_terms", { acceptedTerms: true, termsVersion: version }, client);
    expect(result.isError).not.toBe(true); expect(calls).toBe(1);
  });
  test("legacy SDK signup does not silently synthesize consent", async () => {
    let body: unknown;
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", retries: 0, fetch: async (_, init) => { body = JSON.parse(String(init?.body)); return Response.json({ error: { code: "terms_acceptance_required", message: "required" } }, { status: 428 }); } });
    await expect(client.signup({ email: "test@example.test", password: "Testing1234" })).rejects.toMatchObject({ code: "terms_acceptance_required" });
    expect(body).toEqual({ email: "test@example.test", password: "Testing1234" });
  });
});
