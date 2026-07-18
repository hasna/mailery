// OpenAPI 3 description of the Emails self-hosted service (/v1).
//
// This is the single source of truth for the service's public HTTP contract:
// it is served at GET /openapi.json AND fed to @hasna/contracts' SDK generator
// to emit the typed client in sdk/. Keep it in lockstep with service.ts.

import type { OpenApiDocument } from "@hasna/contracts/sdk";
import { SELF_HOSTED_RESOURCES, type ResourceColumn } from "./resources.js";

type SecurityRequirement = Record<string, string[]>;
type EmailsOpenApiDocument = OpenApiDocument & {
  security?: SecurityRequirement[];
  components?: NonNullable<OpenApiDocument["components"]> & {
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
};

const publicOperation = { security: [] as SecurityRequirement[] } as const;

const userSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    name: { type: "string", nullable: true },
    status: { type: "string" },
    email_verified: { type: "boolean" },
    global_role: { type: "string", enum: ["user", "super_admin"] },
    is_primary_super_admin: { type: "boolean" },
  },
  required: ["id", "email", "status"],
} as const;

const tenantSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    slug: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "slug", "name", "status"],
} as const;

const emailIdentitySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    is_primary: { type: "boolean" },
    verified: { type: "boolean" },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "is_primary", "verified"],
} as const;

const membershipSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    user_id: { type: "string", format: "uuid" },
    tenant_id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    name: { type: "string", nullable: true },
    role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
    status: { type: "string" },
    created_at: { type: "string", format: "date-time" },
  },
  required: ["id", "role", "status"],
} as const;

const domainSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    domain: { type: "string" },
    status: { type: "string" },
    provider: { type: "string", nullable: true },
    verified: { type: "boolean" },
    notes: { type: "string", nullable: true },
    // Provisioning lifecycle state (mirrors the local domains provisioning columns).
    provisioning_status: { type: "string" },
    purchase_provider: { type: "string", nullable: true },
    dns_provider: { type: "string" },
    send_provider: { type: "string", nullable: true },
    cf_zone_id: { type: "string", nullable: true },
    registrar: { type: "string", nullable: true },
    nameservers_json: { type: "array", items: { type: "string" } },
    mail_from_domain: { type: "string", nullable: true },
    last_error: { type: "string", nullable: true },
    next_check_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "domain", "status", "verified", "created_at", "updated_at"],
} as const;

const addressSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    domain: { type: "string", nullable: true },
    display_name: { type: "string", nullable: true },
    status: { type: "string" },
    verified: { type: "boolean" },
    daily_quota: { type: "integer", nullable: true },
    // Provisioning lifecycle state (mirrors the local addresses provisioning columns).
    domain_id: { type: "string", nullable: true },
    receive_strategy: { type: "string", nullable: true },
    forward_to: { type: "string", nullable: true },
    routing_rule_id: { type: "string", nullable: true },
    provisioning_status: { type: "string" },
    last_validated_at: { type: "string", format: "date-time", nullable: true },
    last_error: { type: "string", nullable: true },
    next_check_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "email", "status", "created_at", "updated_at"],
} as const;

// Provisioning fields accepted on a domain PATCH (all optional; null clears).
const domainProvisioningProps = {
  provisioning_status: { type: "string" },
  purchase_provider: { type: "string", nullable: true },
  dns_provider: { type: "string" },
  send_provider: { type: "string", nullable: true },
  cf_zone_id: { type: "string", nullable: true },
  registrar: { type: "string", nullable: true },
  nameservers_json: { type: "array", items: { type: "string" } },
  mail_from_domain: { type: "string", nullable: true },
  last_error: { type: "string", nullable: true },
  next_check_at: { type: "string", format: "date-time", nullable: true },
} as const;

// Provisioning fields accepted on an address PATCH (all optional; null clears).
const addressProvisioningProps = {
  domain_id: { type: "string", nullable: true },
  receive_strategy: { type: "string", nullable: true },
  forward_to: { type: "string", nullable: true },
  routing_rule_id: { type: "string", nullable: true },
  provisioning_status: { type: "string" },
  last_validated_at: { type: "string", format: "date-time", nullable: true },
  last_error: { type: "string", nullable: true },
  next_check_at: { type: "string", format: "date-time", nullable: true },
} as const;

