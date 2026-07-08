// MCP tool module: domains.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { countUsableDomains, createDomain, listDomains, listUsableDomains, listDomainsByProviderAndNames, deleteDomain, findDomainsByName, getDomain, getDomainByName, updateDnsStatus } from '../../db/domains.js';
import { countAddressesForReadiness, createAddress, listAddressEmails, listAddressesForReadiness, deleteAddress, getAddress, getAddressByEmail } from '../../db/addresses.js';
import { isCloudMode } from '../../db/cloud-store.js';
import { suspendAddress, activateAddress, setAddressQuota } from '../../db/address-lifecycle.js';
import { createAlias, createCatchAll, removeAlias, getAlias, listAliases, resolveAlias } from '../../db/aliases.js';
import { createSendKey, listSendKeySummaries, revokeSendKey, getSendKey, canOwnerSendFrom } from '../../db/send-keys.js';
import { getProvider, listProviderNamesByIds } from '../../db/providers.js';
import { getDatabase } from '../../db/database.js';
import { getAdapter } from '../../providers/index.js';
import {
  listAddressProvisioningByIds,
  listDomainProvisioningByIds,
  listReadyAddressCountsByDomains,
} from '../../db/provisioning.js';
import { assessDomainReadiness } from '../../lib/domain-readiness.js';
import { domainInboundReadinessSignals } from '../../lib/domain-inbound-evidence.js';
import { resolveMaileryMode } from '../../lib/mode.js';
import { formatError, resolveId, DomainNotFoundError, AddressNotFoundError, ProviderNotFoundError } from '../helpers.js';

const MAX_MCP_OWNER_HISTORY_LIMIT = 100;

