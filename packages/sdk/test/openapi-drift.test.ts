// Contract-drift guard (freezes /api/v1). Every `stable` endpoint the SDK calls
// MUST exist (path + method) in this repo's docs/openapi.json; every `pending`
// endpoint MUST still be absent (so the day the server ships it, this test
// fails and forces us to promote it). Pure test — no server, no mocks.

import { describe, expect, test } from "bun:test";
import { ENDPOINT_LIST } from "../src/endpoints.js";

const SPEC_URL = new URL("../../../docs/openapi.json", import.meta.url);

type Operation = Record<string, unknown>;
type PathItem = Record<string, Operation | unknown>;
interface OpenApiSpec {
  openapi?: string;
  paths?: Record<string, PathItem | undefined>;
}

async function loadSpec(): Promise<OpenApiSpec> {
  return (await Bun.file(SPEC_URL).json()) as OpenApiSpec;
}

function hasOperation(spec: OpenApiSpec, path: string, method: string): boolean {
  const item = spec.paths?.[path];
  if (!item) return false;
  return Object.prototype.hasOwnProperty.call(item, method.toLowerCase());
}

function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\/$/, "") || "/"}`;
}

function specOperations(spec: OpenApiSpec): string[] {
  const methods = new Set(["get", "post", "patch", "delete", "put"]);
  const operations: string[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item) continue;
    for (const method of Object.keys(item)) {
      if (methods.has(method)) operations.push(operationKey(method, path));
    }
  }
  return operations.sort();
}

const OPENAPI_COVERAGE_EXCEPTIONS = new Map<string, string>([
  ["GET /health", "load-balancer health probe, not a tenant/client API operation"],
  ["GET /docs", "public human documentation"],
  ["GET /openapi.json", "public machine-readable contract"],
  ["GET /changelog", "public contract changelog"],
  ["GET /legal/terms", "public legal document"],
  ["GET /legal/privacy", "public legal document"],
  ["GET /legal/refunds", "public legal document"],
  ["POST /webhooks/stripe", "Stripe-to-server webhook, not a client/operator SDK route"],
]);

describe("SDK ↔ /api/v1 contract drift", () => {
  test("domain status documents an explicitly unqueried registrar without changing availability checks", async () => {
    const spec = await Bun.file(SPEC_URL).json();
    const availability = spec.components.schemas.DomainProviderStatus.properties.availability;
    expect(availability.allOf).toEqual([{ $ref: "#/components/schemas/DomainAvailability" }]);
    expect(availability.properties.check_status.enum).toEqual(["not_requested"]);
    expect(spec.paths["/api/v1/domains/status"].get.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/DomainProviderStatus");
  });
  test("docs/openapi.json is a valid OpenAPI 3.1 document with paths", async () => {
    const spec = await loadSpec();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths && typeof spec.paths === "object").toBe(true);
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
  });

  test("every STABLE SDK endpoint exists in docs/openapi.json (path + method)", async () => {
    const spec = await loadSpec();
    const missing = ENDPOINT_LIST
      .filter((e) => e.state === "stable")
      .filter((e) => !hasOperation(spec, e.path, e.method))
      .map((e) => `${e.method} ${e.path}  (sdk: ${e.id})`);

    if (missing.length > 0) {
      const documented = Object.keys(spec.paths ?? {}).sort().join("\n  ");
      throw new Error(
        `SDK calls ${missing.length} route(s) missing from docs/openapi.json — /api/v1 drift:\n  ` +
          missing.join("\n  ") +
          `\n\nDocumented paths:\n  ${documented}`,
      );
    }
    expect(missing).toEqual([]);
  });

  test("every PENDING SDK endpoint is still absent from docs/openapi.json", async () => {
    const spec = await loadSpec();
    // A pending endpoint appearing in the spec means the server shipped it and
    // the SDK method should be promoted from `pending` to `stable`.
    const nowLive = ENDPOINT_LIST
      .filter((e) => e.state === "pending")
      .filter((e) => hasOperation(spec, e.path, e.method))
      .map((e) => `${e.method} ${e.path}  (sdk: ${e.id})`);

    if (nowLive.length > 0) {
      throw new Error(
        "Pending SDK endpoint(s) now exist in docs/openapi.json — promote them to state:\"stable\" in src/endpoints.ts:\n  " +
          nowLive.join("\n  "),
      );
    }
    expect(nowLive).toEqual([]);
  });

  test("every OpenAPI operation is covered by the SDK endpoint manifest or an explicit exception", async () => {
    const spec = await loadSpec();
    const covered = new Set(
      ENDPOINT_LIST
        .filter((e) => e.state === "stable" || e.state === "unversioned")
        .map((e) => operationKey(e.method, e.path)),
    );
    const missing = specOperations(spec)
      .filter((key) => !covered.has(key))
      .filter((key) => !OPENAPI_COVERAGE_EXCEPTIONS.has(key));

    if (missing.length > 0) {
      throw new Error(
        "OpenAPI operation(s) lack SDK endpoint-manifest coverage or an explicit exception:\n  " +
          missing.join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });


  test("the SDK surface stays covered by exactly the expected endpoint states", () => {
    // Locks the manifest so a future edit that silently drops a route or flips a
    // state is caught here.
    const byState = ENDPOINT_LIST.reduce<Record<string, string[]>>((acc, e) => {
      (acc[e.state] ??= []).push(e.id);
      return acc;
    }, {});
    // Nothing is pending any more: revokeAllKeys (D-3) and purchaseDomain (P5)
    // both shipped in the billing-containment (P4) merge and were promoted.
    expect(byState.pending ?? []).toEqual([]);
    expect(byState.unversioned).toEqual(["health"]);
    // Stable = the frozen /api/v1 surface the SDK depends on. The reverse
    // OpenAPI coverage checks above now provide the full exhaustive coverage
    // assertion, so keep this test focused on accidental duplicate ids/states.
    expect(new Set(byState.stable ?? []).size).toBe((byState.stable ?? []).length);
    expect(byState.stable).toContain("accountExport");
    expect(byState.stable).toContain("billingPortal");
    expect(byState.stable).toContain("messageChanges");
    expect(byState.stable).toContain("generateDigest");
    expect(byState.stable).toContain("setupDomain");
    expect(byState.stable).toContain("adminFreezeTenant");
  });
});

// Billing is a single existing endpoint shared by CLI, SDK and MCP. Freeze its
// additive receive-usage contract so documentation cannot silently drop it.
test("billing OpenAPI includes inbound usage and account exports include its retained records", async () => {
  const spec = await Bun.file(SPEC_URL).json();
  const response = spec.paths["/api/v1/billing/overview"].get.responses["200"].content["application/json"].schema;
  expect(response.required).toContain("inbound_usage");
  expect(response.properties.inbound_usage.$ref).toBe("#/components/schemas/InboundUsage");
  const usage = spec.components.schemas.InboundUsage;
  expect(usage.required).toEqual(expect.arrayContaining(["metering_active", "month", "monthly_included", "received", "remaining_included", "charged_credits", "overage_credit_cost", "warning_percent", "status", "resets_at"]));
  expect(usage.properties.status.enum).toEqual(["within_allowance", "near_allowance", "overage", "paused"]);
  expect(spec.components.schemas.AccountExport.properties.inbound_usage_windows.type).toBe("array");
});

test("Checkout preserves original retry key compatibility and documents the required country declaration", async () => {
  const spec = await Bun.file(SPEC_URL).json();
  const operation = spec.paths["/api/v1/billing/checkout"].post;
  expect(operation.parameters).toContainEqual(expect.objectContaining({
    name: "Idempotency-Key", in: "header", required: false,
    schema: { type: "string", minLength: 8, maxLength: 200 },
  }));
  expect(operation.description).toContain("permanently replays");
  expect(operation.description).toContain("checkout_outcome_ambiguous");
  expect(operation.responses["200"].content["application/json"].schema.required).toEqual(["url"]);
});


test("both payable entries require full declaration for creation and expose exact historical replay", async () => {
  const spec = await Bun.file(SPEC_URL).json();
  for (const name of ["CheckoutRequest", "WalletTopupRequest"]) {
    const schema = spec.components.schemas[name];
    expect(schema.allOf[0].anyOf[0].required).toEqual(["country", "countryBasis", "countryPolicyVersion"]);
    expect(schema.allOf[0].anyOf[1].not.anyOf).toEqual(["country", "countryBasis", "countryPolicyVersion"].map(field => ({ required: [field] })));
    expect(schema.description).toContain("exact pre-country claim");
  }
  expect(spec.paths["/api/v1/billing/countries"].get.security).toEqual([]);
});
