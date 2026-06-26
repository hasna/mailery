import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAddress } from "../../db/addresses.js";
import { closeDatabase, getDatabase, resetDatabase } from "../../db/database.js";
import { createDomain } from "../../db/domains.js";
import { createProvider } from "../../db/providers.js";
import { setAddressProvisioning, setDomainProvisioning } from "../../db/provisioning.js";
import { handleApiRequest, routeModulesFor } from "../api-routes.js";
import { handleDashboardRequest } from "../serve.js";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3900${path}`, init);
  const url = new URL(req.url);
  const response = await handleApiRequest(req, url, url.pathname, req.method);
  if (!response) throw new Error(`No route handled ${req.method} ${path}`);
  return response;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await call(path, init);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return await response.json() as T;
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

let providerId: string;
let domainId: string;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["OPEN_IDENTITIES_STORE"] = "/tmp/missing-open-identities-store.json";
  process.env["MAILERY_MACHINE_ID"] = "machine003";
  resetDatabase();
  providerId = createProvider({ name: "ses", type: "ses" }).id;
  domainId = createDomain(providerId, "example.com").id;
  setDomainProvisioning(domainId, { provisioning_status: "ready", send_provider: "ses" });
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["OPEN_IDENTITIES_STORE"];
  delete process.env["MAILERY_MACHINE_ID"];
});

function ready(email: string): void {
  const address = createAddress({ provider_id: providerId, email }, getDatabase());
  setAddressProvisioning(address.id, { domain_id: domainId, receive_strategy: "ses-s3", provisioning_status: "ready" });
}

describe("BrowserPlan API routes", () => {
  it("routes BrowserPlan API paths through the core handler", () => {
    expect(routeModulesFor("/api/browserplan/coverage")).toEqual(["core"]);
  });

  it("lists, validates, and reserves BrowserPlan addresses", async () => {
    ready("profile@example.com");

    const coverage = await json<{ ready_addresses: number; gap_to_target_ready: number }>(
      "/api/browserplan/coverage?machine_id=machine003&target=1",
    );
    const validation = await json<{ valid: boolean; reason: string | null }>(
      "/api/browserplan/validate?machine_id=machine003&email=profile%40example.com",
    );
    const reservation = await json<{ owner: { external_id: string | null }; address: { email: string } }>(
      "/api/browserplan/reservations",
      postJson({
        machine_id: "machine003",
        email: "profile@example.com",
        identity: {
          id: "oid_profile",
          identifier: "agent:profile",
          name: "Profile Agent",
          kind: "agent",
        },
      }),
    );

    expect(coverage).toMatchObject({ ready_addresses: 1, gap_to_target_ready: 0 });
    expect(validation).toMatchObject({ valid: true, reason: null });
    expect(reservation).toMatchObject({
      owner: { external_id: "oid_profile" },
      address: { email: "profile@example.com" },
    });
  });

  it("rejects mismatched machine assertions on REST", async () => {
    ready("profile@example.com");

    const response = await call("/api/browserplan/coverage?machine_id=machine004&target=1");
    const body = await response.json() as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("does not match local Mailery machine");
  });

  it("uses specific REST statuses for not-ready and missing addresses", async () => {
    const pending = createAddress({ provider_id: providerId, email: "pending@example.com" }, getDatabase());
    setAddressProvisioning(pending.id, { domain_id: domainId, receive_strategy: "ses-s3", provisioning_status: "requested" });

    const notReady = await call("/api/browserplan/reservations", postJson({
      machine_id: "machine003",
      email: "pending@example.com",
      identity: { id: "oid_profile", name: "Profile Agent", kind: "agent" },
    }));
    const missing = await call("/api/browserplan/reservations", postJson({
      machine_id: "machine003",
      email: "missing@example.com",
      identity: { id: "oid_profile", name: "Profile Agent", kind: "agent" },
    }));

    expect(notReady.status).toBe(422);
    expect(missing.status).toBe(404);
  });

  it("keeps BrowserPlan mutations behind dashboard origin checks", async () => {
    ready("profile@example.com");
    const body = {
      machine_id: "machine003",
      email: "profile@example.com",
      identity: { id: "oid_profile", name: "Profile Agent", kind: "agent" },
    };

    const crossOrigin = await handleDashboardRequest(new Request("http://127.0.0.1:3900/api/browserplan/reservations", {
      ...postJson(body),
      headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    }));
    const missingOrigin = await handleDashboardRequest(new Request("http://127.0.0.1:3900/api/browserplan/reservations", postJson(body)));
    const sameOrigin = await handleDashboardRequest(new Request("http://127.0.0.1:3900/api/browserplan/reservations", {
      ...postJson(body),
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3900" },
    }));

    expect(crossOrigin.status).toBe(403);
    expect(missingOrigin.status).toBe(403);
    expect(sameOrigin.status).toBe(201);
  });
});
