import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createAddress } from "../../db/addresses.js";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createOwner, assignAddressOwner } from "../../db/owners.js";
import { createProvider } from "../../db/providers.js";
import { registerOwnerCommands } from "./owner.js";

async function runOwnerCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerOwnerCommands(program, (d, formatted) => {
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

describe("owner commands", () => {
  it("paginates owner list output", async () => {
    const db = getDatabase();
    for (let i = 0; i < 5; i++) {
      const owner = createOwner({ type: "agent", name: `owner-${i}` });
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE owners SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, owner.id]);
    }

    const result = await runOwnerCommand(["owner", "list", "--type", "agent", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ name: string }>;

    expect(data.map((owner) => owner.name)).toEqual(["owner-3", "owner-2"]);
    expect(result.out).toContain("owner-3");
    expect(result.out).not.toContain("owner-4");
  });

  it("lists owned addresses with provider, owner, and administrator details", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const human = createOwner({ type: "human", name: "human-user" });
    const agent = createOwner({ type: "agent", name: "agent-admin" });
    const address = createAddress({ provider_id: provider.id, email: "human@example.com" });
    assignAddressOwner(address.id, human.id, agent.id);

    const result = await runOwnerCommand(["owner", "addresses", "human-user"]);

    expect(result.out).toContain("human-user owns");
    expect(result.out).toContain("sandbox");
    expect(result.out).toContain("owner=human-user(human)");
    expect(result.out).toContain("admin=agent-admin");
    expect(result.data).toMatchObject([
      {
        email: "human@example.com",
        provider_name: "sandbox",
        owner: { id: human.id, name: "human-user" },
        administrator: { id: agent.id, name: "agent-admin" },
      },
    ]);
  });

  it("paginates owner addresses before enrichment", async () => {
    const db = getDatabase();
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const agent = createOwner({ type: "agent", name: "paged-owner" });
    for (let i = 0; i < 5; i++) {
      const address = createAddress({ provider_id: provider.id, email: `paged-${i}@example.com` });
      assignAddressOwner(address.id, agent.id);
      const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
      db.run("UPDATE addresses SET created_at = ?, updated_at = ? WHERE id = ?", [timestamp, timestamp, address.id]);
    }

    const result = await runOwnerCommand(["owner", "addresses", "paged-owner", "--limit", "2", "--offset", "1"]);
    const data = result.data as Array<{ email: string }>;

    expect(data.map((address) => address.email)).toEqual([
      "paged-3@example.com",
      "paged-2@example.com",
    ]);
    expect(result.out).not.toContain("paged-4@example.com");
  });
});
