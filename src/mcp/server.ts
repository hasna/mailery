import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTriageTools } from "./tools/triage.js";
import { registerWarmingTools } from "./tools/warming.js";
import { registerEmailStorageTools } from "./tools/storage.js";
import { registerProviderTools } from "./tools/providers.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerSequenceTools } from "./tools/sequences.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerEmailOpsTools } from "./tools/email-ops.js";
import { registerMiscOpsTools } from "./tools/misc-ops.js";
import { registerInfrastructureTools } from "./tools/infrastructure.js";
import { registerAgentTools } from "./tools/agent.js";
import { registerEmailResources } from "./resources.js";
import { installMcpToolContracts } from "./contracts.js";
import { DEFAULT_MCP_HTTP_PORT, MCP_NAME } from "./options.js";
import pkg from "../../package.json" with { type: "json" };

export { DEFAULT_MCP_HTTP_PORT, MCP_NAME };

export interface EmailAgent {
  id: string;
  name: string;
  session_id?: string;
  last_seen_at: string;
  project_id?: string;
}

export const emailAgents = new Map<string, EmailAgent>();

export function buildServer(): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: pkg.version,
  });

  registerEmailResources(server);
  registerEmailStorageTools(server);
  installMcpToolContracts(server);
  registerAgentTools(server);
  registerProviderTools(server);
  registerDomainTools(server);
  registerEmailOpsTools(server);
  registerMiscOpsTools(server);
  registerInboxTools(server);
  registerSequenceTools(server);
  registerWarmingTools(server);
  registerTriageTools(server);
  registerInfrastructureTools(server);

  return server;
}
