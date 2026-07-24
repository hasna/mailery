// Unit coverage for the shared RLS boot guard extracted from serve.ts so the
// headless ingest worker can fail closed at boot. The integration behavior
// against a real role is covered by rls.integration.test.ts; these tests pin the
// pure decision logic (pass vs. loud refusal) without a database.

import { describe, expect, test } from "bun:test";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { assertServingRoleCannotBypassRls } from "./rls-guard.js";

function clientReturning(
  row: { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | null,
): TypedQueryClient {
  return {
    async query() { throw new Error("query not expected"); },
    async many() { throw new Error("many not expected"); },
    async get<T>(sql: string): Promise<T | null> {
      if (sql.includes("FROM pg_roles")) return row as T | null;
      throw new Error(`unexpected get SQL: ${sql.slice(0, 60)}`);
    },
    async one() { throw new Error("one not expected"); },
    async execute() {},
  };
}

describe("assertServingRoleCannotBypassRls", () => {
  test("resolves for a NOSUPERUSER, NOBYPASSRLS serving role", async () => {
    const client = clientReturning({ rolname: "emails_app", rolsuper: false, rolbypassrls: false });
    await expect(assertServingRoleCannotBypassRls(client)).resolves.toBeUndefined();
  });

  test("refuses to start when the role is a superuser", async () => {
    const client = clientReturning({ rolname: "postgres", rolsuper: true, rolbypassrls: false });
    await expect(assertServingRoleCannotBypassRls(client)).rejects.toThrow(/bypass Row-Level Security/i);
  });

  test("refuses to start when the role has BYPASSRLS", async () => {
    const client = clientReturning({ rolname: "svc", rolsuper: false, rolbypassrls: true });
    await expect(assertServingRoleCannotBypassRls(client)).rejects.toThrow(/bypass Row-Level Security/i);
  });

  test("refuses to start when the role row cannot be read", async () => {
    const client = clientReturning(null);
    await expect(assertServingRoleCannotBypassRls(client)).rejects.toThrow(/could not read/i);
  });
});
