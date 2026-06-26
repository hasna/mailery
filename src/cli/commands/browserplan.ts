import type { Command } from "commander";
import chalk from "../../lib/chalk-lite.js";
import {
  assertBrowserPlanAddressCapacity,
  listBrowserPlanAddresses,
  reserveBrowserPlanAddress,
  validateBrowserPlanAddress,
  type BrowserPlanAddressListResult,
  type BrowserPlanReservationResult,
  type BrowserPlanValidationResult,
} from "../../lib/browserplan.js";
import { handleError, parseCliNonNegativeIntOption, parseCliPositiveIntOption } from "../utils.js";

function formatCoverage(result: BrowserPlanAddressListResult): string {
  return [
    chalk.bold(`BrowserPlan address coverage: ${result.machine_id}`),
    `  target: ${result.target}`,
    `  ready: ${result.ready_addresses}`,
    `  available: ${result.available_ready_addresses}`,
    `  identity-linked ready: ${result.identity_linked_ready_addresses}`,
    `  ready gap: ${result.gap_to_target_ready}`,
    `  identity-linked gap: ${result.gap_to_target_identity_linked_ready}`,
  ].join("\n");
}

function formatAddresses(result: BrowserPlanAddressListResult): string {
  if (result.addresses.length === 0) return `${formatCoverage(result)}\n\nNo BrowserPlan candidate addresses found.`;
  const lines = [formatCoverage(result), "", chalk.bold("Addresses:")];
  for (const address of result.addresses) {
    const ready = address.ready ? chalk.green("ready") : chalk.yellow(address.provisioning_status);
    const reservation = address.reserved ? chalk.dim("reserved") : chalk.cyan("available");
    lines.push(`  ${address.email}  ${ready}  ${reservation}  identity=${address.identity.source}`);
  }
  return lines.join("\n");
}

function formatValidation(result: BrowserPlanValidationResult): string {
  if (!result.found) return chalk.red(`Address not found: ${result.email}`);
  const status = result.valid ? chalk.green("valid") : chalk.red(result.reason ?? "invalid");
  return `${result.email}: ${status}`;
}

function formatReservation(result: BrowserPlanReservationResult): string {
  const existing = result.existing_reservation ? "existing reservation" : result.dry_run ? "planned reservation" : "reserved";
  return chalk.green(`${result.address.email} ${existing} for ${result.owner.name} on ${result.machine_id}`);
}

function targetOption(opts: { target?: string }): number {
  return parseCliPositiveIntOption(opts.target, 8, 1000);
}

export function registerBrowserPlanCommands(program: Command, output: (data: unknown, formatted: string) => void): void {
  const cmd = program
    .command("browserplan")
    .description("Machine-scoped Mailery address contract for BrowserPlan profiles");

  cmd
    .command("coverage")
    .description("Summarize ready address capacity for one machine")
    .option("--machine <id>", "Machine identifier")
    .option("--target <n>", "Required ready identities/profiles", "8")
    .option("--identity-store <path>", "open-identities JSON store path")
    .action((opts: { machine?: string; target?: string; identityStore?: string }) => {
      try {
        const result = listBrowserPlanAddresses({
          machineId: opts.machine,
          target: targetOption(opts),
          identityStorePath: opts.identityStore,
        });
        output(result, formatCoverage(result));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("addresses")
    .description("List BrowserPlan candidate addresses for one machine")
    .option("--machine <id>", "Machine identifier")
    .option("--target <n>", "Required ready identities/profiles", "8")
    .option("--limit <n>", "Maximum addresses to return", "100")
    .option("--offset <n>", "Number of addresses to skip", "0")
    .option("--include-unready", "Include addresses that are not receive-ready")
    .option("--identity-store <path>", "open-identities JSON store path")
    .action((opts: { machine?: string; target?: string; limit?: string; offset?: string; includeUnready?: boolean; identityStore?: string }) => {
      try {
        const result = listBrowserPlanAddresses({
          machineId: opts.machine,
          target: targetOption(opts),
          limit: parseCliPositiveIntOption(opts.limit, 100, 1000),
          offset: parseCliNonNegativeIntOption(opts.offset, 0),
          includeUnready: !!opts.includeUnready,
          identityStorePath: opts.identityStore,
        });
        output(result, formatAddresses(result));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("validate <email>")
    .description("Validate that one address is present and receive-ready")
    .option("--machine <id>", "Machine identifier")
    .option("--identity-store <path>", "open-identities JSON store path")
    .action((email: string, opts: { machine?: string; identityStore?: string }) => {
      try {
        const result = validateBrowserPlanAddress({
          machineId: opts.machine,
          email,
          identityStorePath: opts.identityStore,
        });
        output(result, formatValidation(result));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("reserve [email]")
    .description("Reserve a ready address for an existing BrowserPlan/open-identities identity")
    .option("--machine <id>", "Machine identifier")
    .option("--address-id <id>", "Specific Mailery address ID to reserve when email is ambiguous")
    .option("--identity-id <id>", "Existing open-identities ID")
    .option("--identity-identifier <identifier>", "Existing open-identities identifier, such as agent:name")
    .option("--identity-name <name>", "Identity full name")
    .option("--identity-display-name <name>", "Identity display name")
    .option("--identity-email <email>", "Identity primary/contact email")
    .option("--identity-kind <kind>", "Identity kind: agent or human", "agent")
    .option("--administrator <owner>", "Agent administrator owner ref for human identities")
    .option("--identity-store <path>", "open-identities JSON store path")
    .option("--dry-run", "Plan the reservation without writing ownership state")
    .action((email: string | undefined, opts: {
      machine?: string;
      addressId?: string;
      identityId?: string;
      identityIdentifier?: string;
      identityName?: string;
      identityDisplayName?: string;
      identityEmail?: string;
      identityKind?: string;
      administrator?: string;
      identityStore?: string;
      dryRun?: boolean;
    }) => {
      try {
        if (!opts.identityId && !opts.identityIdentifier) {
          throw new Error("Reserve requires --identity-id or --identity-identifier from open-identities");
        }
        const result = reserveBrowserPlanAddress({
          machineId: opts.machine,
          addressId: opts.addressId,
          email,
          identity: {
            id: opts.identityId,
            identifier: opts.identityIdentifier,
            name: opts.identityName,
            displayName: opts.identityDisplayName,
            email: opts.identityEmail,
            kind: opts.identityKind,
          },
          administratorOwnerRef: opts.administrator,
          identityStorePath: opts.identityStore,
          dryRun: !!opts.dryRun,
        });
        output(result, formatReservation(result));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command("assert-capacity")
    .description("Exit non-zero unless one machine has the target number of receive-ready addresses")
    .option("--machine <id>", "Machine identifier")
    .option("--target <n>", "Required ready identities/profiles", "8")
    .option("--identity-store <path>", "open-identities JSON store path")
    .action((opts: { machine?: string; target?: string; identityStore?: string }) => {
      try {
        const result = listBrowserPlanAddresses({
          machineId: opts.machine,
          target: targetOption(opts),
          identityStorePath: opts.identityStore,
        });
        assertBrowserPlanAddressCapacity(result);
        output(result, formatCoverage(result));
      } catch (e) {
        handleError(e);
      }
    });
}
