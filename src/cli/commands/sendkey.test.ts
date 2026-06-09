import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createOwner } from "../../db/owners.js";
import { createSendKey } from "../../db/send-keys.js";
import { registerSendKeyCommands } from "./sendkey.js";

async function runSendKeyCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerSendKeyCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("sendkey list command", () => {
  it("paginates send keys and displays owner names without per-row lookup output drift", async () => {
    const db = getDatabase();
    const owner = createOwner({ type: "agent", name: "sendkey-agent" });
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const key = createSendKey(owner.id, `key-${i}`).key;
      hashes.push(key.key_hash);
      db.run("UPDATE send_keys SET created_at = ? WHERE id = ?", [`2026-01-0${i + 1}T00:00:00.000Z`, key.id]);
    }

    const result = await runSendKeyCommand(["sendkey", "list", "--owner", "sendkey-agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<Record<string, unknown> & { label: string | null; owner_id: string }>;

    expect(data.map((key) => key.label)).toEqual(["key-3", "key-2"]);
    expect(data.every((key) => key.owner_id === owner.id)).toBe(true);
    expect(data.every((key) => !("key_hash" in key))).toBe(true);
    expect(hashes.some((hash) => JSON.stringify(data).includes(hash))).toBe(false);
    expect(result.out).toContain("sendkey-agent");
    expect(result.out).not.toContain("key-4");
  });
});
