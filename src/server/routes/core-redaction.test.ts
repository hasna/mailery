import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
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
  it("omits provider credentials from provider listing responses", async () => {
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

    expect(text).not.toContain("access_key");
    expect(text).not.toContain("secret_key");
    expect(text).not.toContain("oauth_refresh_token");
    expect(text).not.toContain("AKIA_REST_SHOULD_NOT_LEAK");
    expect(text).not.toContain("REST_SECRET_SHOULD_NOT_LEAK");
  });

  it("paginates provider listing while omitting credentials", async () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const provider = createProvider({
        name: `provider-${i}`,
        type: "ses",
        region: "us-east-1",
        access_key: `AKIA_REST_PAGE_${i}`,
        secret_key: `REST_PAGE_SECRET_${i}`,
      });
      db.run("UPDATE providers SET created_at = ? WHERE id = ?", [`2026-01-0${i}T00:00:00.000Z`, provider.id]);
    }

    const response = await call("/api/providers?limit=2&offset=1");
    expect(response).toBeTruthy();
    const providers = await response!.json() as Array<Record<string, unknown>>;

    expect(providers).toHaveLength(2);
    expect(providers.map((provider) => provider.name)).toEqual(["provider-3", "provider-2"]);
    expect(providers.every((provider) => !("access_key" in provider) && !("secret_key" in provider))).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("REST_PAGE_SECRET");
  });

  it("defaults provider listing to a bounded page while omitting credentials", async () => {
    for (let i = 1; i <= 51; i++) {
      createProvider({
        name: `default-provider-${i}`,
        type: "ses",
        region: "us-east-1",
        access_key: `AKIA_REST_DEFAULT_${i}`,
        secret_key: `REST_DEFAULT_SECRET_${i}`,
      });
    }

    const response = await call("/api/providers");
    expect(response).toBeTruthy();
    const providers = await response!.json() as Array<Record<string, unknown>>;

    expect(providers).toHaveLength(50);
    expect(providers.every((provider) => !("access_key" in provider) && !("secret_key" in provider))).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("REST_DEFAULT_SECRET");
  });
});
