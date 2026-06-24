import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";
import { createAddress, listAddresses } from "../../db/addresses.js";
import { createOwner } from "../../db/owners.js";
import { getAddressProvisioning } from "../../db/provisioning.js";
import { registerAddressCommands } from "./address.js";

async function runAddressCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerAddressCommands(program, (d, formatted) => {
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

describe("address ownership commands", () => {
  it("shows and assigns an agent owner by address email", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createAddress({ provider_id: provider.id, email: "ops@example.com" });
    createOwner({ type: "agent", name: "cli-agent" });

    const set = await runAddressCommand(["address", "set-owner", "ops@example.com", "--owner", "cli-agent"]);
    expect(set.out).toContain("owned by cli-agent");
    expect(set.data).toMatchObject({ address: { email: "ops@example.com", owner: { name: "cli-agent" } } });

    const owner = await runAddressCommand(["address", "owner", "ops@example.com"]);
    expect(owner.out).toContain("Owner:");
    expect(owner.data).toMatchObject({ address: { owner: { name: "cli-agent" } } });
  });

  it("enriches address list output with owner and administrator", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = createAddress({ provider_id: provider.id, email: "human@example.com" });
    const human = createOwner({ type: "human", name: "human-user" });
    const agent = createOwner({ type: "agent", name: "support-agent" });
    getDatabase().run("UPDATE addresses SET owner_id = ?, administrator_id = ? WHERE id = ?", [human.id, agent.id, address.id]);

    const compactList = await runAddressCommand(["address", "list"]);
    expect(compactList.out).toContain("human-user");
    expect(compactList.out).toContain("use --verbose");

    const list = await runAddressCommand(["address", "list", "--verbose"]);
    expect(list.out).toContain("owner human-user (human)");
    expect(list.out).toContain("admin support-agent");
    expect(list.data).toMatchObject([{ email: "human@example.com", owner: { name: "human-user" }, administrator: { name: "support-agent" } }]);
  });

  it("transfers, unassigns, and shows ownership history", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createAddress({ provider_id: provider.id, email: "move@example.com" });
    createOwner({ type: "agent", name: "first-agent" });
    createOwner({ type: "agent", name: "second-agent" });

    await runAddressCommand(["address", "set-owner", "move@example.com", "--owner", "first-agent"]);

    const transfer = await runAddressCommand([
      "address", "transfer-owner", "move@example.com",
      "--owner", "second-agent",
      "--reason", "handoff",
      "--actor", "test",
      "--yes",
    ]);
    expect(transfer.out).toContain("transferred to second-agent");
    expect(transfer.data).toMatchObject({ address: { owner: { name: "second-agent" } } });

    const unassign = await runAddressCommand([
      "address", "unassign-owner", "move@example.com",
      "--reason", "retired",
      "--actor", "test",
      "--yes",
    ]);
    expect(unassign.out).toContain("is now unowned");
    expect(unassign.data).toMatchObject({ address: { owner: null, administrator: null } });

    const history = await runAddressCommand(["address", "owner-history", "move@example.com"]);
    expect(history.out).toContain("Ownership history");
    expect(history.out).toContain("unassign");
    expect(history.out).toContain("transfer");
    expect(history.data).toMatchObject({
      history: [
        { action: "unassign", reason: "retired", actor: "test" },
        { action: "transfer", reason: "handoff", actor: "test" },
        { action: "assign" },
      ],
    });
  });
});

