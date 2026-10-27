import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MaileryClient } from "../src/client.js";
import { callTool, handleMcpMessage } from "../src/mcp.js";
import { SDK_VERSION } from "../src/version.js";
import type { TermsAcceptanceReceipt } from "../src/types.js";
const consent = { acceptedTerms: true as const, termsVersion: "a".repeat(64) };
test("SDK uses its public shipped version, custom declaration, or explicit omission on acceptance only", async () => {
  expect(SDK_VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  for (const clientDeclaration of [undefined, null, { name: "custom-agent", version: "2.4.1" }]) {
    const rows: { path: string; headers: Record<string, string> }[] = [];
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", clientDeclaration, retries: 0, fetch: async (url, init) => {
      rows.push({ path: new URL(url).pathname, headers: init?.headers as Record<string, string> });
      return Response.json({ token: "synthetic-session" });
    } });
    await client.signup({ email: "fixture@example.test", password: "Synthetic password 1234", ...consent });
    await client.acceptTerms(consent);
    await client.getCurrentTerms();
    for (const row of rows.slice(0, 2)) {
      expect(row.headers["x-mailery-client-name"]).toBe(clientDeclaration === null ? undefined : clientDeclaration?.name ?? "mailery-sdk");
      expect(row.headers["x-mailery-client-version"]).toBe(clientDeclaration === null ? undefined : clientDeclaration?.version ?? SDK_VERSION);
    }
    expect(rows[2]!.headers["x-mailery-client-name"]).toBeUndefined();
    expect(rows[2]!.headers["x-mailery-client-version"]).toBeUndefined();
  }
});
test("partial and malformed declarations preserve server errors, including held publication precedence", async () => {
  for (const declaration of [{ name: "partial" }, { version: "1" }, { name: "bad☃", version: "1" }, { name: "valid", version: "x".repeat(33) }]) {
    for (const status of [400, 503]) {
      let headers: Record<string, string> = {};
      const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", retries: 0,
        clientDeclaration: declaration as { name: string; version: string }, fetch: async (_, init) => {
          headers = init?.headers as Record<string, string>;
          return Response.json({ error: { code: status === 503 ? "terms_unavailable" : "bad_request", message: "synthetic refusal" } }, { status });
        } });
      await expect(client.acceptTerms(consent)).rejects.toMatchObject({ status, code: status === 503 ? "terms_unavailable" : "bad_request" });
      expect(headers["x-mailery-client-name"]).toBe(declaration.name);
      expect(headers["x-mailery-client-version"]).toBe(declaration.version);
    }
  }
});
test("declared, undeclared and historical unrecorded receipts pass through without inference", async () => {
  for (const clientReceipt of [
    { declaration: "declared" as const, name: "custom-agent", version: "1.2" },
    { declaration: "undeclared" as const, name: null, version: null },
    { declaration: "unrecorded" as const, name: null, version: null },
  ]) {
    const receipt: TermsAcceptanceReceipt = { version: consent.termsVersion, url: "/terms", acceptedAt: "2026-10-27T00:00:00Z", client: clientReceipt };
    const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", sessionToken: "synthetic", retries: 0, fetch: async () => Response.json(receipt) });
    expect(await client.acceptTerms(consent)).toEqual(receipt);
  }
});
test("MCP uses its transport version and preserves the original SDK session and later declaration", async () => {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const client = new MaileryClient({ baseUrl: "http://127.0.0.1:9", retries: 0, clientDeclaration: { name: "custom-sdk", version: "9" }, fetch: async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, headers: init?.headers as Record<string, string> });
    return Response.json(path === "/api/v1/terms/current" ? { version: consent.termsVersion } : { token: "synthetic-session" });
  } });
  await callTool("signup", { email: "fixture@example.test", password: "Synthetic password 1234", ...consent }, client);
  await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "accept_terms", arguments: consent } }, client, { name: "mailery", version: "3.2.1" });
  await client.acceptTerms(consent);
  expect(calls[0]!.headers["x-mailery-client-name"]).toBeUndefined();
  expect(calls[1]!.headers["x-mailery-client-name"]).toBe("mailery-mcp");
  expect(calls[1]!.headers["x-mailery-client-version"]).toBe(SDK_VERSION);
  expect(calls[2]!.headers["x-mailery-client-version"]).toBe("3.2.1");
  expect(calls[2]!.headers.authorization).toBe("Bearer synthetic-session");
  expect(calls[3]!.headers["x-mailery-client-name"]).toBe("custom-sdk");
  expect(calls[3]!.headers.authorization).toBe("Bearer synthetic-session");
});
