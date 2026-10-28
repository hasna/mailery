// @hasna/mailery-sdk-internal — zero-dependency TypeScript client for mailery.co
// /api/v1 ("email identity for agents"). The server (this repo's src/server/app.ts) is
// the source of truth; docs/openapi.json freezes the contract via the drift test.

export { MaileryClient } from "./client.js";
export type { FetchLike, MaileryClientOptions } from "./client.js";

export {
  MaileryError,
  MaileryAuthRequiredError,
  MaileryTimeoutError,
  NotYetAvailableError,
} from "./errors.js";
export type { MaileryErrorInit } from "./errors.js";

export { ENDPOINTS, ENDPOINT_LIST } from "./endpoints.js";
export type { EndpointId, EndpointSpec, EndpointState } from "./endpoints.js";

export { MCP_TOOLS, callTool, handleMcpMessage } from "./mcp.js";
export type { JsonRpcRequest, JsonRpcResponse, McpToolDef, ToolResult } from "./mcp.js";

export { verifyWebhookSignature, parseWebhookEvent, WEBHOOK_REPLAY_WINDOW_SECONDS } from "./webhooks.js";
export type { VerifyWebhookSignatureInput, VerifyWebhookSignatureResult } from "./webhooks.js";

export type * from "./types.js";
export type * from "./purchase-withdrawal-types.js";
