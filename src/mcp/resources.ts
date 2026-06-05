import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentContext, getEmailSystemStatus } from "../lib/agent-context.js";
import { listDomains } from "../db/domains.js";
import { getAddressProvisioning, getDomainProvisioning } from "../db/provisioning.js";
import { assessDomainReadiness } from "../lib/domain-readiness.js";
import { listEnrichedAddresses } from "../lib/address-ownership.js";

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

export function registerEmailResources(server: McpServer): void {
  server.registerResource(
    "emails-agent-context",
    "emails://agent/context",
    {
      title: "Emails Agent Context",
      description: "Redacted system snapshot and recommended CLI workflows for coding agents.",
      mimeType: "application/json",
    },
    async () => jsonResource("emails://agent/context", getAgentContext()),
  );

  server.registerResource(
    "emails-status",
    "emails://status",
    {
      title: "Emails Status",
      description: "Redacted email system status, source health, and next actions.",
      mimeType: "application/json",
    },
    async () => jsonResource("emails://status", getEmailSystemStatus()),
  );

  server.registerResource(
    "emails-inbox-sync-status",
    "emails://inbox/sync-status",
    {
      title: "Emails Inbox Sync Status",
      description: "Inbox source status for S3, realtime queue, and Gmail sync.",
      mimeType: "application/json",
    },
    async () => {
      const status = getEmailSystemStatus();
      return jsonResource("emails://inbox/sync-status", {
        inbox: status.inbox,
        gmail: status.providers.gmail,
        cli_equivalents: status.cli_equivalents,
      });
    },
  );

  server.registerResource(
    "emails-domains",
    "emails://domains",
    {
      title: "Emails Domains",
      description: "Configured domains with provisioning and send/receive readiness.",
      mimeType: "application/json",
    },
    async () => {
      const addresses = listEnrichedAddresses();
      const domains = listDomains().map((domain) => {
        const ready_addresses = addresses.filter((address) => {
          const provisioning = getAddressProvisioning(address.id);
          return provisioning?.domain_id === domain.id && provisioning.provisioning_status === "ready";
        }).length;
        return {
          ...domain,
          provisioning: getDomainProvisioning(domain.id),
          readiness: assessDomainReadiness(domain, getDomainProvisioning(domain.id), { ready_addresses }),
        };
      });
      return jsonResource("emails://domains", {
        domains,
        cli_equivalent: "emails domain usable --json",
      });
    },
  );

  server.registerResource(
    "emails-addresses",
    "emails://addresses",
    {
      title: "Emails Addresses",
      description: "Configured addresses with owner/admin/provider/provisioning context.",
      mimeType: "application/json",
    },
    async () => {
      const addresses = listEnrichedAddresses().map((address) => ({
        ...address,
        provisioning: getAddressProvisioning(address.id),
      }));
      return jsonResource("emails://addresses", {
        addresses,
        cli_equivalent: "emails address list --json",
      });
    },
  );

  server.registerResource(
    "emails-recent-errors",
    "emails://recent-errors",
    {
      title: "Emails Recent Errors",
      description: "Recent sync, realtime, provisioning, and readiness errors.",
      mimeType: "application/json",
    },
    async () => {
      const status = getEmailSystemStatus();
      const domainErrors = listDomains()
        .map((domain) => ({ domain, provisioning: getDomainProvisioning(domain.id) }))
        .filter(({ provisioning }) => provisioning?.provisioning_status === "failed")
        .map(({ domain, provisioning }) => ({
          component: "domain-provisioning",
          entity: domain.domain,
          message: provisioning?.last_error ?? "domain provisioning failed",
          fix_command: `emails provision status ${domain.domain}`,
        }));
      const addressErrors = listEnrichedAddresses()
        .map((address) => ({ address, provisioning: getAddressProvisioning(address.id) }))
        .filter(({ provisioning }) => provisioning?.provisioning_status === "failed")
        .map(({ address, provisioning }) => ({
          component: "address-provisioning",
          entity: address.email,
          message: provisioning?.last_error ?? "address provisioning failed",
          fix_command: `emails doctor delivery ${address.email}`,
        }));
      const errors = [
        status.inbox.realtime.last_error ? {
          component: "inbound-realtime",
          message: status.inbox.realtime.last_error,
          fix_command: "emails inbox sync-status",
        } : null,
        ...domainErrors,
        ...addressErrors,
      ].filter(Boolean);
      return jsonResource("emails://recent-errors", {
        errors,
        cli_equivalent: "emails status --json",
      });
    },
  );
}
