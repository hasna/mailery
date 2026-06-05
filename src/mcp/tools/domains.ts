// MCP tool module: domains.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createDomain, listDomains, deleteDomain, getDomain, updateDnsStatus } from '../../db/domains.js';
import { createAddress, listAddresses, deleteAddress, getAddress } from '../../db/addresses.js';
import { suspendAddress, activateAddress, setAddressQuota } from '../../db/address-lifecycle.js';
import { createAlias, createCatchAll, removeAlias, getAlias, listAliases, resolveAlias } from '../../db/aliases.js';
import { createSendKey, listSendKeys, revokeSendKey, getSendKey, canOwnerSendFrom } from '../../db/send-keys.js';
import { getProvider } from '../../db/providers.js';
import { getDatabase } from '../../db/database.js';
import { getAdapter } from '../../providers/index.js';
import {
  getAddressOwnershipDetail,
  getAddressOwnershipHistoryByRef,
  listEnrichedAddresses,
  setAddressOwnerByRef,
  suggestAddressLocalParts,
  transferAddressOwnerByRef,
  unassignAddressOwnerByRef,
} from '../../lib/address-ownership.js';
import { getDomainProvisioning, getAddressProvisioning } from '../../db/provisioning.js';
import { assessDomainReadiness } from '../../lib/domain-readiness.js';
import { formatError, resolveId, DomainNotFoundError, AddressNotFoundError, ProviderNotFoundError } from '../helpers.js';

