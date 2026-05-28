import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCloudTools } from "@hasna/cloud";
import { registerTriageTools } from "./tools/triage.js";
import { registerWarmingTools } from "./tools/warming.js";
import { registerProviderTools } from "./tools/providers.js";
import { registerInboxTools } from "./tools/inbox.js";
import { registerSequenceTools } from "./tools/sequences.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerEmailOpsTools } from "./tools/email-ops.js";
import { registerMiscOpsTools } from "./tools/misc-ops.js";
import { registerInfrastructureTools } from "./tools/infrastructure.js";
import pkg from "../../package.json" with { type: "json" };

export const MCP_NAME = "emails";
export const DEFAULT_MCP_HTTP_PORT = 8861;

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

  registerCloudTools(server, MCP_NAME);
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
