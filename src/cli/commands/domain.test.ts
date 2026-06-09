import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createDomain, listDomains, updateDnsStatus } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { setDomainProvisioning } from "../../db/provisioning.js";
import { createWarmingSchedule } from "../../db/warming.js";
import { registerDomainCommands } from "./domain.js";

const mockR53CheckAvailability = mock(async (domain: string) => ({
  domain,
  available: true,
  price: "12",
  currency: "USD",
}));
const mockR53RegisterDomain = mock(async () => ({ operationId: "op-123" }));
const mockR53GetRegistrationStatus = mock(async () => ({ status: "PENDING" }));
const mockR53ListRegisteredDomains = mock(async () => []);
const mockR53CreateHostedZone = mock(async (domain: string) => ({
  id: "zone-123",
  name: domain,
  record_count: 0,
  name_servers: ["ns1.example.net"],
}));
const mockR53FindHostedZoneByDomain = mock(async () => null);
const mockR53UpsertRecords = mock(async () => undefined);

mock.module("@hasna/domains", () => ({
  r53CheckAvailability: mockR53CheckAvailability,
  r53RegisterDomain: mockR53RegisterDomain,
  r53GetRegistrationStatus: mockR53GetRegistrationStatus,
  r53ListRegisteredDomains: mockR53ListRegisteredDomains,
  r53CreateHostedZone: mockR53CreateHostedZone,
  r53FindHostedZoneByDomain: mockR53FindHostedZoneByDomain,
  r53UpsertRecords: mockR53UpsertRecords,
}));

async function runDomainCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerDomainCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  mockR53CheckAvailability.mockReset();
  mockR53CheckAvailability.mockImplementation(async (domain: string) => ({
    domain,
    available: true,
    price: "12",
    currency: "USD",
  }));
  mockR53RegisterDomain.mockReset();
  mockR53RegisterDomain.mockImplementation(async () => ({ operationId: "op-123" }));
  mockR53GetRegistrationStatus.mockReset();
  mockR53GetRegistrationStatus.mockImplementation(async () => ({ status: "PENDING" }));
  mockR53ListRegisteredDomains.mockReset();
  mockR53ListRegisteredDomains.mockImplementation(async () => []);
  mockR53CreateHostedZone.mockReset();
  mockR53CreateHostedZone.mockImplementation(async (domain: string) => ({
    id: "zone-123",
    name: domain,
    record_count: 0,
    name_servers: ["ns1.example.net"],
  }));
  mockR53FindHostedZoneByDomain.mockReset();
  mockR53FindHostedZoneByDomain.mockImplementation(async () => null);
  mockR53UpsertRecords.mockReset();
  mockR53UpsertRecords.mockImplementation(async () => undefined);
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("domain add command", () => {
  it("supports dry-run without mutating domain state", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const result = await runDomainCommand(["domain", "add", "example.com", "--provider", provider.id, "--dry-run"]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider_id: provider.id,
      would_create_domain: true,
      would_call_provider: true,
    });
    expect(listDomains(undefined, getDatabase())).toHaveLength(0);
  });
});

describe("domain buy command", () => {
  it("omits Route53 contact state for Romania even when --state is provided", async () => {
    await runDomainCommand([
      "domain", "buy", "example.ro",
      "--email", "owner@example.com",
      "--first-name", "Mika",
      "--last-name", "Paper",
      "--phone", "+40.123456789",
      "--address", "Main 1",
      "--city", "Bucuresti",
      "--state", "Bucuresti",
      "--country", "RO",
      "--zip", "010101",
    ]);

    const contact = mockR53RegisterDomain.mock.calls[0]?.[1] as { state?: string; country_code?: string };
    expect(contact.country_code).toBe("RO");
    expect("state" in contact).toBe(false);
  });

  it("allows domain purchase without --state and preserves it for countries that accept it", async () => {
    await runDomainCommand([
      "domain", "buy", "example.com",
      "--email", "owner@example.com",
      "--first-name", "Mika",
      "--last-name", "Paper",
      "--phone", "+1.5551234567",
      "--address", "Main 1",
      "--city", "Seattle",
      "--country", "US",
      "--zip", "98101",
    ]);
    expect(mockR53RegisterDomain.mock.calls[0]?.[1]).not.toHaveProperty("state");

    mockR53RegisterDomain.mockClear();
    await runDomainCommand([
      "domain", "buy", "example.net",
      "--email", "owner@example.com",
      "--first-name", "Mika",
      "--last-name", "Paper",
      "--phone", "+1.5551234567",
      "--address", "Main 1",
      "--city", "Seattle",
      "--state", "WA",
      "--country", "US",
      "--zip", "98101",
    ]);
    expect(mockR53RegisterDomain.mock.calls[0]?.[1]).toMatchObject({ state: "WA", country_code: "US" });
  });
});

