import { describe, expect, it } from "bun:test";
import { emailsSelfHostedOpenApi } from "./openapi.js";
import { SELF_HOSTED_RESOURCES } from "./resources.js";

type Operation = {
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name?: string; in?: string; schema?: Record<string, unknown> }>;
  responses?: Record<string, unknown>;
  requestBody?: {
    content?: Record<string, { schema?: { properties?: Record<string, unknown>; required?: string[] } }>;
  };
};

const paths = emailsSelfHostedOpenApi.paths as Record<string, Record<string, Operation>>;

const REQUIRED_IDENTITY_PATHS = [
  "/v1/auth/signup",
  "/v1/auth/login",
  "/v1/auth/verify-email",
  "/v1/auth/verify-email/resend",
  "/v1/auth/password/forgot",
  "/v1/auth/password/reset",
  "/v1/auth/bootstrap-owner",
  "/v1/auth/bootstrap-super-admin",
  "/v1/auth/logout",
  "/v1/auth/logout-all",
  "/v1/auth/switch-tenant",
  "/v1/invites/accept",
  "/v1/me",
  "/v1/me/email-identities",
  "/v1/me/email-identities/{id}",
  "/v1/me/email-identities/{id}/primary",
  "/v1/tenants",
  "/v1/tenants/{id}",
  "/v1/tenants/{id}/members",
  "/v1/tenants/{id}/invites",
  "/v1/memberships/{id}",
  "/v1/keys",
  "/v1/keys/{id}",
] as const;

describe("self-hosted OpenAPI identity and authorization contract", () => {
  it("publishes the runtime global-role vocabulary", () => {
    const userSchema = emailsSelfHostedOpenApi.components?.schemas?.User as
      | { properties?: { global_role?: { enum?: string[] } } }
      | undefined;
    expect(userSchema?.properties?.global_role?.enum).toEqual(["user", "super_admin"]);
  });

  it("publishes every identity, tenancy, membership, invitation, and key route", () => {
    for (const path of REQUIRED_IDENTITY_PATHS) {
      expect(paths[path], path).toBeDefined();
    }
    const operationIds = Object.values(paths)
      .flatMap((path) => Object.values(path))
      .map((operation) => operation.operationId)
      .filter(Boolean);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(paths["/v1/tenants/{id}"]?.put?.operationId).toBe("replaceTenant");
    expect(paths["/v1/memberships/{id}"]?.put?.operationId).toBe("replaceMembership");
  });

  it("declares both accepted credential transports and explicitly marks public routes", () => {
    expect(emailsSelfHostedOpenApi.security).toEqual([{ apiKeyAuth: [] }, { bearerAuth: [] }]);
    expect(emailsSelfHostedOpenApi.components?.securitySchemes).toMatchObject({
      apiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      bearerAuth: { type: "http", scheme: "bearer" },
    });

    for (const [path, method] of [
      ["/health", "get"],
      ["/ready", "get"],
      ["/version", "get"],
      ["/openapi.json", "get"],
      ["/v1/openapi.json", "get"],
      ["/v1/auth/signup", "post"],
      ["/v1/auth/login", "post"],
      ["/v1/auth/verify-email", "get"],
      ["/v1/auth/verify-email", "post"],
      ["/v1/auth/verify-email/resend", "post"],
      ["/v1/auth/password/forgot", "post"],
      ["/v1/auth/password/reset", "post"],
      ["/v1/invites/accept", "post"],
    ] as const) {
      expect(paths[path]?.[method]?.security, `${method.toUpperCase()} ${path}`).toEqual([]);
    }
    expect(paths["/v1/auth/bootstrap-super-admin"]?.post?.security).toBeUndefined();
    expect(paths["/v1/me"]?.get?.security).toBeUndefined();
  });

  it("formalizes scoped sender authorization on the send operation", () => {
    const send = paths["/v1/messages/send"]?.post;
    const schema = send?.requestBody?.content?.["application/json"]?.schema;
    expect(send?.operationId).toBe("sendMessage");
    expect(schema?.properties).toHaveProperty("send_key");
    expect(schema?.required).toEqual(expect.arrayContaining(["from", "to", "subject", "idempotency_key"]));
    expect(send?.description).toContain("Member sessions must supply");
    expect(send?.description).toContain("owner/admin");
  });

  it("publishes a bounded typed attachment-content operation", () => {
    const operation = paths["/v1/messages/{id}/attachments/{index}"]?.get;
    const schema = emailsSelfHostedOpenApi.components?.schemas?.AttachmentContent as
      | { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    const maxBytes = operation?.parameters?.find((item) => item.name === "max_bytes");

    expect(operation?.operationId).toBe("getMessageAttachment");
    expect(maxBytes).toMatchObject({
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 25 * 1024 * 1024 },
    });
    expect(Object.keys(operation?.responses ?? {})).toEqual(["200", "400", "404", "409", "413", "422"]);
    expect(operation?.responses?.["400"]).toMatchObject({
      description: expect.stringContaining("max_bytes"),
    });
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["filename", "content_type", "size", "content_base64"]);
    expect(schema?.properties).toHaveProperty("content_base64");
  });

  it("enumerates every registry-backed resource in the generated contract", () => {
    for (const resource of SELF_HOSTED_RESOURCES) {
      const collection = paths[`/v1/${resource.path}`];
      const item = paths[`/v1/${resource.path}/{id}`];
      expect(collection?.get?.operationId, resource.path).toBeDefined();
      expect(collection?.post?.operationId, resource.path).toBeDefined();
      expect(item?.get?.operationId, resource.path).toBeDefined();
      expect(item?.patch?.operationId, resource.path).toBeDefined();
      expect(item?.delete?.operationId, resource.path).toBeDefined();
    }
  });
});