export function registerDomainTools(server: McpServer): void {
  // ─── DOMAINS ──────────────────────────────────────────────────────────────────

  server.tool(
  "list_domains",
  "List domains, optionally filtered by provider",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
  },
  async ({ provider_id }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const domains = listDomains(resolvedId);
      return { content: [{ type: "text", text: JSON.stringify(domains, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_usable_domains",
  "List domains usable for sending and/or receiving.",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    send: z.boolean().optional().describe("Only domains ready to send"),
    receive: z.boolean().optional().describe("Only domains ready to receive"),
  },
  async ({ provider_id, send, receive }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const addresses = listAddresses();
      const domains = listDomains(resolvedId).map((domain) => {
        const ready_addresses = addresses.filter((address) => {
          const provisioning = getAddressProvisioning(address.id);
          return provisioning?.domain_id === domain.id && provisioning.provisioning_status === "ready";
        }).length;
        const readiness = assessDomainReadiness(domain, getDomainProvisioning(domain.id), { ready_addresses });
        return {
          ...domain,
          provider_name: getProvider(domain.provider_id)?.name ?? null,
          readiness,
        };
      }).filter((domain) => {
        if (send && !domain.readiness.send_ready) return false;
        if (receive && !domain.readiness.receive_ready) return false;
        if (!send && !receive) return domain.readiness.send_ready || domain.readiness.receive_ready;
        return true;
      });
      return { content: [{ type: "text", text: JSON.stringify({
        domains,
        cli_equivalent: `emails domain usable${send ? " --send" : ""}${receive ? " --receive" : ""} --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "add_domain",
  "Add a domain to a provider",
  {
    provider_id: z.string().describe("Provider ID"),
    domain: z.string().describe("Domain name (e.g. example.com)"),
  },
  async ({ provider_id, domain }) => {
    try {
      const resolvedId = resolveId("providers", provider_id);
      const provider = getProvider(resolvedId);
      if (!provider) throw new ProviderNotFoundError(resolvedId);

      const adapter = getAdapter(provider);
      await adapter.addDomain(domain);

      const d = createDomain(resolvedId, domain);
      return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "get_dns_records",
  "Get DNS records required for a domain",
  {
    domain: z.string().describe("Domain name"),
    provider_id: z.string().optional().describe("Provider ID (optional)"),
  },
  async ({ domain, provider_id }) => {
    try {
      let provider;
      if (provider_id) {
        const resolvedId = resolveId("providers", provider_id);
        provider = getProvider(resolvedId);
      } else {
        // Find provider for this domain
        const domains = listDomains();
        const found = domains.find((d) => d.domain === domain);
        if (found) provider = getProvider(found.provider_id);
      }

      if (!provider) {
        // Return generic records
        const { generateSpfRecord, generateDmarcRecord, formatDnsTable } = await import("../../lib/dns.js");
        const records = [generateSpfRecord(domain), generateDmarcRecord(domain)];
        return { content: [{ type: "text", text: formatDnsTable(records) }] };
      }

      const adapter = getAdapter(provider);
      const records = await adapter.getDnsRecords(domain);
      const { formatDnsTable } = await import("../../lib/dns.js");
      return { content: [{ type: "text", text: formatDnsTable(records) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "verify_domain",
  "Re-verify a domain's DNS status",
  {
    domain: z.string().describe("Domain name"),
    provider_id: z.string().optional().describe("Provider ID (optional)"),
  },
  async ({ domain, provider_id }) => {
    try {
      const domains = listDomains(provider_id ? resolveId("providers", provider_id) : undefined);
      const found = domains.find((d) => d.domain === domain);
      if (!found) throw new DomainNotFoundError(domain);

      const provider = getProvider(found.provider_id);
      if (!provider) throw new ProviderNotFoundError(found.provider_id);

      const adapter = getAdapter(provider);
      const status = await adapter.verifyDomain(domain);
      const updated = updateDnsStatus(found.id, status.dkim, status.spf, status.dmarc);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "remove_domain",
  "Remove a domain by ID",
  {
    domain_id: z.string().describe("Domain ID (or prefix)"),
  },
  async ({ domain_id }) => {
    try {
      const id = resolveId("domains", domain_id);
      const domain = getDomain(id);
      if (!domain) throw new DomainNotFoundError(id);
      deleteDomain(id);
      return { content: [{ type: "text", text: `Domain removed: ${domain.domain}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  // ─── ADDRESSES ────────────────────────────────────────────────────────────────

  server.tool(
  "list_addresses",
  "List sender email addresses",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
  },
  async ({ provider_id }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const addresses = listEnrichedAddresses(resolvedId);
      return { content: [{ type: "text", text: JSON.stringify({
        addresses,
        cli_equivalent: provider_id ? `emails address list --provider ${provider_id} --json` : "emails address list --json",
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
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
  },
  async ({ provider_id, owner_id, send, receive, include_unverified }) => {
    try {
      const resolvedProviderId = provider_id ? resolveId("providers", provider_id) : undefined;
      const domains = listDomains(resolvedProviderId);
      const addresses = listEnrichedAddresses(resolvedProviderId)
        .filter((address) => !owner_id || address.owner_id === owner_id || address.administrator_id === owner_id)
        .map((address) => {
          const domainName = address.email.split("@")[1]?.toLowerCase() ?? "";
          const domain = domains.find((candidate) => candidate.provider_id === address.provider_id && candidate.domain.toLowerCase() === domainName) ?? null;
          const addressProvisioning = getAddressProvisioning(address.id);
          const readyAddresses = domain
            ? listAddresses(domain.provider_id).filter((candidate) => {
                const provisioning = getAddressProvisioning(candidate.id);
                return provisioning?.domain_id === domain.id && provisioning.provisioning_status === "ready";
              }).length
            : 0;
          const domainReadiness = domain
            ? assessDomainReadiness(domain, getDomainProvisioning(domain.id), { ready_addresses: readyAddresses })
            : null;
          const sendReady = address.status !== "suspended" && (address.verified || domainReadiness?.send_ready === true);
          const receiveReady = addressProvisioning?.provisioning_status === "ready" || domainReadiness?.receive_ready === true;
          const blockers = [
            address.status === "suspended" ? "address suspended" : null,
            !include_unverified && !address.verified && domainReadiness?.send_ready !== true ? "address/domain not send-verified" : null,
            receive && !receiveReady ? "address/domain not receive-ready" : null,
          ].filter(Boolean) as string[];
          return {
            ...address,
            domain,
            provisioning: addressProvisioning,
            readiness: {
              send_ready: sendReady,
              receive_ready: receiveReady,
              domain: domainReadiness,
              blockers,
            },
          };
        })
        .filter((address) => {
          if (!include_unverified && !address.readiness.send_ready) return false;
          if (send && !address.readiness.send_ready) return false;
          if (receive && !address.readiness.receive_ready) return false;
          return true;
        });
      return { content: [{ type: "text", text: JSON.stringify({
        addresses,
        cli_equivalent: provider_id ? `emails address list --provider ${provider_id} --json` : "emails address list --json",
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "get_address_owner",
  "Show owner and administering agent for an address by email or ID.",
  {
    address: z.string().describe("Address email, ID, or ID prefix"),
  },
  async ({ address }) => {
    try {
      const detail = getAddressOwnershipDetail(address);
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `emails address owner ${address} --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "set_address_owner",
  "Assign address ownership. Human owners require an agent administrator.",
  {
    address: z.string().describe("Address email, ID, or ID prefix"),
    owner: z.string().describe("Owner name, ID, or ID prefix"),
    administrator: z.string().optional().describe("Administering agent name, ID, or ID prefix"),
  },
  async ({ address, owner, administrator }) => {
    try {
      const detail = setAddressOwnerByRef(address, owner, administrator);
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `emails address set-owner ${address} --owner ${owner}${administrator ? ` --administrator ${administrator}` : ""} --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
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
  async ({ address, owner, administrator, reason, actor }) => {
    try {
      const detail = transferAddressOwnerByRef(address, owner, administrator, { actor: actor ?? "mcp", reason });
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `emails address transfer-owner ${address} --owner ${owner}${administrator ? ` --administrator ${administrator}` : ""} --reason ${JSON.stringify(reason)} --yes --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "unassign_address_owner",
  "Clear owner/admin assignment for an address. Requires a reason and records audit history.",
  {
    address: z.string().describe("Address email, ID, or ID prefix"),
    reason: z.string().describe("Reason recorded in the ownership audit log"),
    actor: z.string().optional().describe("Actor recorded in the ownership audit log"),
  },
  async ({ address, reason, actor }) => {
    try {
      const detail = unassignAddressOwnerByRef(address, { actor: actor ?? "mcp", reason });
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `emails address unassign-owner ${address} --reason ${JSON.stringify(reason)} --yes --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_address_owner_history",
  "List owner/admin audit history for an address.",
  {
    address: z.string().describe("Address email, ID, or ID prefix"),
    limit: z.number().optional().describe("Maximum events to return"),
  },
  async ({ address, limit }) => {
    try {
      const detail = getAddressOwnershipHistoryByRef(address, limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `emails address owner-history ${address} --limit ${limit ?? 20} --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "suggest_address",
  "Suggest available sender addresses for a domain.",
  {
    domain: z.string().describe("Domain name"),
  },
  async ({ domain }) => {
    try {
      const suggestions = suggestAddressLocalParts(domain, listAddresses().map((address) => address.email));
      return { content: [{ type: "text", text: JSON.stringify({
        domain,
        suggestions,
        cli_equivalent: `emails address suggest --domain ${domain} --json`,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "add_address",
  "Add a sender email address",
  {
    provider_id: z.string().describe("Provider ID"),
    email: z.string().describe("Email address"),
    display_name: z.string().optional().describe("Display name"),
  },
  async ({ provider_id, email, display_name }) => {
    try {
      const resolvedId = resolveId("providers", provider_id);
      const provider = getProvider(resolvedId);
      if (!provider) throw new ProviderNotFoundError(resolvedId);

      const adapter = getAdapter(provider);
      await adapter.addAddress(email);

      const addr = createAddress({ provider_id: resolvedId, email, display_name });
      return { content: [{ type: "text", text: JSON.stringify(addr, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "verify_address",
  "Check verification status of a sender address",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
  },
  async ({ address_id }) => {
    try {
      const id = resolveId("addresses", address_id);
      const addr = getAddress(id);
      if (!addr) throw new AddressNotFoundError(id);

      const provider = getProvider(addr.provider_id);
      if (!provider) throw new ProviderNotFoundError(addr.provider_id);

      const adapter = getAdapter(provider);
      const verified = await adapter.verifyAddress(addr.email);

      if (verified) {
        const db = getDatabase();
        db.run("UPDATE addresses SET verified = 1, updated_at = datetime('now') WHERE id = ?", [id]);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ email: addr.email, verified }, null, 2),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "remove_address",
  "Remove a sender address",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
  },
  async ({ address_id }) => {
    try {
      const id = resolveId("addresses", address_id);
      const addr = getAddress(id);
      if (!addr) throw new AddressNotFoundError(id);
      deleteAddress(id);
      return { content: [{ type: "text", text: `Address removed: ${addr.email}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "suspend_address",
  "Suspend a sender address (blocks sending until reactivated)",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
  },
  async ({ address_id }) => {
    try {
      const id = resolveId("addresses", address_id);
      if (!getAddress(id)) throw new AddressNotFoundError(id);
      const addr = suspendAddress(id);
      return { content: [{ type: "text", text: JSON.stringify(addr, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "activate_address",
  "Reactivate a suspended sender address",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
  },
  async ({ address_id }) => {
    try {
      const id = resolveId("addresses", address_id);
      if (!getAddress(id)) throw new AddressNotFoundError(id);
      const addr = activateAddress(id);
      return { content: [{ type: "text", text: JSON.stringify(addr, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "set_address_quota",
  "Set (or clear) the daily send quota for a sender address",
  {
    address_id: z.string().describe("Address ID (or prefix)"),
    per_day: z.number().int().nonnegative().nullable().describe("Max sends per UTC day, or null to clear"),
  },
  async ({ address_id, per_day }) => {
    try {
      const id = resolveId("addresses", address_id);
      if (!getAddress(id)) throw new AddressNotFoundError(id);
      const addr = setAddressQuota(id, per_day ?? null);
      return { content: [{ type: "text", text: JSON.stringify(addr, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "add_alias",
  "Route an alias address (alias@domain) to a target address",
  {
    alias: z.string().describe("Alias address, e.g. hello@acme.com"),
    target: z.string().describe("Target address mail is delivered to"),
  },
  async ({ alias, target }) => {
    try {
      const a = createAlias(alias, target);
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "add_catch_all",
  "Route every unmatched recipient on a domain to a target address",
  {
    domain: z.string().describe("Domain, e.g. acme.com"),
    target: z.string().describe("Target address"),
  },
  async ({ domain, target }) => {
    try {
      const a = createCatchAll(domain, target);
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_aliases",
  "List aliases and catch-alls (optionally filtered by domain)",
  {
    domain: z.string().optional().describe("Filter by domain"),
  },
  async ({ domain }) => {
    try {
      const aliases = listAliases(domain);
      return { content: [{ type: "text", text: JSON.stringify(aliases, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "remove_alias",
  "Remove an alias or catch-all by ID",
  {
    alias_id: z.string().describe("Alias ID"),
  },
  async ({ alias_id }) => {
    try {
      const a = getAlias(alias_id);
      if (!a) throw new Error(`Alias not found: ${alias_id}`);
      removeAlias(alias_id);
      return { content: [{ type: "text", text: `Alias removed: ${a.local_part}@${a.domain}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "resolve_alias",
  "Resolve where a recipient address would be routed (alias → target, or null)",
  {
    recipient: z.string().describe("Recipient address to resolve"),
  },
  async ({ recipient }) => {
    try {
      const target = resolveAlias(recipient);
      return { content: [{ type: "text", text: JSON.stringify({ recipient, target }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "create_send_key",
  "Issue a scoped send key for an owner. The token is returned ONCE and only its hash is stored.",
  {
    owner_id: z.string().describe("Owner ID the key is bound to"),
    label: z.string().optional().describe("Label to identify the key"),
  },
  async ({ owner_id, label }) => {
    try {
      const { token, key } = createSendKey(owner_id, label);
      return { content: [{ type: "text", text: JSON.stringify({ token, id: key.id, owner_id: key.owner_id, label: key.label, note: "Store the token now — it will not be shown again." }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "list_send_keys",
  "List scoped send keys (hashes only, never tokens)",
  {
    owner_id: z.string().optional().describe("Filter by owner ID"),
  },
  async ({ owner_id }) => {
    try {
      const keys = listSendKeys(owner_id).map(({ key_hash, ...rest }) => rest);
      return { content: [{ type: "text", text: JSON.stringify(keys, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "revoke_send_key",
  "Revoke a scoped send key by ID",
  {
    key_id: z.string().describe("Send key ID"),
  },
  async ({ key_id }) => {
    try {
      if (!getSendKey(key_id)) throw new Error(`Send key not found: ${key_id}`);
      revokeSendKey(key_id);
      return { content: [{ type: "text", text: `Send key revoked: ${key_id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

  server.tool(
  "check_send_authorization",
  "Check whether an owner is authorized to send from an address",
  {
    owner_id: z.string().describe("Owner ID"),
    from: z.string().describe("From address to check"),
  },
  async ({ owner_id, from }) => {
    try {
      const authorized = canOwnerSendFrom(owner_id, from);
      return { content: [{ type: "text", text: JSON.stringify({ owner_id, from, authorized }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${formatError(e)}` }], isError: true };
    }
  },
  );

}
