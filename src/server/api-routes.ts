/**
 * API request dispatcher for the emails HTTP server.
 * Routes are split into resource-specific modules in routes/.
 *
 * Each handler returns Response | null — null means no match, try next.
 */

import { handle as handleCore } from "./routes/core.js";
import { handle as handleContactsGroups } from "./routes/contacts-groups.js";
import { handle as handleInboundSequences } from "./routes/inbound-sequences.js";
import { handle as handleAgentApi } from "./routes/agent-api.js";

export async function handleApiRequest(
  req: Request,
  url: URL,
  path: string,
  method: string,
): Promise<Response | null> {
  return (
    (await handleAgentApi(req, url, path, method)) ??
    (await handleCore(req, url, path, method)) ??
    (await handleContactsGroups(req, url, path, method)) ??
    (await handleInboundSequences(req, url, path, method)) ??
    null
  );
}