describe("domain list command", () => {
  it("paginates domain output", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const domain = createDomain(provider.id, `domain-${i}.example.com`);
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, domain.id]);
    }

    const result = await runDomainCommand([
      "domain", "list",
      "--provider", provider.id,
      "--limit", "2",
      "--offset", "1",
    ]);

    expect(result.out).toContain("domain-3.example.com");
    expect(result.out).toContain("domain-2.example.com");
    expect(result.out).not.toContain("domain-4.example.com");
    expect(result.data).toMatchObject([
      { domain: "domain-3.example.com" },
      { domain: "domain-2.example.com" },
    ]);
  });
});

describe("domain status command", () => {
  it("paginates domains before computing readiness", async () => {
    const provider = createProvider({ name: "ses-main", type: "ses", region: "us-east-1" });
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const domain = createDomain(provider.id, `domain-${i}.example.com`);
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, domain.id]);
      updateDnsStatus(domain.id, "verified", "verified", "verified");
      setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });
    }

    const result = await runDomainCommand(["domain", "status", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("domain-3.example");
    expect(result.out).toContain("domain-2.example");
    expect(result.out).not.toContain("domain-4.example");
    expect(result.data).toMatchObject([
      { domain: "domain-3.example.com", readiness: { send_ready: true } },
      { domain: "domain-2.example.com", readiness: { send_ready: true } },
    ]);
  });

  it("shows provider names without changing readiness output", async () => {
    const provider = createProvider({ name: "ses-main", type: "ses", region: "us-east-1" });
    const domain = createDomain(provider.id, "ready.example.com");
    updateDnsStatus(domain.id, "verified", "verified", "verified");
    setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });

    const result = await runDomainCommand(["domain", "status"]);

    expect(result.out).toContain("ses-main");
    expect(result.data).toMatchObject([
      {
        domain: "ready.example.com",
        provider_name: "ses-main",
        readiness: { send_ready: true, receive_ready: true },
      },
    ]);
  });
});

describe("domain usable command", () => {
  it("paginates after readiness filtering", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const domain = createDomain(provider.id, `usable-${i}.example.com`);
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, domain.id]);
      updateDnsStatus(domain.id, "verified", "verified", "verified");
      setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });
    }

    const result = await runDomainCommand(["domain", "usable", "--send", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("usable-3.example.com");
    expect(result.out).toContain("usable-2.example.com");
    expect(result.out).not.toContain("usable-4.example.com");
    expect(result.data).toMatchObject([
      { domain: "usable-3.example.com", readiness: { send_ready: true } },
      { domain: "usable-2.example.com", readiness: { send_ready: true } },
    ]);
  });

  it("filters by provider and includes provider names", async () => {
    const firstProvider = createProvider({ name: "first-ses", type: "ses", region: "us-east-1" });
    const secondProvider = createProvider({ name: "second-ses", type: "ses", region: "us-east-1" });
    const first = createDomain(firstProvider.id, "first.example.com");
    const second = createDomain(secondProvider.id, "second.example.com");
    updateDnsStatus(first.id, "verified", "verified", "verified");
    updateDnsStatus(second.id, "verified", "verified", "verified");
    setDomainProvisioning(first.id, { provisioning_status: "ready", send_provider: "ses" });
    setDomainProvisioning(second.id, { provisioning_status: "ready", send_provider: "ses" });

    const result = await runDomainCommand(["domain", "usable", "--provider", firstProvider.id]);

    expect(result.out).toContain("first-ses");
    expect(result.out).not.toContain("second.example.com");
    expect(result.data).toMatchObject([
      {
        domain: "first.example.com",
        provider_name: "first-ses",
        readiness: { send_ready: true, receive_ready: true },
      },
    ]);
  });
});

describe("domain warm-list command", () => {
  it("paginates warming schedule output", async () => {
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const schedule = createWarmingSchedule({ domain: `warm-${i}.example.com`, target_daily_volume: 100 });
      db.run("UPDATE warming_schedules SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, schedule.id]);
    }

    const result = await runDomainCommand(["domain", "warm-list", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("warm-3.example.com");
    expect(result.out).toContain("warm-2.example.com");
    expect(result.out).not.toContain("warm-4.example.com");
    expect(result.data).toMatchObject([
      { domain: "warm-3.example.com" },
      { domain: "warm-2.example.com" },
    ]);
  });
});
