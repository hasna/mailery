import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAddress, findAddressesByEmail, getAddressByEmail } from "../../db/addresses.js";
import { getDomainByName } from "../../db/domains.js";
import { getAddressProvisioning, setAddressProvisioning } from "../../db/provisioning.js";
import { getDatabase } from "../../db/database.js";
import { getProvider } from "../../db/providers.js";
import { formatError, resolveId } from "../helpers.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "prepare_inbox",
    "Prepare or diagnose a local inbox address. Creates local provisioning state only when create_missing=true and provider_id is supplied.",
    {
      email: z.string().describe("Inbox email address to prepare"),
      provider_id: z.string().optional().describe("Provider ID or prefix to use when creating a missing address"),
      receive_strategy: z.enum(["ses-s3", "cf-routing", "resend-webhook"]).optional().describe("Receive strategy for new provisioning state"),
      forward_to: z.string().optional().describe("Forward target for cf-routing"),
      owner: z.string().optional().describe("Owner name, ID, or ID prefix to assign"),
      administrator: z.string().optional().describe("Administering agent name, ID, or ID prefix"),
      create_missing: z.boolean().optional().describe("Create local address/provisioning state when no exact address exists"),
    },
    async ({ email, provider_id, receive_strategy, forward_to, owner, administrator, create_missing }) => {
      try {
        const [
          { diagnoseInboundDelivery },
          { getAddressOwnershipDetail, setAddressOwnerByRef },
        ] = await Promise.all([
          import("../../lib/delivery-doctor.js"),
          import("../../lib/address-ownership.js"),
        ]);
        const db = getDatabase();
        const normalized = email.trim().toLowerCase();
        if (!normalized.includes("@")) throw new Error("Expected a full email address");
        const domainName = normalized.split("@")[1]!;
        let created = false;
        const blockers: string[] = [];
        const next_commands: string[] = [];

        let matches = findAddressesByEmail(normalized, db);
        if (matches.length === 0 && create_missing) {
          if (!provider_id) throw new Error("provider_id is required when create_missing=true");
          const providerId = resolveId("providers", provider_id);
          const provider = getProvider(providerId, db);
          if (!provider) throw new Error(`Provider not found: ${provider_id}`);
          const address = getAddressByEmail(providerId, normalized, db) ?? createAddress({ provider_id: providerId, email: normalized }, db);
          const domainId = getDomainByName(providerId, domainName, db)?.id ?? null;
          setAddressProvisioning(address.id, {
            domain_id: domainId,
            receive_strategy: receive_strategy ?? "ses-s3",
            forward_to: forward_to ?? null,
            provisioning_status: "requested",
            next_check_at: new Date().toISOString(),
          }, db);
          created = true;
          matches = [address];
        }

        if (matches.length === 0) {
          blockers.push("No exact local address exists.");
          next_commands.push(provider_id
            ? `emails address provision ${normalized} --provider ${provider_id} --owner <owner>`
            : `emails address provision ${normalized} --provider <provider> --owner <owner>`);
        }

        if (owner && matches.length === 1) {
          setAddressOwnerByRef(matches[0]!.id, owner, administrator, db);
        } else if (owner && matches.length > 1) {
          blockers.push("Address exists on multiple providers; assign ownership by address ID.");
        } else if (matches.length > 0 && !matches.some((address) => address.owner_id)) {
          next_commands.push(`emails address set-owner ${matches[0]!.id} --owner <owner>`);
        }

        const addresses = matches.map((address) => ({
          ...getAddressOwnershipDetail(address.id, db),
          provisioning: getAddressProvisioning(address.id, db),
        }));
        const diagnosis = diagnoseInboundDelivery(normalized, db);
        return json({
          email: normalized,
          created,
          prepared: addresses.length > 0,
          addresses,
          blockers,
          next_commands,
          diagnosis,
          cli_equivalent: provider_id
            ? `emails address provision ${normalized} --provider ${provider_id}${owner ? ` --owner ${owner}` : ""} --json`
            : `emails doctor delivery ${normalized} --json`,
        });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_email_status",
    "Get redacted email system health, inbox source status, ownership counts, and next actions.",
    {},
    async () => {
      try {
        const { getEmailSystemStatus } = await import("../../lib/agent-context.js");
        return json({ ...getEmailSystemStatus(), cli_equivalent: "emails status --json" });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_agent_context",
    "Get a redacted orientation snapshot and recommended workflows for agents using this emails app.",
    {},
    async () => {
      try {
        const { getAgentContext } = await import("../../lib/agent-context.js");
        return json({ ...getAgentContext(), cli_equivalent: "emails agent context --json" });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "get_next_action",
    "Suggest the next useful email CLI action for a high-level goal.",
    {
      goal: z.string().optional().describe("High-level task, e.g. 'wait for a verification code' or 'diagnose missing inbound mail'"),
    },
    async ({ goal }) => {
      try {
        const { getNextEmailAction } = await import("../../lib/agent-context.js");
        return json({ ...getNextEmailAction(goal), cli_equivalent: "emails status --json" });
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );

  server.tool(
    "diagnose_inbound_delivery",
    "Diagnose why inbound mail may not be reaching a local address.",
    {
      address: z.string().describe("Recipient email address to diagnose"),
    },
    async ({ address }) => {
      try {
        const { diagnoseInboundDelivery } = await import("../../lib/delivery-doctor.js");
        return json(diagnoseInboundDelivery(address));
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${formatError(e)}` }], isError: true };
      }
    },
  );
}
