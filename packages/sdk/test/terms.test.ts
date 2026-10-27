import { describe, expect, test } from "bun:test";
import { MaileryClient } from "../src/client.js";
import { callTool, MCP_TOOLS } from "../src/mcp.js";
const version = "a".repeat(64);
describe("Terms SDK and MCP contract", () => {
  test("MCP signup schema admits legacy discovery without implying acceptance", () => {
    const schema = MCP_TOOLS.find(tool => tool.name === "signup")!.inputSchema;
    expect(schema.required).toEqual(["email", "password"]);
    expect(schema.properties.acceptedTerms).toEqual({ type: "boolean", const: true });
    expect(schema.properties.termsVersion).toEqual({ type: "string" });
  });

  test("published MCP signup requires explicit consent before creating an account", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", retries: 0, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(path.endsWith("/current") ? { version, url: `/api/v1/terms/versions/${version}` } : { token: "synthetic" });
    }});
    for (const consent of [{}, { acceptedTerms: false, termsVersion: version }, { acceptedTerms: true }]) {
      const result = await callTool("signup", { email: "new@example.test", password: "Testing1234", ...consent }, client);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("terms_acceptance_required");
    }
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ path: "/api/v1/terms/current", body: null })));
    const result = await callTool("signup", { email: "new@example.test", password: "Testing1234", acceptedTerms: true, termsVersion: version }, client);
    expect(result.isError).not.toBe(true);
    expect(calls.slice(-2).map(call => call.path)).toEqual(["/api/v1/terms/current", "/api/v1/auth/signup"]);
    expect(calls.at(-1)!.body).toMatchObject({ acceptedTerms: true, termsVersion: version });
  });

  test("held signup preserves the same paused message through SDK and MCP for both caller shapes", async () => {
    const message = "Signup and new purchases are temporarily paused. Please try again later.";
    const calls: string[] = [];
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", retries: 0, fetch: async url => {
      calls.push(new URL(String(url)).pathname);
      return Response.json({ error: { code: "terms_unavailable", message } }, { status: 503 });
    }});
    for (const terms of [{}, { acceptedTerms: true as const, termsVersion: version }]) {
      const input = { email: "held@example.test", password: "Testing1234", ...terms };
      await expect(client.signup(input)).rejects.toMatchObject({ code: "terms_unavailable", message });
      const result = await callTool("signup", input, client);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(message);
      expect(JSON.stringify(result)).not.toContain("Read get_terms");
    }
    expect(calls).toEqual(["/api/v1/auth/signup", "/api/v1/terms/current", "/api/v1/auth/signup", "/api/v1/terms/current"]);
  });

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
  test("MCP discovery resolves public Terms fields against its configured base", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", retries: 0, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith("/current")) return Response.json({ version, url: `/api/v1/terms/versions/${version}` });
      return Response.json({ token: "synthetic", user: { email: "new@example.test" }, tenant: { slug: "new" } });
    }});
    const terms = { url: `http://127.0.0.1:9/api/v1/terms/versions/${version}`, version };
    for (const consent of [{}, { acceptedTerms: false, termsVersion: version }, { acceptedTerms: true }]) {
      const result = await callTool("signup", { email: "new@example.test", password: "Testing1234", ...consent }, client);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: "terms_acceptance_required", terms });
    }
    expect(calls.every(call => call.path === "/api/v1/terms/current")).toBe(true);
    const result = await callTool("signup", { email: "new@example.test", password: "Testing1234", acceptedTerms: true, termsVersion: version }, client);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ terms, token: "synthetic", user: { email: "new@example.test" }, tenant: { slug: "new" } });
    expect(calls.slice(-2).map(call => call.path)).toEqual(["/api/v1/terms/current", "/api/v1/auth/signup"]);
    expect(calls.at(-1)!.body).toMatchObject({ acceptedTerms: true, termsVersion: version });
    expect(JSON.parse((await callTool("get_terms", {}, client)).content[0]!.text)).toEqual(terms);
  });
  test("MCP preserves explicit stale-version server rejection order and the discovered version", async () => {
    const paths: string[] = []; const stale = "c".repeat(64);
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", retries: 0, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path.endsWith("/current")) return Response.json({ version, url: `/api/v1/terms/versions/${version}` });
      expect(JSON.parse(String(init?.body))).toMatchObject({ acceptedTerms: true, termsVersion: stale });
      return Response.json({ error: { code: "terms_version_mismatch", message: "Version is not currently published" } }, { status: 428 });
    }});
    const result = await callTool("signup", { email: "new@example.test", password: "Testing1234", acceptedTerms: true, termsVersion: stale }, client);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: "terms_version_mismatch", status: 428, terms: { version, url: `http://127.0.0.1:9/api/v1/terms/versions/${version}` } });
    expect(paths).toEqual(["/api/v1/terms/current", "/api/v1/auth/signup"]);
    expect(MCP_TOOLS.find(tool => tool.name === "accept_terms")!.description).toContain("an explicit yes from the person");
    expect(MCP_TOOLS.find(tool => tool.name === "accept_terms")!.description).toContain("an agent they authorized");
  });

});