export function registerDomainTools(server: McpServer): void {
  // ─── DOMAINS ──────────────────────────────────────────────────────────────────

  server.tool(
  "list_domains",
  "List domains, optionally filtered by provider",
  {
    provider_id: z.string().optional().describe("Filter by provider ID"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum domains to return"),
    offset: z.number().int().min(0).optional().describe("Number of domains to skip"),
  },
  async ({ provider_id, limit, offset }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const domains = listDomains(resolvedId, undefined, { limit: limit ?? 100, offset: offset ?? 0 });
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
    limit: z.number().int().positive().max(1000).optional().describe("Maximum domains to return after filtering"),
    offset: z.number().int().min(0).optional().describe("Number of filtered domains to skip"),
  },
	  async ({ provider_id, send, receive, limit, offset }) => {
	    try {
	      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
	      const pageLimit = limit ?? 100;
	      const pageOffset = offset ?? 0;
	      const usabilityFilter = { provider_id: resolvedId, send, receive };
	      const baseDomains = listUsableDomains({ ...usabilityFilter, limit: pageLimit, offset: pageOffset });
	      const baseDomainIds = baseDomains.map((domain) => domain.id);
	      const total = countUsableDomains(usabilityFilter);
	      const domainProvisioning = listDomainProvisioningByIds(baseDomainIds);
	      const readyAddressCounts = listReadyAddressCountsByDomains(baseDomainIds);
	      const readyAddressCount = (domainId: string): number =>
	        readyAddressCounts.get(domainId) ?? 0;
	      const domainProvisioningFor = (domainId: string) =>
	        domainProvisioning.get(domainId) ?? null;
      const providerNames = listProviderNamesByIds(baseDomains.map((domain) => domain.provider_id));
      const mode = resolveMaileryMode();
	      const domains = baseDomains.map((domain) => {
	        const ready_addresses = readyAddressCount(domain.id);
	        const provisioning = domainProvisioningFor(domain.id);
        const readiness = assessDomainReadiness(domain, provisioning, {
          ...domainInboundReadinessSignals(domain, mode),
          ready_addresses,
        });
        return {
          ...domain,
          provider_name: providerNames.get(domain.provider_id) ?? null,
          readiness,
        };
      });
      return { content: [{ type: "text", text: JSON.stringify({
        domains,
        total,
        limit: pageLimit,
        offset: pageOffset,
        truncated: pageOffset + pageLimit < total,
        cli_equivalent: `mailery domain usable${provider_id ? ` --provider ${provider_id}` : ""}${send ? " --send" : ""}${receive ? " --receive" : ""}${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
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
      // Cloud (self_hosted) mode: create the domain directly on the cloud HTTP
      // API. Providers are local-only, so `provider_id` is carried through as a
      // label rather than resolved against the local providers table or passed
      // to a provider adapter. Mirrors the CLI `domain add` cloud passthrough.
      if (isCloudMode()) {
        const existing = getDomainByName(provider_id, domain);
        const d = existing ?? createDomain(provider_id, domain);
        return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
      }

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
        const found = findDomainsByName(domain)[0];
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
      const found = provider_id
        ? getDomainByName(resolveId("providers", provider_id), domain)
        : findDomainsByName(domain)[0] ?? null;
      if (!found) throw new DomainNotFoundError(domain);

      const provider = getProvider(found.provider_id);
      if (!provider) throw new ProviderNotFoundError(found.provider_id);

      const adapter = getAdapter(provider);
      let status = await adapter.verifyDomain(domain);
      let reinitiated_records: unknown[] | null = null;
      if (
        provider.type === "ses" &&
        adapter.reinitiateDomainVerification &&
        (status.dkim === "failed" || status.spf === "failed")
      ) {
        reinitiated_records = await adapter.reinitiateDomainVerification(domain);
        const refreshed = await adapter.verifyDomain(domain);
        status = {
          dkim: refreshed.dkim === "failed" ? "pending" : refreshed.dkim,
          spf: refreshed.spf === "failed" ? "pending" : refreshed.spf,
          dmarc: refreshed.dmarc,
        };
      }
      const updated = updateDnsStatus(found.id, status.dkim, status.spf, status.dmarc);
      return { content: [{ type: "text", text: JSON.stringify({ ...updated, reinitiated_records }, null, 2) }] };
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
    limit: z.number().int().positive().max(1000).optional().describe("Maximum addresses to return"),
    offset: z.number().int().min(0).optional().describe("Number of addresses to skip"),
  },
  async ({ provider_id, limit, offset }) => {
    try {
      const resolvedId = provider_id ? resolveId("providers", provider_id) : undefined;
      const { listEnrichedAddresses } = await import('../../lib/address-ownership.js');
      const addresses = listEnrichedAddresses(resolvedId, getDatabase(), { limit: limit ?? 100, offset: offset ?? 0 });
      return { content: [{ type: "text", text: JSON.stringify({
        addresses,
        cli_equivalent: `mailery address list${provider_id ? ` --provider ${provider_id}` : ""}${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
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
    limit: z.number().int().positive().max(1000).optional().describe("Maximum addresses to return after filtering"),
    offset: z.number().int().min(0).optional().describe("Number of filtered addresses to skip"),
  },
	  async ({ provider_id, owner_id, send, receive, include_unverified, limit, offset }) => {
	    try {
	      const db = getDatabase();
	      const resolvedProviderId = provider_id ? resolveId("providers", provider_id) : undefined;
	      const pageLimit = limit ?? 100;
	      const pageOffset = offset ?? 0;
	      const addressFilter = { provider_id: resolvedProviderId, owner_id, send, receive, include_unverified };
	      const baseAddressRows = listAddressesForReadiness({ ...addressFilter, limit: pageLimit, offset: pageOffset }, db);
	      const total = countAddressesForReadiness(addressFilter, db);
	      const { enrichAddresses } = await import('../../lib/address-ownership.js');
	      const baseAddresses = enrichAddresses(baseAddressRows, db);
	      const domains = listDomainsByProviderAndNames(baseAddressRows.map((address) => ({
	        provider_id: address.provider_id,
	        domain: address.email.split("@")[1]?.toLowerCase() ?? "",
	      })), db);
	      const domainIds = domains.map((domain) => domain.id);
	      const domainProvisioning = listDomainProvisioningByIds(domainIds, db);
	      const readyAddressCounts = listReadyAddressCountsByDomains(domainIds, db);
	      const readyAddressCount = (domainId: string): number =>
	        readyAddressCounts.get(domainId) ?? 0;
	      const domainProvisioningFor = (domainId: string) =>
	        domainProvisioning.get(domainId) ?? null;
	      const addressProvisioning = listAddressProvisioningByIds(baseAddresses.map((address) => address.id), db);
	      const addressProvisioningFor = (addressId: string) =>
	        addressProvisioning.get(addressId) ?? null;
	      const domainByProviderAndName = new Map(
	        domains.map((domain) => [`${domain.provider_id}:${domain.domain.toLowerCase()}`, domain]),
	      );
      const mode = resolveMaileryMode();
	      const addresses = baseAddresses.map((address) => {
	          const domainName = address.email.split("@")[1]?.toLowerCase() ?? "";
	          const domain = domainByProviderAndName.get(`${address.provider_id}:${domainName}`) ?? null;
          const provisioning = addressProvisioningFor(address.id);
          const readyAddresses = domain ? readyAddressCount(domain.id) : 0;
          const domainProvisioningRow = domain ? domainProvisioningFor(domain.id) : null;
          const domainReadiness = domain
            ? assessDomainReadiness(domain, domainProvisioningRow, {
              ...domainInboundReadinessSignals(domain, mode),
              ready_addresses: readyAddresses,
            })
            : null;
          const sendReady = address.status !== "suspended" && (address.verified || domainReadiness?.send_ready === true);
          const receiveReady = provisioning?.provisioning_status === "ready" || domainReadiness?.receive_ready === true;
          const blockers = [
            address.status === "suspended" ? "address suspended" : null,
            !include_unverified && !address.verified && domainReadiness?.send_ready !== true ? "address/domain not send-verified" : null,
            receive && !receiveReady ? "address/domain not receive-ready" : null,
          ].filter(Boolean) as string[];
          return {
            ...address,
            domain,
            provisioning,
            readiness: {
              send_ready: sendReady,
              receive_ready: receiveReady,
              domain: domainReadiness,
              blockers,
            },
          };
        });
      return { content: [{ type: "text", text: JSON.stringify({
        addresses,
        total,
        limit: pageLimit,
        offset: pageOffset,
        truncated: pageOffset + pageLimit < total,
        cli_equivalent: `mailery address list${provider_id ? ` --provider ${provider_id}` : ""}${limit !== undefined ? ` --limit ${limit}` : ""}${offset !== undefined ? ` --offset ${offset}` : ""} --json`,
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
      const { getAddressOwnershipDetail } = await import('../../lib/address-ownership.js');
      const detail = getAddressOwnershipDetail(address);
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `mailery address owner ${address} --json`,
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
      const { setAddressOwnerByRef } = await import('../../lib/address-ownership.js');
      const detail = setAddressOwnerByRef(address, owner, administrator);
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `mailery address set-owner ${address} --owner ${owner}${administrator ? ` --administrator ${administrator}` : ""} --json`,
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
      const { transferAddressOwnerByRef } = await import('../../lib/address-ownership.js');
      const detail = transferAddressOwnerByRef(address, owner, administrator, { actor: actor ?? "mcp", reason });
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `mailery address transfer-owner ${address} --owner ${owner}${administrator ? ` --administrator ${administrator}` : ""} --reason ${JSON.stringify(reason)} --yes --json`,
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
      const { unassignAddressOwnerByRef } = await import('../../lib/address-ownership.js');
      const detail = unassignAddressOwnerByRef(address, { actor: actor ?? "mcp", reason });
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `mailery address unassign-owner ${address} --reason ${JSON.stringify(reason)} --yes --json`,
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
    limit: z.number().int().positive().max(MAX_MCP_OWNER_HISTORY_LIMIT).optional().describe("Maximum events to return (default 20, max 100)"),
  },
  async ({ address, limit }) => {
    try {
      const { getAddressOwnershipHistoryByRef } = await import('../../lib/address-ownership.js');
      const detail = getAddressOwnershipHistoryByRef(address, limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify({
        ...detail,
        cli_equivalent: `mailery address owner-history ${address} --limit ${limit ?? 20} --json`,
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
      const { suggestAddressLocalParts } = await import('../../lib/address-ownership.js');
      const suggestions = suggestAddressLocalParts(domain, listAddressEmails());
      return { content: [{ type: "text", text: JSON.stringify({
        domain,
        suggestions,
        cli_equivalent: `mailery address suggest --domain ${domain} --json`,
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
      // Cloud (self_hosted) mode: create the address directly on the cloud HTTP
      // API. Providers are local-only, so `provider_id` is carried through as a
      // label rather than resolved against the local providers table or passed
      // to a provider adapter. Mirrors the CLI `address add` cloud passthrough.
      if (isCloudMode()) {
        const existing = getAddressByEmail(provider_id, email);
        const addr = existing ?? createAddress({ provider_id, email, display_name });
        return { content: [{ type: "text", text: JSON.stringify(addr, null, 2) }] };
      }

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
    limit: z.number().int().positive().max(1000).optional().describe("Maximum aliases to return"),
    offset: z.number().int().min(0).optional().describe("Number of aliases to skip"),
  },
  async ({ domain, limit, offset }) => {
    try {
      const aliases = listAliases(domain, undefined, { limit: limit ?? 100, offset: offset ?? 0 });
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
  "List scoped send keys (tokens and hashes are never returned)",
  {
    owner_id: z.string().optional().describe("Filter by owner ID"),
    limit: z.number().int().positive().max(1000).optional().describe("Maximum send keys to return"),
    offset: z.number().int().min(0).optional().describe("Number of send keys to skip"),
  },
  async ({ owner_id, limit, offset }) => {
    try {
      const keys = listSendKeySummaries(owner_id, undefined, { limit: limit ?? 100, offset: offset ?? 0 });
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

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

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

type ToolHandler = (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

let cachedDomainHandlers: Map<DomainToolName, ToolHandler> | null = null;

function getDomainHandlers(): Map<DomainToolName, ToolHandler> {
  if (cachedDomainHandlers) return cachedDomainHandlers;

  const handlers = new Map<DomainToolName, ToolHandler>();
  const server = {
    tool(toolName: string, _description: string, _schema: unknown, toolHandler: ToolHandler) {
      handlers.set(toolName as DomainToolName, toolHandler);
    },
  } as unknown as McpServer;

  registerDomainTools(server);
  cachedDomainHandlers = handlers;
  return handlers;
}

export async function runDomainTool(name: DomainToolName, input: Record<string, unknown>): Promise<ToolResult> {
  const toolHandler = getDomainHandlers().get(name);

  if (!toolHandler) {
    return { content: [{ type: "text", text: `Error: Unknown domain tool: ${name}` }], isError: true };
  }
  return await toolHandler(input);
}
