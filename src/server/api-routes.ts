/**
 * API request dispatcher for the emails HTTP server.
 * Routes are split into resource-specific modules in routes/.
 *
 * Each handler returns Response | null — null means no match, try next.
 */

type RouteKey =
  | "inbound-webhook"
  | "resend-webhook"
  | "agent-api"
  | "core"
  | "contacts-groups"
  | "inbound-sequences";

type ApiRouteHandler = (
  req: Request,
  url: URL,
  path: string,
  method: string,
) => Promise<Response | null>;

const allRouteModules: readonly RouteKey[] = [
  "inbound-webhook",
  "resend-webhook",
  "agent-api",
  "core",
  "contacts-groups",
  "inbound-sequences",
];

function pathStartsWithAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function routeModulesFor(path: string): readonly RouteKey[] {
  if (path === "/webhook/ses-inbound") return ["inbound-webhook"];
  if (path === "/webhook/resend-inbound") return ["resend-webhook"];
  if (path.startsWith("/api/v1/")) return ["agent-api"];
  if (path.startsWith("/track/")) return ["inbound-sequences"];

  if (
    pathStartsWithAny(path, [
      "/api/providers",
      "/api/domains",
      "/api/addresses",
      "/api/emails",
      "/api/events",
      "/api/stats",
      "/api/sandbox",
      "/api/browserplan",
    ])
  ) {
    return ["core"];
  }

  if (
    pathStartsWithAny(path, [
      "/api/contacts",
      "/api/templates",
      "/api/groups",
      "/api/scheduled",
      "/api/analytics",
      "/api/email-content",
      "/api/export",
    ])
  ) {
    return ["contacts-groups"];
  }

  if (
    pathStartsWithAny(path, [
      "/api/inbound",
      "/api/doctor",
      "/api/pull",
      "/api/digest",
      "/api/agents",
      "/api/sequences",
      "/api/warming",
      "/api/triage",
    ])
  ) {
    return ["inbound-sequences"];
  }

  return allRouteModules;
}

async function loadRouteHandler(route: RouteKey): Promise<ApiRouteHandler> {
  switch (route) {
    case "inbound-webhook": {
      const { handleInboundWebhook } = await import("./routes/inbound-webhook.js");
      return (req, _url, path, method) => handleInboundWebhook(req, path, method);
    }
    case "resend-webhook": {
      const { handleResendWebhook } = await import("./routes/resend-webhook.js");
      return (req, _url, path, method) => handleResendWebhook(req, path, method);
    }
    case "agent-api": {
      const { handle } = await import("./routes/agent-api.js");
      return handle;
    }
    case "core": {
      const { handle } = await import("./routes/core.js");
      return handle;
    }
    case "contacts-groups": {
      const { handle } = await import("./routes/contacts-groups.js");
      return handle;
    }
    case "inbound-sequences": {
      const { handle } = await import("./routes/inbound-sequences.js");
      return handle;
    }
  }
}

export async function handleApiRequest(
  req: Request,
  url: URL,
  path: string,
  method: string,
): Promise<Response | null> {
  for (const route of routeModulesFor(path)) {
    const handler = await loadRouteHandler(route);
    const response = await handler(req, url, path, method);
    if (response !== null) return response;
  }

  return null;
}
