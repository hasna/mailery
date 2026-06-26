import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createAddress } from "../../db/addresses.js";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createDomain } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { registerBrowserPlanCommands } from "./browserplan.js";

async function runBrowserPlanCommand(args: string[]) {
  const program = new Command();
  program.exitOverride();
  let data: unknown;
  const out: string[] = [];
  registerBrowserPlanCommands(program, (d, formatted) => {
    data = d;
    out.push(String(formatted ?? ""));
  });
  await program.parseAsync(["node", "mailery", ...args]);
  return { data, out: out.join("\n") };
}

let providerId: string;
let domainId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["OPEN_IDENTITIES_STORE"] = "/tmp/missing-open-identities-store.json";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
  domainId = createDomain(providerId, "example.com").id;
  setDomainProvisioning(domainId, { provisioning_status: "ready", send_provider: "ses" });
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["OPEN_IDENTITIES_STORE"];
});

function ready(email: string): void {
  const address = createAddress({ provider_id: providerId, email }, getDatabase());
  setAddressProvisioning(address.id, { domain_id: domainId, receive_strategy: "ses-s3", provisioning_status: "ready" });
}

describe("browserplan CLI", () => {
  it("reports machine coverage", async () => {
    ready("profile@example.com");

    const result = await runBrowserPlanCommand(["browserplan", "coverage", "--machine", "machine003", "--target", "1"]);

    expect(result.data).toMatchObject({
      machine_id: "machine003",
      target: 1,
      ready_addresses: 1,
      gap_to_target_ready: 0,
    });
    expect(result.out).toContain("machine003");
  });

  it("reserves an address with an identity reference", async () => {
    ready("profile@example.com");

    const result = await runBrowserPlanCommand([
      "browserplan",
      "reserve",
      "profile@example.com",
      "--machine",
      "machine003",
      "--identity-id",
      "oid_profile",
      "--identity-identifier",
      "agent:profile",
      "--identity-name",
      "Profile Agent",
    ]);

    expect(result.data).toMatchObject({
      machine_id: "machine003",
      owner: {
        external_id: "oid_profile",
      },
      existing_reservation: false,
    });
    expect(result.out).toContain("profile@example.com");
  });
});