describe("address list command", () => {
  it("uses a compact implicit default and honors explicit limits", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const db = getDatabase();
    for (let i = 1; i <= 25; i++) {
      const address = createAddress({ provider_id: provider.id, email: `bulk-${String(i).padStart(2, "0")}@example.com` });
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [`2026-01-${String(i).padStart(2, "0")} 00:00:00`, address.id]);
    }

    const compact = await runAddressCommand(["address", "list", "--provider", provider.id]);
    expect(compact.data).toHaveLength(20);
    expect(compact.out).toContain("use --verbose");
    expect(compact.out).toContain("--offset 20");

    const explicit = await runAddressCommand(["address", "list", "--provider", provider.id, "--limit", "25"]);
    expect(explicit.data).toHaveLength(25);
  });

  it("paginates enriched address output", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const address = createAddress({ provider_id: provider.id, email: `addr-${i}@example.com` });
      db.run("UPDATE addresses SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, address.id]);
    }

    const result = await runAddressCommand([
      "address", "list",
      "--provider", provider.id,
      "--limit", "2",
      "--offset", "1",
    ]);

    expect(result.out).toContain("addr-3@example.com");
    expect(result.out).toContain("addr-2@example.com");
    expect(result.out).not.toContain("addr-4@example.com");
    expect(result.data).toMatchObject([
      { email: "addr-3@example.com" },
      { email: "addr-2@example.com" },
    ]);
  });

  it("batches daily quota send counts for listed addresses", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const db = getDatabase();
    const today = new Date().toISOString();
    const first = createAddress({ provider_id: provider.id, email: "quota-a@example.com" });
    const second = createAddress({ provider_id: provider.id, email: "quota-b@example.com" });
    const third = createAddress({ provider_id: provider.id, email: "quota-c@example.com" });
    db.run("UPDATE addresses SET daily_quota = 5 WHERE id IN (?, ?, ?)", [first.id, second.id, third.id]);
    db.run(
      `INSERT INTO emails (id, provider_id, from_address, subject, status, sent_at, created_at, updated_at)
       VALUES ('sent-a-1', ?, ?, 'a', 'sent', ?, ?, ?)`,
      [provider.id, '"Quota A" <quota-a@example.com>', today, today, today],
    );
    db.run(
      `INSERT INTO emails (id, provider_id, from_address, subject, status, sent_at, created_at, updated_at)
       VALUES ('sent-b-1', ?, ?, 'b', 'sent', ?, ?, ?), ('sent-b-2', ?, ?, 'b', 'sent', ?, ?, ?)`,
      [provider.id, "quota-b@example.com", today, today, today, provider.id, "quota-b@example.com", today, today, today],
    );

    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      const result = await runAddressCommand(["address", "list", "--provider", provider.id, "--limit", "10", "--verbose"]);

      expect(result.out).toContain("quota 1/5/day");
      expect(result.out).toContain("quota 2/5/day");
      expect(result.out).toContain("quota 0/5/day");
    } finally {
      db.query = originalQuery;
    }

    const countQueries = queries.filter((sql) => sql.includes("COUNT(*) AS c") && sql.includes("FROM emails"));
    expect(countQueries).toHaveLength(1);
    expect(countQueries[0]).toContain(" IN (");
    expect(countQueries[0]).toContain("GROUP BY");
  });
});

describe("address verify command", () => {
  it("checks one exact address without loading every provider address", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const target = createAddress({ provider_id: provider.id, email: "target@example.com" });
    for (let i = 0; i < 120; i++) {
      createAddress({ provider_id: provider.id, email: `filler-${String(i).padStart(3, "0")}@example.com` });
    }

    const db = getDatabase();
    const originalQuery = db.query;
    const queries: string[] = [];
    db.query = ((sql: string) => {
      queries.push(sql);
      return originalQuery.call(db, sql);
    }) as typeof db.query;

    try {
      await runAddressCommand(["address", "verify", "target@example.com", "--provider", provider.id]);
    } finally {
      db.query = originalQuery;
    }

    const row = db.query("SELECT verified FROM addresses WHERE id = ?").get(target.id) as { verified: number };
    expect(row.verified).toBe(1);
    expect(queries.some((sql) => sql.includes("WHERE email = ? COLLATE NOCASE"))).toBe(true);
    expect(queries.some((sql) => sql.includes("FROM addresses WHERE provider_id = ? ORDER BY created_at DESC"))).toBe(false);
  });
});

describe("address suggest command", () => {
  it("suggests unused local parts for a domain", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createAddress({ provider_id: provider.id, email: "hello@example.com" });
    createAddress({ provider_id: provider.id, email: "support@example.com" });

    const result = await runAddressCommand(["address", "suggest", "--domain", "Example.com"]);

    expect(result.out).not.toContain("hello@example.com");
    expect(result.out).not.toContain("support@example.com");
    expect(result.out).toContain("hi@example.com");
    expect(result.data).toMatchObject({
      domain: "example.com",
      suggestions: expect.arrayContaining(["hi@example.com"]),
    });
  });
});

describe("address provision command", () => {
  it("supports dry-run without mutating address or provisioning state", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const result = await runAddressCommand(["address", "provision", "dry@example.com", "--provider", provider.id, "--dry-run"]);

    expect(result.data).toMatchObject({
      dry_run: true,
      email: "dry@example.com",
      provider_id: provider.id,
      existing: false,
      would_create_address: true,
      would_update_provisioning: true,
    });
    expect(listAddresses(undefined, getDatabase())).toHaveLength(0);
  });

  it("is idempotent for repeated local address provisioning", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const first = await runAddressCommand(["address", "provision", "ops@example.com", "--provider", provider.id]);
    const second = await runAddressCommand(["address", "provision", "ops@example.com", "--provider", provider.id]);

    expect(first.data).toMatchObject({ email: "ops@example.com", created: true });
    expect(second.data).toMatchObject({ email: "ops@example.com", created: false });
    const addresses = listAddresses(undefined, getDatabase());
    expect(addresses).toHaveLength(1);
    expect(getAddressProvisioning(addresses[0]!.id, getDatabase())).toMatchObject({
      provisioning_status: "requested",
      receive_strategy: "ses-s3",
    });
  });
});
