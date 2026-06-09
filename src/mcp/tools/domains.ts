// MCP tool module: domains.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_MCP_OWNER_HISTORY_LIMIT = 100;

type DomainToolName =
  | "list_domains"
  | "list_usable_domains"
  | "add_domain"
  | "get_dns_records"
  | "verify_domain"
  | "remove_domain"
  | "list_addresses"
  | "list_usable_from_addresses"
  | "get_address_owner"
  | "set_address_owner"
  | "transfer_address_owner"
  | "unassign_address_owner"
  | "list_address_owner_history"
  | "suggest_address"
  | "add_address"
  | "verify_address"
  | "remove_address"
  | "suspend_address"
  | "activate_address"
  | "set_address_quota"
  | "add_alias"
  | "add_catch_all"
  | "list_aliases"
  | "remove_alias"
  | "resolve_alias"
  | "create_send_key"
  | "list_send_keys"
  | "revoke_send_key"
  | "check_send_authorization";

async function runDomainTool(name: DomainToolName, input: Record<string, unknown>) {
  const { runDomainTool: run } = await import("./domains-impl.js");
  return run(name, input);
}

function handler(name: DomainToolName) {
  return async (input: unknown) => runDomainTool(name, input as Record<string, unknown>);
}

export function registerDomainTools(server: McpServer): void {
  // Domains
  server.tool(
    "list_domains",
    "List domains, optionally filtered by provider",
    {
      provider_id: z.string().optional().describe("Filter by provider ID"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum domains to return"),
      offset: z.number().int().min(0).optional().describe("Number of domains to skip"),
    },
    handler("list_domains"),
  );

  server.tool(
    "list_usable_domains",
    "List domains usable for sending and/or receiving.",
    {
      provider_id: z.string().optional().describe("Filter by provider ID"),
      send: z.boolean().optional().describe("Only domains ready to send"),
      receive: z.boolean().optional().describe("Only domains ready to receive"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum domains to return after filtering"),
      offset: z.number().int().min(0).optional().describe("Number of filtered domains to skip"),
    },
    handler("list_usable_domains"),
  );

  server.tool(
    "add_domain",
    "Add a domain to a provider",
    {
      provider_id: z.string().describe("Provider ID"),
      domain: z.string().describe("Domain name (e.g. example.com)"),
    },
    handler("add_domain"),
  );

  server.tool(
    "get_dns_records",
    "Get DNS records required for a domain",
    {
      domain: z.string().describe("Domain name"),
      provider_id: z.string().optional().describe("Provider ID (optional)"),
    },
    handler("get_dns_records"),
  );

  server.tool(
    "verify_domain",
    "Re-verify a domain's DNS status",
    {
      domain: z.string().describe("Domain name"),
      provider_id: z.string().optional().describe("Provider ID (optional)"),
    },
    handler("verify_domain"),
  );

  server.tool(
    "remove_domain",
    "Remove a domain by ID",
    {
      domain_id: z.string().describe("Domain ID (or prefix)"),
    },
    handler("remove_domain"),
  );

  // Addresses
  server.tool(
    "list_addresses",
    "List sender email addresses",
    {
      provider_id: z.string().optional().describe("Filter by provider ID"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum addresses to return"),
      offset: z.number().int().min(0).optional().describe("Number of addresses to skip"),
    },
    handler("list_addresses"),
  );

  server.tool(
    "list_usable_from_addresses",
    "List configured From addresses with send/receive readiness, owner/admin context, and blockers.",
    {
      provider_id: z.string().optional().describe("Filter by provider ID"),
      owner_id: z.string().optional().describe("Only addresses owned or administered by this owner"),
      send: z.boolean().optional().describe("Only return send-ready addresses"),
      receive: z.boolean().optional().describe("Only return receive-ready addresses"),
      include_unverified: z.boolean().optional().describe("Include addresses that are not verified for sending"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum addresses to return after filtering"),
      offset: z.number().int().min(0).optional().describe("Number of filtered addresses to skip"),
    },
    handler("list_usable_from_addresses"),
  );

  server.tool(
    "get_address_owner",
    "Show owner and administering agent for an address by email or ID.",
    {
      address: z.string().describe("Address email, ID, or ID prefix"),
    },
    handler("get_address_owner"),
  );

  server.tool(
    "set_address_owner",
    "Assign address ownership. Human owners require an agent administrator.",
    {
      address: z.string().describe("Address email, ID, or ID prefix"),
      owner: z.string().describe("Owner name, ID, or ID prefix"),
      administrator: z.string().optional().describe("Administering agent name, ID, or ID prefix"),
    },
    handler("set_address_owner"),
  );

  server.tool(
    "transfer_address_owner",
    "Explicitly transfer address ownership. Requires a reason and preserves set-owner anti-hijack defaults.",
    {
      address: z.string().describe("Address email, ID, or ID prefix"),
      owner: z.string().describe("New owner name, ID, or ID prefix"),
      administrator: z.string().optional().describe("Administering agent name, ID, or ID prefix"),
      reason: z.string().describe("Reason recorded in the ownership audit log"),
      actor: z.string().optional().describe("Actor recorded in the ownership audit log"),
    },
    handler("transfer_address_owner"),
  );

  server.tool(
    "unassign_address_owner",
    "Clear owner/admin assignment for an address. Requires a reason and records audit history.",
    {
      address: z.string().describe("Address email, ID, or ID prefix"),
      reason: z.string().describe("Reason recorded in the ownership audit log"),
      actor: z.string().optional().describe("Actor recorded in the ownership audit log"),
    },
    handler("unassign_address_owner"),
  );

  server.tool(
    "list_address_owner_history",
    "List owner/admin audit history for an address.",
    {
      address: z.string().describe("Address email, ID, or ID prefix"),
      limit: z.number().int().positive().max(MAX_MCP_OWNER_HISTORY_LIMIT).optional().describe("Maximum events to return (default 20, max 100)"),
    },
    handler("list_address_owner_history"),
  );

  server.tool(
    "suggest_address",
    "Suggest available sender addresses for a domain.",
    {
      domain: z.string().describe("Domain name"),
    },
    handler("suggest_address"),
  );

  server.tool(
    "add_address",
    "Add a sender email address",
    {
      provider_id: z.string().describe("Provider ID"),
      email: z.string().describe("Email address"),
      display_name: z.string().optional().describe("Display name"),
    },
    handler("add_address"),
  );

  server.tool(
    "verify_address",
    "Check verification status of a sender address",
    {
      address_id: z.string().describe("Address ID (or prefix)"),
    },
    handler("verify_address"),
  );

  server.tool(
    "remove_address",
    "Remove a sender address",
    {
      address_id: z.string().describe("Address ID (or prefix)"),
    },
    handler("remove_address"),
  );

  server.tool(
    "suspend_address",
    "Suspend a sender address (blocks sending until reactivated)",
    {
      address_id: z.string().describe("Address ID (or prefix)"),
    },
    handler("suspend_address"),
  );

  server.tool(
    "activate_address",
    "Reactivate a suspended sender address",
    {
      address_id: z.string().describe("Address ID (or prefix)"),
    },
    handler("activate_address"),
  );

  server.tool(
    "set_address_quota",
    "Set (or clear) the daily send quota for a sender address",
    {
      address_id: z.string().describe("Address ID (or prefix)"),
      per_day: z.number().int().nonnegative().nullable().describe("Max sends per UTC day, or null to clear"),
    },
    handler("set_address_quota"),
  );

  // Aliases and send keys
  server.tool(
    "add_alias",
    "Route an alias address (alias@domain) to a target address",
    {
      alias: z.string().describe("Alias address, e.g. hello@acme.com"),
      target: z.string().describe("Target address mail is delivered to"),
    },
    handler("add_alias"),
  );

  server.tool(
    "add_catch_all",
    "Route every unmatched recipient on a domain to a target address",
    {
      domain: z.string().describe("Domain, e.g. acme.com"),
      target: z.string().describe("Target address"),
    },
    handler("add_catch_all"),
  );

  server.tool(
    "list_aliases",
    "List aliases and catch-alls (optionally filtered by domain)",
    {
      domain: z.string().optional().describe("Filter by domain"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum aliases to return"),
      offset: z.number().int().min(0).optional().describe("Number of aliases to skip"),
    },
    handler("list_aliases"),
  );

  server.tool(
    "remove_alias",
    "Remove an alias or catch-all by ID",
    {
      alias_id: z.string().describe("Alias ID"),
    },
    handler("remove_alias"),
  );

  server.tool(
    "resolve_alias",
    "Resolve where a recipient address would be routed (alias -> target, or null)",
    {
      recipient: z.string().describe("Recipient address to resolve"),
    },
    handler("resolve_alias"),
  );

  server.tool(
    "create_send_key",
    "Issue a scoped send key for an owner. The token is returned ONCE and only its hash is stored.",
    {
      owner_id: z.string().describe("Owner ID the key is bound to"),
      label: z.string().optional().describe("Label to identify the key"),
    },
    handler("create_send_key"),
  );

  server.tool(
    "list_send_keys",
    "List scoped send keys (tokens and hashes are never returned)",
    {
      owner_id: z.string().optional().describe("Filter by owner ID"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum send keys to return"),
      offset: z.number().int().min(0).optional().describe("Number of send keys to skip"),
    },
    handler("list_send_keys"),
  );

  server.tool(
    "revoke_send_key",
    "Revoke a scoped send key by ID",
    {
      key_id: z.string().describe("Send key ID"),
    },
    handler("revoke_send_key"),
  );

  server.tool(
    "check_send_authorization",
    "Check whether an owner is authorized to send from an address",
    {
      owner_id: z.string().describe("Owner ID"),
      from: z.string().describe("From address to check"),
    },
    handler("check_send_authorization"),
  );
}
