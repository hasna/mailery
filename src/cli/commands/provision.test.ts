import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { listAddresses } from "../../db/addresses.js";
import { listDomains } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
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