const threadSchema = {
  type: "object",
  properties: {
    thread_key: { type: "string", description: "Normalized (Re:/Fwd:-stripped) subject key" },
    subject: { type: "string", nullable: true },
    message_count: { type: "integer" },
    unread_count: { type: "integer" },
    last_message_at: { type: "string", format: "date-time", nullable: true },
    first_message_at: { type: "string", format: "date-time", nullable: true },
    participants: { type: "array", items: { type: "string" } },
  },
  required: ["thread_key", "message_count", "unread_count"],
} as const;

const mailboxSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    address: { type: "string" },
    display_name: { type: "string", nullable: true },
    status: { type: "string" },
    total: { type: "integer" },
    unread: { type: "integer" },
  },
  required: ["id", "address", "total", "unread"],
} as const;

const messageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", description: "outbound | inbound" },
    from_addr: { type: "string" },
    to_addrs: { type: "array", items: { type: "string" } },
    cc_addrs: { type: "array", items: { type: "string" } },
    subject: { type: "string", nullable: true },
    body_text: { type: "string", nullable: true },
    body_html: { type: "string", nullable: true },
    status: { type: "string" },
    provider_message_id: { type: "string", nullable: true },
    message_id: { type: "string", nullable: true, description: "RFC 5322 Message-ID" },
    in_reply_to: { type: "string", nullable: true },
    received_at: { type: "string", format: "date-time", nullable: true, description: "Original receipt time (inbound)" },
    is_read: { type: "boolean" },
    is_starred: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    headers: { type: "object", additionalProperties: true },
    attachments: { type: "array", items: { type: "object", additionalProperties: true } },
    source_id: { type: "string", nullable: true, description: "Stable upstream id used for idempotent upsert" },
    send_state: { type: "string", description: "none | pending | sending | sent | uncertain | blocked | cancelled" },
    send_started_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "direction", "from_addr", "to_addrs", "status", "created_at", "updated_at"],
} as const;

const idempotencyKeyRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["idempotency_key"],
} as const;

const sendIntentLookupSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    tombstoned: { type: "boolean" },
    reconciliation_required: { type: "boolean" },
    message: { $ref: "#/components/schemas/SendIntentMessage", nullable: true },
  },
  required: ["found", "tombstoned", "reconciliation_required", "message"],
} as const;

const sendIntentCancellationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["tombstoned", "cancelled", "reconciliation_required"] },
    tombstoned: { type: "boolean", enum: [true] },
    reconciliation_required: { type: "boolean" },
    message: { $ref: "#/components/schemas/SendIntentMessage", nullable: true },
  },
  required: ["outcome", "tombstoned", "reconciliation_required", "message"],
} as const;

const sendMessageErrorSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    error: { type: "string" },
    retry_safe: { type: "boolean" },
    tombstoned: { type: "boolean" },
    message: {
      oneOf: [
        { $ref: "#/components/schemas/Message" },
        { $ref: "#/components/schemas/SendIntentMessage" },
      ],
      nullable: true,
    },
  },
  required: ["error", "retry_safe"],
} as const;

const sendMessageResponseSchema = {
  type: "object",
  properties: {
    message: { $ref: "#/components/schemas/Message" },
    provider: { type: "string" },
    idempotent_replay: { type: "boolean", enum: [true] },
    in_progress: { type: "boolean", enum: [true] },
  },
  required: ["message", "provider"],
} as const;

const messageListItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", description: "outbound | inbound" },
    from_addr: { type: "string" },
    to_addrs: { type: "array", items: { type: "string" } },
    cc_addrs: { type: "array", items: { type: "string" } },
    subject: { type: "string", nullable: true },
    snippet: { type: "string", nullable: true, description: "Short text preview; full bodies are available only from GET /v1/messages/{id}." },
    status: { type: "string" },
    provider_message_id: { type: "string", nullable: true },
    message_id: { type: "string", nullable: true, description: "RFC 5322 Message-ID" },
    in_reply_to: { type: "string", nullable: true },
    received_at: { type: "string", format: "date-time", nullable: true, description: "Original receipt time (inbound)" },
    is_read: { type: "boolean" },
    is_starred: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    headers: { type: "object", additionalProperties: true },
    attachments: { type: "array", items: { type: "object", additionalProperties: true } },
    source_id: { type: "string", nullable: true, description: "Stable upstream id used for idempotent upsert" },
    send_state: { type: "string", description: "none | pending | sending | sent | uncertain | blocked | cancelled" },
    send_started_at: { type: "string", format: "date-time", nullable: true },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
  required: ["id", "direction", "from_addr", "to_addrs", "status", "created_at", "updated_at"],
} as const;

const attachmentContentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filename: { type: "string" },
    content_type: { type: "string", description: "Validated MIME type" },
    size: { type: "integer", minimum: 0, maximum: 26214400 },
    content_base64: { type: "string", description: "Canonical base64; authenticated response only" },
  },
  required: ["filename", "content_type", "size", "content_base64"],
} as const;

const attachmentContentResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: { attachment: { $ref: "#/components/schemas/AttachmentContent" } },
  required: ["attachment"],
} as const;

const listParams = [
  { name: "limit", in: "query", required: false, schema: { type: "integer" } },
  { name: "offset", in: "query", required: false, schema: { type: "integer" } },
] as const;

const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }] as const;

function resourceColumnSchema(column: ResourceColumn): Record<string, unknown> {
  if (column.bool) return { type: "boolean" };
  if (column.int) return { type: "integer" };
  if (column.num) return { type: "number" };
  if (column.json) return {};
  return { type: "string", nullable: true };
}

function resourceOperationName(path: string): string {
  return path
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

const genericResourcePaths: Record<string, Record<string, unknown>> = {};

for (const resource of SELF_HOSTED_RESOURCES) {
  const name = resourceOperationName(resource.path);
  const itemSchema = {
    type: "object",
    description: `Tenant-scoped ${resource.path} row.`,
    properties: Object.fromEntries([
      [resource.idColumn ?? "id", { type: "string" }],
      ...resource.columns.map((column) => [column.name, resourceColumnSchema(column)]),
      ["created_at", { type: "string", format: "date-time" }],
      ["updated_at", { type: "string", format: "date-time" }],
    ]),
    additionalProperties: true,
  };
  const bodySchema = {
    type: "object",
    properties: Object.fromEntries(resource.columns.map((column) => [column.name, resourceColumnSchema(column)])),
    additionalProperties: false,
  };
  const queryParameters = [
    ...listParams,
    ...(resource.filters ?? []).map((filter) => ({
      name: filter,
      in: "query",
      required: false,
      schema: resourceColumnSchema(resource.columns.find((column) => column.name === filter) ?? { name: filter }),
    })),
  ];

  genericResourcePaths[`/v1/${resource.path}`] = {
    get: {
      operationId: `listResource${name}`,
      summary: `List tenant-scoped ${resource.path}`,
      parameters: queryParameters,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { items: { type: "array", items: itemSchema } },
                required: ["items"],
              },
            },
          },
        },
      },
    },
    post: {
      operationId: `createResource${name}`,
      summary: `Create a tenant-scoped ${resource.path} row`,
      requestBody: { required: true, content: { "application/json": { schema: bodySchema } } },
      responses: { "201": { content: { "application/json": { schema: itemSchema } } } },
    },
  };
  genericResourcePaths[`/v1/${resource.path}/{id}`] = {
    get: {
      operationId: `getResource${name}`,
      summary: `Get a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      responses: { "200": { content: { "application/json": { schema: itemSchema } } } },
    },
    patch: {
      operationId: `updateResource${name}`,
      summary: `Update a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      requestBody: { required: true, content: { "application/json": { schema: bodySchema } } },
      responses: { "200": { content: { "application/json": { schema: itemSchema } } } },
    },
    delete: {
      operationId: `deleteResource${name}`,
      summary: `Delete a tenant-scoped ${resource.path} row`,
      parameters: idParam,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { deleted: { type: "boolean" }, id: { type: "string" } },
                required: ["deleted", "id"],
              },
            },
          },
        },
      },
    },
  };
}

