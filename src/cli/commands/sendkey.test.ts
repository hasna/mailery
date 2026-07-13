// Self-hosted-ONLY: the send-keys resource is summary-only (the secret key_hash
// never leaves the server). Listing/revoking/checking route to `/v1`, and minting
// routes to the bespoke POST /v1/send-keys/mint endpoint (token returned once), so
// these tests drive the REAL command against an out-of-process /v1 stub (see
// src/test-support/v1-stub.ts). No local SQLite exists anymore.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { startV1Stub, type V1Stub } from "../../test-support/v1-stub.js";
import { registerSendKeyCommands } from "./sendkey.js";

let stub: V1Stub;
const OWNER_ID = "owner-sendkey-agent";

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

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});
afterEach(() => stub.clearEnv());

describe("sendkey list command", () => {
  it("paginates send keys and displays owner names without leaking hashes", async () => {
    await stub.seed({
      owners: [{
        id: OWNER_ID,
        type: "agent",
        name: "sendkey-agent",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
      "send-keys": [0, 1, 2, 3, 4].map((i) => ({
        id: `sk-${i}`,
        owner_id: OWNER_ID,
        prefix: `pf${i}`,
        label: `key-${i}`,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        last_used_at: null,
        revoked_at: null,
      })),
    });

    const result = await runSendKeyCommand(["sendkey", "list", "--owner", "sendkey-agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<Record<string, unknown> & { label: string | null; owner_id: string }>;

    expect(data.map((key) => key.label)).toEqual(["key-3", "key-2"]);
    expect(data.every((key) => key.owner_id === OWNER_ID)).toBe(true);
    expect(data.every((key) => !("key_hash" in key))).toBe(true);
    expect(result.out).toContain("sendkey-agent");
    expect(result.out).not.toContain("key-4");
  });
});

describe("sendkey create command", () => {
  it("mints a send key via /v1 and returns the token once", async () => {
    await stub.seed({
      owners: [{
        id: "o-1",
        type: "agent",
        name: "sk-owner",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
    });

    const result = await runSendKeyCommand(["sendkey", "create", "sk-owner", "--label", "ci"]);
    const data = result.data as { id: string; token: string; owner_id: string; label: string | null };

    expect(data.token).toMatch(/^esk_/);
    expect(data.owner_id).toBe("o-1");
    expect(data.label).toBe("ci");
    expect(data.id.length).toBeGreaterThan(0);

    // The minted key is now listable via /v1 (summary only, no hash).
    const list = await runSendKeyCommand(["sendkey", "list", "--owner", "sk-owner"]);
    const keys = list.data as Array<Record<string, unknown> & { id: string }>;
    expect(keys.map((k) => k.id)).toContain(data.id);
    expect(keys.every((k) => !("key_hash" in k))).toBe(true);
  });
});
