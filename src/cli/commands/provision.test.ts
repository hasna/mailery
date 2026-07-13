import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createAddress, listAddresses } from "../../db/addresses.js";
import { createDomain, listDomains } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { getDomainProvisioning, setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { registerProvisionCommands, type ProvisionCommandDeps } from "./provision.js";
import { resetSelfHostedConfigCache } from "../../db/self-hosted-store.js";

async function runProvisionCommand(args: string[], deps?: ProvisionCommandDeps) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerProvisionCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  }, deps);
  await program.parseAsync(["node", "emails", ...args]);
  return { data, out: out.join("\n") };
}

async function runProvisionCommandExpectingExit(args: string[], deps?: ProvisionCommandDeps) {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = ((message?: unknown) => { errors.push(String(message ?? "")); }) as typeof console.error;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runProvisionCommand(args, deps);
    throw new Error("Expected command to exit");
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), stderr: errors.join("\n") };
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

async function withTempHome<T>(prefix: string, fn: (tmpHome: string) => Promise<T>): Promise<T> {
  const originalHome = process.env["HOME"];
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  process.env["HOME"] = tmpHome;
  try {
    return await fn(tmpHome);
  } finally {
    closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function enableSelfHostedMode(): void {
  process.env["EMAILS_MODE"] = "self_hosted";
  process.env["EMAILS_SELF_HOSTED_URL"] = "http://127.0.0.1:9";
  process.env["EMAILS_SELF_HOSTED_API_KEY"] = "test-key";
  resetSelfHostedConfigCache();
}

function clearModeEnv(): void {
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_SELF_HOSTED_URL"];
  delete process.env["EMAILS_SELF_HOSTED_API_KEY"];
  resetSelfHostedConfigCache();
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  delete process.env["HASNA_EMAILS_DB_PATH"];
  clearModeEnv();
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["HASNA_EMAILS_DB_PATH"];
  clearModeEnv();
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
      cli_equivalent: `emails provision address agent@example.com --provider ${provider.id} --dry-run --json`,
    });
    expect(listAddresses(undefined, getDatabase())).toHaveLength(0);
  });

  it("plans domain provisioning without writing local state", async () => {
    const provider = createProvider({ name: "ses", type: "ses", region: "us-east-1" });

    const result = await runProvisionCommand(["provision", "domain", "example.com", "--provider", provider.id, "--add-mx", "--dry-run"], {
      inspectMx: async () => ({
        domain: "example.com",
        owner: "google-workspace",
        records: [
          { exchange: "aspmx.l.google.com", priority: 1, owner: "google-workspace" },
        ],
        summary: "1 root MX record(s), owner: Google Workspace",
        protects_existing_inbound: true,
      }),
    });

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
      mx_assessment: {
        owner: "google-workspace",
      },
      mx_requires_confirmation: true,
      cli_equivalent: `emails provision domain example.com --provider ${provider.id} --add-mx --dry-run --json`,
    });
    expect(result.out).toContain("Refusing to add AWS SES inbound");
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

describe("provision self_hosted local lifecycle guards", () => {
  it("blocks local provisioning commands before creating the default local DB", async () => {
    await withTempHome("emails-provision-self-hosted-", async (tmpHome) => {
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      delete process.env["HASNA_EMAILS_DB_PATH"];
      enableSelfHostedMode();

      for (const args of [
        ["provision", "status"],
        ["provision", "roundtrip", "--domain", "example.com", "--provider", "ses-provider"],
        ["provision", "up", "example.com", "--provider", "ses-provider"],
      ]) {
        const result = await runProvisionCommandExpectingExit(args);
        expect(result.error).toBe("process.exit:1");
        expect(result.stderr).toContain("self_hosted API-only mode");
        expect(result.stderr).toContain("self-hosted server/operator API/workers");
        expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(false);
      }
    });
  });

  it("keeps explicit local mode on the local provisioning store", async () => {
    await withTempHome("emails-provision-local-", async (tmpHome) => {
      closeDatabase();
      resetDatabase();
      delete process.env["EMAILS_DB_PATH"];
      delete process.env["HASNA_EMAILS_DB_PATH"];
      process.env["EMAILS_MODE"] = "local";
      resetSelfHostedConfigCache();

      const result = await runProvisionCommand(["provision", "status"]);

      expect(result.out).toContain("No provisioned domains.");
      expect(existsSync(join(tmpHome, ".hasna", "emails", "emails.db"))).toBe(true);
    });
  });
});
