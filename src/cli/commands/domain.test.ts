import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createAddress, getAddress } from "../../db/addresses.js";
import { createDomain, getDomain, getDomainByName, listDomains, updateDnsStatus, updateDomainReadiness } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { getDomainProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { createWarmingSchedule } from "../../db/warming.js";
import { registerS3Source } from "../../lib/s3-sync.js";
import { registerDomainCommands } from "./domain.js";

const MODE_ENV_KEYS = [
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

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

let savedModeEnv: Partial<Record<(typeof MODE_ENV_KEYS)[number], string | undefined>> = {};

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
  savedModeEnv = {};
  for (const key of MODE_ENV_KEYS) {
    savedModeEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["EMAILS_MODE"] = "local";
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
  for (const key of MODE_ENV_KEYS) {
    const value = savedModeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedModeEnv = {};
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

describe("domains lifecycle commands", () => {
  it("lists domains with stable lifecycle JSON fields", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createDomain(provider.id, "example.com");

    const result = await runDomainCommand(["domains", "list"]);

    expect(result.out).toContain("Source");
    expect(result.data).toMatchObject([
      {
        domain: "example.com",
        mode: "local",
        source_of_truth: "local",
        domain_type: "self_hosted",
        provider: { id: provider.id, name: "sandbox", type: "sandbox" },
        ownership_status: "pending",
        inbound_status: "pending",
        outbound_status: "pending",
        readiness: {
          inbound_ready: false,
          outbound_ready: false,
        },
      },
    ]);
  });

  it("shows a single domain lifecycle status with missing requirements and next actions", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    createDomain(provider.id, "example.com");

    const result = await runDomainCommand(["domains", "status", "example.com"]);

    expect(result.out).toContain("Source of truth");
    expect(result.data).toMatchObject({
      domain: "example.com",
      mode: "local",
      source_of_truth: "local",
      missing_requirements: expect.arrayContaining([
        "domain ownership is not verified",
        "outbound sending is not enabled",
      ]),
      next_actions: expect.arrayContaining([
        "emails domains dns example.com",
        "emails domains verify example.com",
      ]),
    });
  });

  it("supports plural add dry-run without mutating state", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const result = await runDomainCommand([
      "domains", "add", "example.com",
      "--provider", provider.id,
      "--source-of-truth", "postgres",
      "--dry-run",
    ]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider: { id: provider.id, name: "sandbox" },
      source_of_truth: "postgres",
      would_create_domain: true,
      cli_equivalent: `emails domains add example.com --provider ${provider.id}`,
    });
    expect(listDomains(undefined, getDatabase())).toHaveLength(0);
  });

  it("connects an owned domain with DNS tasks and lifecycle readiness", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const dryRun = await runDomainCommand([
      "domains", "connect", "owned.example.com",
      "--provider", provider.id,
      "--source-of-truth", "postgres",
      "--dns-provider", "cloudflare",
      "--dry-run",
    ]);

    expect(dryRun.data).toMatchObject({
      dry_run: true,
      domain: "owned.example.com",
      would_create_domain: true,
      dns_provider: "cloudflare",
      dns_tasks: expect.arrayContaining([
        expect.objectContaining({ purpose: "SPF", check_command: "emails domain check owned.example.com" }),
        expect.objectContaining({ purpose: "DMARC", verify_command: "emails domain verify owned.example.com" }),
      ]),
    });
    expect(listDomains(undefined, getDatabase())).toHaveLength(0);

    const connected = await runDomainCommand([
      "domains", "connect", "owned.example.com",
      "--provider", provider.id,
      "--source-of-truth", "postgres",
      "--dns-provider", "cloudflare",
      "--no-register-provider",
    ]);

    expect(connected.data).toMatchObject({
      domain: "owned.example.com",
      created: true,
      registered_with_provider: false,
      source_of_truth: "postgres",
      domain_type: "self_hosted",
      dns_provider: "cloudflare",
      dns_tasks: expect.arrayContaining([
        expect.objectContaining({ purpose: "SPF", name: "owned.example.com" }),
        expect.objectContaining({ purpose: "DMARC", name: "_dmarc.owned.example.com" }),
      ]),
      lifecycle: {
        domain: "owned.example.com",
        readiness: {
          send_ready: false,
          receive_ready: false,
        },
        next_actions: expect.arrayContaining([
          "emails domains dns owned.example.com",
          "emails domains verify owned.example.com",
        ]),
      },
    });

    const domain = getDomainByName(provider.id, "owned.example.com", getDatabase());
    expect(domain).toMatchObject({
      source_of_truth: "postgres",
      domain_type: "self_hosted",
      dns_records: {
        dns_provider: "cloudflare",
        expected_records: expect.any(Array),
      },
      provider_metadata: {
        dns_setup: {
          dns_provider: "cloudflare",
          register_provider: false,
        },
      },
    });
    expect(getDomainProvisioning(domain!.id, getDatabase())).toMatchObject({
      provisioning_status: "registered",
      dns_provider: "cloudflare",
      send_provider: "sandbox",
    });
  });

  it("enables and disables per-domain inbound/outbound lifecycle states", async () => {
    const provider = createProvider({ name: "ses-main", type: "ses", region: "us-east-1" });
    const domain = createDomain(provider.id, "ready.example.com");
    updateDnsStatus(domain.id, "verified", "verified", "verified");
    setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });

    const inbound = await runDomainCommand(["domains", "enable-inbound", "ready.example.com"]);
    expect(inbound.data).toMatchObject({
      domain: "ready.example.com",
      inbound_status: "ready",
      readiness: { inbound_ready: true },
    });

    const outbound = await runDomainCommand(["domains", "enable-outbound", "ready.example.com"]);
    expect(outbound.data).toMatchObject({
      domain: "ready.example.com",
      outbound_status: "ready",
      monitoring_status: "monitoring",
      readiness: { outbound_ready: true },
    });

    const disabled = await runDomainCommand(["domains", "disable-outbound", "ready.example.com"]);
    expect(disabled.data).toMatchObject({
      domain: "ready.example.com",
      outbound_status: "disabled",
      readiness: { restricted: true },
    });
    expect(getDomain(domain.id, getDatabase())).toMatchObject({
      inbound_status: "ready",
      outbound_status: "disabled",
    });
  });

  it("requires self-hosted domains to have SES/S3 source evidence before receive-ready status", async () => {
    const previousHome = process.env["HOME"];
    const tmpHome = mkdtempSync(join(tmpdir(), "emails-domain-test-"));
    process.env["HOME"] = tmpHome;
    try {
      const provider = createProvider({ name: "ses-main", type: "ses", region: "us-east-1" });
      const domain = createDomain(provider.id, "selfhosted.example.com");
      updateDnsStatus(domain.id, "verified", "verified", "pending");
      updateDomainReadiness(domain.id, {
        source_of_truth: "postgres",
        ownership_status: "verified",
      });
      setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });

      const withoutSource = await runDomainCommand(["domains", "status", "selfhosted.example.com"]);
      expect(withoutSource.data).toMatchObject({
        domain: "selfhosted.example.com",
        readiness: {
          inbound_ready: false,
          receive_ready: false,
          inbound_evidence_ready: false,
        },
      });

      const forcedWithoutSource = await runDomainCommand(["domains", "enable-inbound", "selfhosted.example.com", "--force"]);
      expect(forcedWithoutSource.data).toMatchObject({
        domain: "selfhosted.example.com",
        inbound_status: "ready",
        readiness: {
          inbound_ready: false,
          receive_ready: false,
          inbound_evidence_ready: false,
        },
      });

      registerS3Source({
        bucket: "self-hosted-inbound",
        prefix: "inbound/selfhosted.example.com/",
        region: "us-east-1",
        providerId: provider.id,
        status: "live",
        liveSyncEnabled: true,
      });
      const enabled = await runDomainCommand(["domains", "enable-inbound", "selfhosted.example.com"]);

      expect(enabled.data).toMatchObject({
        domain: "selfhosted.example.com",
        inbound_status: "ready",
        readiness: {
          inbound_ready: true,
          receive_ready: true,
          inbound_evidence_ready: true,
        },
      });
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("domain move-provider command", () => {
  it("moves a domain and matching address rows to another provider", async () => {
    const from = createProvider({ name: "ses-sandbox", type: "ses", region: "us-east-1" });
    const to = createProvider({ name: "ses-production", type: "ses", region: "us-east-1" });
    const domain = createDomain(from.id, "example.com");
    const address = createAddress({ provider_id: from.id, email: "hello@example.com" });
    getDatabase().run("UPDATE addresses SET domain_id = ?, provisioning_status = 'ready' WHERE id = ?", [domain.id, address.id]);

    const result = await runDomainCommand([
      "domain", "move-provider", "example.com",
      "--from-provider", from.id,
      "--to-provider", to.id,
      "--yes",
    ]);

    expect(result.data).toMatchObject({
      domain: { provider_id: to.id, domain: "example.com" },
      moved_addresses: 1,
    });
    expect(listDomains(to.id, getDatabase())).toMatchObject([{ id: domain.id, domain: "example.com" }]);
    expect(getAddress(address.id, getDatabase())).toMatchObject({
      provider_id: to.id,
      domain_id: domain.id,
      email: "hello@example.com",
    });
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
