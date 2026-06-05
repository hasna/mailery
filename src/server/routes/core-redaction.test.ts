import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { handle } from "./core.js";

function call(path: string, init?: RequestInit) {
  const req = new Request(`http://127.0.0.1:3900${path}`, init);
  const url = new URL(req.url);
  return handle(req, url, url.pathname, req.method);
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("core REST redaction", () => {
  it("redacts provider credentials from provider listing responses", async () => {
    createProvider({
      name: "secret-ses",
      type: "ses",
      region: "us-east-1",
      access_key: "AKIA_REST_SHOULD_NOT_LEAK",
      secret_key: "REST_SECRET_SHOULD_NOT_LEAK",
    });

    const response = await call("/api/providers");
    expect(response).toBeTruthy();
    const text = await response!.text();

    expect(text).toContain('"access_key":"***"');
    expect(text).toContain('"secret_key":"***"');
    expect(text).not.toContain("AKIA_REST_SHOULD_NOT_LEAK");
    expect(text).not.toContain("REST_SECRET_SHOULD_NOT_LEAK");
  });
});