export const emailsSelfHostedOpenApi: EmailsOpenApiDocument = {
  openapi: "3.0.3",
  info: { title: "Emails Self-Hosted API", version: "1.0.0" },
  security: [{ apiKeyAuth: [] }, { bearerAuth: [] }],
  paths: {
    ...genericResourcePaths,
    "/health": {
      get: {
        ...publicOperation,
        operationId: "getHealth",
        summary: "Liveness probe with database reachability",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/ready": {
      get: {
        ...publicOperation,
        operationId: "getReady",
        summary: "Readiness probe (reachable and fully migrated)",
        responses: {
          "200": { content: { "application/json": { schema: { type: "object" } } } },
          "503": { content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
    "/version": {
      get: {
        ...publicOperation,
        operationId: "getVersion",
        summary: "Service version and mode",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/openapi.json": {
      get: {
        ...publicOperation,
        operationId: "getOpenApiDocument",
        summary: "Return this OpenAPI document",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/openapi.json": {
      get: {
        ...publicOperation,
        operationId: "getVersionedOpenApiDocument",
        summary: "Return this OpenAPI document from the versioned API prefix",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/signup": {
      post: {
        ...publicOperation,
        operationId: "signUp",
        summary: "Create an unverified user and owner membership, then send email verification",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                  name: { type: "string", nullable: true },
                  tenant_name: { type: "string" },
                  tenant_slug: { type: "string", nullable: true },
                },
                required: ["email", "password", "tenant_name"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/login": {
      post: {
        ...publicOperation,
        operationId: "logIn",
        summary: "Authenticate a verified user and create a tenant-bound session",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                  tenant_slug: { type: "string", nullable: true },
                },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/verify-email": {
      get: {
        ...publicOperation,
        operationId: "verifyEmailLink",
        summary: "Verify a user email from a query-string token",
        parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      post: {
        ...publicOperation,
        operationId: "verifyEmailToken",
        summary: "Verify a user email from a JSON token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } } },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/verify-email/resend": {
      post: {
        ...publicOperation,
        operationId: "resendEmailVerification",
        summary: "Request another verification message without revealing account existence",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } } },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/password/forgot": {
      post: {
        ...publicOperation,
        operationId: "requestPasswordReset",
        summary: "Request a password reset without revealing account existence",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } } },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/password/reset": {
      post: {
        ...publicOperation,
        operationId: "resetPassword",
        summary: "Consume a password-reset token and revoke existing sessions",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { token: { type: "string" }, new_password: { type: "string", format: "password" } },
                required: ["token", "new_password"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/invites/accept": {
      post: {
        ...publicOperation,
        operationId: "acceptInvite",
        summary: "Accept an invitation and create a tenant-bound session",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  password: { type: "string", format: "password", nullable: true },
                  name: { type: "string", nullable: true },
                },
                required: ["token"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/bootstrap-owner": {
      post: {
        operationId: "bootstrapOwner",
        summary: "Create the first tenant owner using a tenant-bound operator API key",
        description: "Migration bridge. User sessions are rejected and the tenant may not already have an owner.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                  name: { type: "string", nullable: true },
                },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/bootstrap-super-admin": {
      post: {
        operationId: "bootstrapPrimarySuperAdmin",
        summary: "Idempotently register the configured primary platform super-admin",
        description: "Requires the exact operator API-key KID configured by EMAILS_PRIMARY_SUPER_ADMIN_BOOTSTRAP_KID. The email is pinned by EMAILS_PRIMARY_SUPER_ADMIN_EMAIL and is not itself an authorization mechanism.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email", nullable: true },
                  password: { type: "string", format: "password" },
                  name: { type: "string", nullable: true },
                },
                required: ["password"],
              },
            },
          },
        },
        responses: {
          "200": { content: { "application/json": { schema: { type: "object" } } } },
          "201": { content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
    "/v1/auth/logout": {
      post: {
        operationId: "logOut",
        summary: "Revoke the current user session",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/logout-all": {
      post: {
        operationId: "logOutAll",
        summary: "Revoke every session for the current user",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/auth/switch-tenant": {
      post: {
        operationId: "switchTenant",
        summary: "Rotate the current user session into another tenant membership",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { tenant_slug: { type: "string" } }, required: ["tenant_slug"] } } },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/me": {
      get: {
        operationId: "getCurrentPrincipal",
        summary: "Return the authenticated user or API-key principal and active tenant",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/me/email-identities": {
      get: {
        operationId: "listEmailIdentities",
        summary: "List all login email identities for the current user",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { email_identities: { type: "array", items: { $ref: "#/components/schemas/EmailIdentity" } } } },
              },
            },
          },
        },
      },
      post: {
        operationId: "addEmailIdentity",
        summary: "Add an email identity and send verification",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] } } },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/me/email-identities/{id}": {
      delete: {
        operationId: "removeEmailIdentity",
        summary: "Remove a non-primary email identity",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/me/email-identities/{id}/primary": {
      post: {
        operationId: "makePrimaryEmailIdentity",
        summary: "Make a verified email identity primary",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/tenants": {
      get: {
        operationId: "listTenants",
        summary: "List the current user's active tenant memberships",
        responses: {
          "200": { content: { "application/json": { schema: { type: "object", properties: { tenants: { type: "array", items: { $ref: "#/components/schemas/Tenant" } } } } } } },
        },
      },
      post: {
        operationId: "createTenant",
        summary: "Create a tenant owned by the current user",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, slug: { type: "string", nullable: true } },
                required: ["name"],
              },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/tenants/{id}": {
      get: {
        operationId: "getTenant",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { tenant: { $ref: "#/components/schemas/Tenant" } } } } } } },
      },
      patch: {
        operationId: "updateTenant",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, status: { type: "string" } } },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      put: {
        operationId: "replaceTenant",
        summary: "Compatibility alias for tenant update",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, status: { type: "string" } } },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      delete: {
        operationId: "suspendTenant",
        summary: "Suspend a tenant; owner role required",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/tenants/{id}/members": {
      get: {
        operationId: "listTenantMembers",
        summary: "List tenant memberships; owner or admin role required",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { members: { type: "array", items: { $ref: "#/components/schemas/Membership" } } } },
              },
            },
          },
        },
      },
    },
    "/v1/tenants/{id}/invites": {
      get: {
        operationId: "listTenantInvites",
        summary: "List outstanding tenant invitations; owner or admin role required",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      post: {
        operationId: "createTenantInvite",
        summary: "Invite a user; only an owner may grant the owner role",
        parameters: [...idParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  role: { type: "string", enum: ["owner", "admin", "member"] },
                },
                required: ["email"],
              },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/memberships/{id}": {
      patch: {
        operationId: "updateMembership",
        summary: "Change a membership role under owner/admin role gates",
        parameters: [...idParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } },
                required: ["role"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      put: {
        operationId: "replaceMembership",
        summary: "Compatibility alias for membership role update",
        parameters: [...idParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } },
                required: ["role"],
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      delete: {
        operationId: "removeMembership",
        summary: "Remove a tenant membership under owner/admin role gates",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/keys": {
      get: {
        operationId: "listTenantKeys",
        summary: "List tenant API-key metadata; owner or admin user session required",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
      post: {
        operationId: "createTenantKey",
        summary: "Mint a tenant API key; plaintext token is returned once",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scopes: { type: "array", items: { type: "string" } },
                  ttl_days: { type: "number", nullable: true },
                },
              },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/keys/{id}": {
      delete: {
        operationId: "revokeTenantKey",
        summary: "Revoke a tenant API key; owner or admin user session required",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/domains": {
      get: {
        operationId: "listDomains",
        summary: "List sending domains",
        parameters: [...listParams],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { domains: { type: "array", items: { $ref: "#/components/schemas/Domain" } } } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createDomain",
        summary: "Register a sending domain (scope emails:write)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  domain: { type: "string" },
                  status: { type: "string" },
                  provider: { type: "string", nullable: true },
                  verified: { type: "boolean" },
                  notes: { type: "string", nullable: true },
                },
                required: ["domain"],
              },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { domain: { $ref: "#/components/schemas/Domain" } } } } } } },
      },
    },
    "/v1/domains/{id}": {
      get: {
        operationId: "getDomain",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { domain: { $ref: "#/components/schemas/Domain" } } } } } } },
      },
      patch: {
        operationId: "updateDomain",
        parameters: [...idParam],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, provider: { type: "string", nullable: true }, verified: { type: "boolean" }, notes: { type: "string", nullable: true }, ...domainProvisioningProps },
              },
            },
          },
        },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { domain: { $ref: "#/components/schemas/Domain" } } } } } } },
      },
      delete: {
        operationId: "deleteDomain",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/addresses": {
      get: {
        operationId: "listAddresses",
        parameters: [...listParams],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { addresses: { type: "array", items: { $ref: "#/components/schemas/Address" } } } } } } } },
      },
      post: {
        operationId: "createAddress",
        summary: "Register an email address (scope emails:write)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { email: { type: "string" }, display_name: { type: "string", nullable: true }, status: { type: "string" } }, required: ["email"] },
            },
          },
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object", properties: { address: { $ref: "#/components/schemas/Address" } } } } } } },
      },
    },
    "/v1/addresses/{id}": {
      get: {
        operationId: "getAddress",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { address: { $ref: "#/components/schemas/Address" } } } } } } },
      },
      patch: {
        operationId: "updateAddress",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { display_name: { type: "string", nullable: true }, status: { type: "string" }, verified: { type: "boolean" }, daily_quota: { type: "integer", nullable: true }, ...addressProvisioningProps } } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { address: { $ref: "#/components/schemas/Address" } } } } } } },
      },
      delete: {
        operationId: "deleteAddress",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/messages": {
      get: {
        operationId: "listMessages",
        parameters: [
          ...listParams,
          { name: "direction", in: "query", required: false, schema: { type: "string", enum: ["inbound", "outbound"] } },
          { name: "to", in: "query", required: false, schema: { type: "string" } },
          { name: "from", in: "query", required: false, schema: { type: "string" } },
          { name: "subject", in: "query", required: false, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" } },
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/MessageListItem" } } } } } } } },
      },
      post: {
        operationId: "createMessage",
        summary:
          "Import an inbound message. Supplying source_id makes the write idempotent. Scope emails:write.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "array", items: { type: "string" } },
                  cc: { type: "array", items: { type: "string" } },
                  subject: { type: "string", nullable: true },
                  text: { type: "string", nullable: true },
                  html: { type: "string", nullable: true },
                  status: { type: "string" },
                  direction: { type: "string", enum: ["inbound"] },
                  received_at: { type: "string", format: "date-time", nullable: true },
                  message_id: { type: "string", nullable: true },
                  in_reply_to: { type: "string", nullable: true },
                  is_read: { type: "boolean" },
                  is_starred: { type: "boolean" },
                  labels: { type: "array", items: { type: "string" } },
                  headers: { type: "object", additionalProperties: true },
                  attachments: { type: "array", items: { type: "object", additionalProperties: true } },
                  provider_message_id: { type: "string", nullable: true },
                  source_id: { type: "string", description: "Stable upstream id; enables idempotent upsert" },
                },
                required: ["from", "to", "direction"],
              },
            },
          },
        },
        responses: {
          "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } },
          "201": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } },
        },
      },
    },
    "/v1/messages/counts": {
      get: {
        operationId: "getMessageCounts",
        summary: "Return server-side mailbox counts",
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/v1/messages/threads": {
      get: {
        operationId: "listThreads",
        summary: "Mail-view: subject-rolled-up conversation list (newest activity first)",
        parameters: [...listParams],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { threads: { type: "array", items: { $ref: "#/components/schemas/Thread" } } } } } } } },
      },
    },
    "/v1/messages/send": {
      post: {
        operationId: "sendMessage",
        summary: "Send through the configured SES or Resend provider and persist the resulting ledger row",
        description: "Tenant API keys and owner/admin user sessions have tenant-wide send authority. Member sessions must supply a sender-scoped send_key authorized for the registered From address. Viewer sessions cannot send.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  to: { type: "array", items: { type: "string" } },
                  cc: { type: "array", items: { type: "string" } },
                  bcc: { type: "array", items: { type: "string" } },
                  reply_to: { type: "string" },
                  subject: { type: "string" },
                  text: { type: "string" },
                  html: { type: "string" },
                  attachments: {
                    type: "array",
                    maxItems: 5,
                    items: {
                      type: "object",
                      properties: {
                        filename: { type: "string" },
                        content: { type: "string", description: "Base64-encoded attachment content" },
                        content_type: { type: "string" },
                      },
                      required: ["filename", "content", "content_type"],
                    },
                  },
                  send_key: {
                    type: "string",
                    description: "Sender-scoped key required for member sessions; optional for tenant API keys and owner/admin sessions.",
                  },
                  idempotency_key: { type: "string", maxLength: 200 },
                },
                required: ["from", "to", "subject", "idempotency_key"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Completed idempotent replay of an existing sent intent",
            content: {
              "application/json": {
                schema: sendMessageResponseSchema,
              },
            },
          },
          "202": {
            description: "Newly accepted send or an existing send still in progress",
            content: { "application/json": { schema: sendMessageResponseSchema } },
          },
          "400": { description: "Invalid send request" },
          "401": { description: "Authentication required" },
          "403": { description: "Sender or tenant scope is not authorized" },
          "409": { content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } } },
          "429": { description: "Tenant or sender quota exceeded" },
          "413": { description: "Request body exceeds the service limit" },
          "502": { content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } } },
        },
      },
    },
    "/v1/messages/send-intents/lookup": {
      post: {
        operationId: "lookupSendIntent",
        summary: "Look up a tenant-scoped send intent without sending",
        requestBody: {
          required: true,
          content: { "application/json": { schema: idempotencyKeyRequestSchema } },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { send_intent: { $ref: "#/components/schemas/SendIntentLookup" } },
                  required: ["send_intent"],
                },
              },
            },
          },
          "400": { description: "Invalid idempotency key" },
          "401": { description: "Authentication required" },
          "403": { description: "Tenant read scope is not authorized" },
          "413": { description: "Request body exceeds the service limit" },
        },
      },
    },
    "/v1/messages/send-intents/cancel": {
      post: {
        operationId: "cancelSendIntent",
        summary: "Tombstone a tenant-scoped send intent before provider delivery",
        requestBody: {
          required: true,
          content: { "application/json": { schema: idempotencyKeyRequestSchema } },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { cancellation: { $ref: "#/components/schemas/SendIntentCancellation" } },
                  required: ["cancellation"],
                },
              },
            },
          },
          "400": { description: "Invalid idempotency key" },
          "401": { description: "Authentication required" },
          "403": { description: "Tenant write scope is not authorized" },
          "413": { description: "Request body exceeds the service limit" },
        },
      },
    },
    "/v1/messages/{id}": {
      get: {
        operationId: "getMessage",
        parameters: [...idParam],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } } },
      },
      patch: {
        operationId: "updateMessage",
        parameters: [...idParam],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, provider_message_id: { type: "string", nullable: true }, is_read: { type: "boolean" }, is_starred: { type: "boolean" }, archived: { type: "boolean" }, add_label: { type: "string" }, remove_label: { type: "string" } } } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { message: { $ref: "#/components/schemas/Message" } } } } } } },
      },
      delete: {
        operationId: "deleteMessage",
        parameters: [...idParam],
        responses: {
          "200": { content: { "application/json": { schema: { type: "object" } } } },
          "401": { description: "Authentication required" },
          "403": { description: "Tenant write scope is not authorized" },
          "404": { description: "Message not found" },
          "409": {
            description: "Durable send-intent ledger rows cannot be deleted",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageError" } } },
          },
        },
      },
    },
    "/v1/messages/{id}/attachments/{index}": {
      get: {
        operationId: "getMessageAttachment",
        parameters: [
          { name: "id", in: "path", required: true, description: "Exact full message ID; prefixes are rejected for attachment content", schema: { type: "string" } },
          { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 0 } },
          { name: "max_bytes", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 26214400 } },
        ],
        responses: {
          "200": { content: { "application/json": { schema: attachmentContentResponseSchema } } },
          "400": { description: "Invalid max_bytes attachment byte limit" },
          "404": { description: "Message or attachment index not found" },
          "409": { description: "Attachment metadata exists but its content is not stored" },
          "413": { description: "Attachment exceeds the requested or service byte limit" },
          "422": { description: "Stored attachment payload is malformed" },
        },
      },
    },
    "/v1/messages/{id}/raw": {
      get: {
        operationId: "getMessageRaw",
        summary: "Mail-view: reconstructed raw MIME for a stored message",
        parameters: [...idParam],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { raw: { type: "string" }, message_id: { type: "string", nullable: true } }, required: ["raw"] },
              },
            },
          },
        },
      },
    },
    "/v1/mailboxes": {
      get: {
        operationId: "listMailboxes",
        summary: "Mail-view: registered addresses as mailboxes plus global folder counts",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    mailboxes: { type: "array", items: { $ref: "#/components/schemas/Mailbox" } },
                    counts: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    // Bespoke scoped-send-key endpoints. These are NOT part of the generic
    // resource CRUD: the token and its hash live only on the server, so minting
    // and verification are dedicated routes (the /v1/send-keys resource itself is
    // summary-only and never returns a hash).
    "/v1/send-keys/mint": {
      post: {
        operationId: "mintSendKey",
        summary: "Issue a scoped send key; the token is returned ONCE and never stored",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { owner_id: { type: "string" }, label: { type: "string", nullable: true } },
                required: ["owner_id"],
              },
            },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { token: { type: "string" }, key: { type: "object", additionalProperties: true } },
                  required: ["token", "key"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/send-keys/verify": {
      post: {
        operationId: "verifySendKey",
        summary: "Verify a send-key token and (optionally) that it may send from a given address",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { token: { type: "string" }, from: { type: "string" } },
                required: ["token"],
              },
            },
          },
        },
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    valid: { type: "boolean" },
                    authorized: { type: "boolean" },
                    key: { type: "object", additionalProperties: true, nullable: true },
                  },
                  required: ["valid", "authorized"],
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      User: userSchema as never,
      Tenant: tenantSchema as never,
      EmailIdentity: emailIdentitySchema as never,
      Membership: membershipSchema as never,
      Domain: domainSchema as never,
      Address: addressSchema as never,
      MessageListItem: messageListItemSchema as never,
      Message: messageSchema as never,
      SendIntentMessage: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          send_state: {
            type: "string",
            enum: ["none", "pending", "blocked", "cancelled", "sending", "sent", "uncertain"],
          },
        },
        required: ["id", "send_state"],
      } as never,
      SendIntentLookup: sendIntentLookupSchema as never,
      SendIntentCancellation: sendIntentCancellationSchema as never,
      SendMessageError: sendMessageErrorSchema as never,
      AttachmentContent: attachmentContentSchema as never,
      Thread: threadSchema as never,
      Mailbox: mailboxSchema as never,
    },
    securitySchemes: {
      apiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Tenant-bound hasna_ API key.",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Opaque session or API key",
        description: "Authorization: Bearer accepts an emss_ user session or tenant-bound hasna_ API key.",
      },
    },
  },
};
