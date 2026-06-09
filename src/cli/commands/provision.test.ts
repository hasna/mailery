import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createAddress, listAddresses } from "../../db/addresses.js";
import { createDomain, listDomains } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { getDomainProvisioning, setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { registerProvisionCommands } from "./provision.js";

async function runProvisionCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerProvisionCommands(program, (d, formatted) => {
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

describe("provision command dry-runs", () => {
  it("plans address provisioning without writing local state", async () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });

    const result = await runProvisionCommand(["provision", "address", "agent@example.com", "--provider", provider.id, "--dry-run"]);

    expect(result.data).toMatchObject({
      dry_run: true,
      email: "agent@example.com",
      provider_id: provider.id,
      would_create_address: true,
      planned_provisioning: {
        receive_strategy: "ses-s3",
        provisioning_status: "requested",
      },
    });
    expect(listAddresses(undefined, getDatabase())).toHaveLength(0);
  });

  it("plans domain provisioning without writing local state", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });

    const result = await runProvisionCommand(["provision", "domain", "example.com", "--provider", provider.id, "--add-mx", "--dry-run"]);

    expect(result.data).toMatchObject({
      dry_run: true,
      domain: "example.com",
      provider_id: provider.id,
      would_create_domain: true,
      planned_provisioning: {
        provisioning_status: "ses_identity_created",
        send_provider: "ses",
        dns_provider: "cloudflare",
        add_mx: true,
      },
    });
    expect(listDomains(undefined, getDatabase())).toHaveLength(0);
  });
});

describe("provision status", () => {
  it("paginates domain status before loading address provisioning", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });
    const db = getDatabase();
    for (let i = 1; i <= 4; i++) {
      const domain = createDomain(provider.id, `domain-${i}.example.com`);
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-01-0${i} 00:00:00`, domain.id]);
      setDomainProvisioning(domain.id, { provisioning_status: "ready", send_provider: "ses" });
      const address = createAddress({ provider_id: provider.id, email: `ops@domain-${i}.example.com` });
      setAddressProvisioning(address.id, { domain_id: domain.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
    }

    const result = await runProvisionCommand(["provision", "status", "--limit", "2", "--offset", "1"]);

    expect(result.out).toContain("domain-3.example.com");
    expect(result.out).toContain("ops@domain-3.example.com");
    expect(result.out).toContain("domain-2.example.com");
    expect(result.out).not.toContain("domain-4.example.com");
    expect(result.out).not.toContain("ops@domain-4.example.com");
    expect(result.data).toMatchObject({
      domains: [
        { domain: "domain-3.example.com", provisioning: { provisioning_status: "ready" } },
        { domain: "domain-2.example.com", provisioning: { provisioning_status: "ready" } },
      ],
    });
  });

  it("shows addresses for the selected domain without leaking other domain rows", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });
    const first = createDomain(provider.id, "first.example.com");
    const second = createDomain(provider.id, "second.example.com");
    setDomainProvisioning(first.id, { provisioning_status: "ready", send_provider: "ses" });
    setDomainProvisioning(second.id, { provisioning_status: "ready", send_provider: "ses" });
    const firstAddress = createAddress({ provider_id: provider.id, email: "ops@first.example.com" });
    const secondAddress = createAddress({ provider_id: provider.id, email: "ops@second.example.com" });
    setAddressProvisioning(firstAddress.id, { domain_id: first.id, receive_strategy: "ses-s3", provisioning_status: "ready" });
    setAddressProvisioning(secondAddress.id, { domain_id: second.id, receive_strategy: "ses-s3", provisioning_status: "ready" });

    const result = await runProvisionCommand(["provision", "status", "first.example.com"]);

    expect(result.out).toContain("first.example.com");
    expect(result.out).toContain("ops@first.example.com");
    expect(result.out).not.toContain("ops@second.example.com");
    expect(result.data).toMatchObject({
      domains: [{ domain: "first.example.com", provisioning: { provisioning_status: "ready" } }],
    });
  });
});

describe("provision retry", () => {
  it("re-queues a domain by exact case-insensitive lookup when provider is omitted", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });
    const domain = createDomain(provider.id, "first.example.com");
    setDomainProvisioning(domain.id, { provisioning_status: "failed", last_error: "boom", next_check_at: "2999-01-01T00:00:00.000Z" });

    const result = await runProvisionCommand(["provision", "retry", "FIRST.EXAMPLE.COM"]);

    expect(result.data).toMatchObject({ domain: "FIRST.EXAMPLE.COM", requeued: true });
    const provisioning = getDomainProvisioning(domain.id);
    expect(provisioning?.last_error).toBeNull();
    expect(new Date(provisioning?.next_check_at ?? 0).getTime()).toBeLessThan(Date.now() + 5000);
  });
});
