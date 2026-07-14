import { describe, expect, test } from "bun:test";
import type { TypedQueryClient } from "../../storage-kit/index.js";
import { EmailsSelfHostedStore, type AddressRecord } from "./store.js";

type PolicyAddress = Pick<AddressRecord, "id" | "email" | "status" | "verified" | "daily_quota"> & {
  owner_id: string | null;
  administrator_id: string | null;
  provisioning_status: string | null;
  domain: string | null;
  domain_status: string | null;
  domain_verified: boolean | null;
  domain_provisioning_status: string | null;
};

function policyStore(overrides: {
  address?: PolicyAddress | null;
  suppressed?: string | null;
  addressCount?: number;
  domainCount?: number;
  warming?: { target_daily_volume: number; start_date: string; status: string } | null;
} = {}) {
  const address: PolicyAddress | null = "address" in overrides ? overrides.address! : {
    id: "address-1",
    email: "sender@example.com",
    status: "active",
    verified: true,
    daily_quota: null,
    owner_id: "owner-1",
    administrator_id: "admin-1",
    provisioning_status: "ready",
    domain: "example.com",
    domain_status: "active",
    domain_verified: true,
    domain_provisioning_status: "ready",
  };
  const client: TypedQueryClient = {
    async query() { throw new Error("query not expected"); },
    async many<T>() { return [] as T[]; },
    async execute() {},
    async get<T>(sql: string): Promise<T | null> {
      if (sql.includes("FROM addresses a")) return address as T | null;
      if (sql.includes("FROM contacts")) {
        return overrides.suppressed ? { email: overrides.suppressed } as T : null;
      }
      if (sql.includes("FROM warming_schedules")) return (overrides.warming ?? null) as T | null;
      throw new Error(`unexpected get SQL: ${sql.slice(0, 80)}`);
    },
    async one<T>(sql: string): Promise<T> {
      if (sql.includes("FROM messages")) {
        return {
          address_count: overrides.addressCount ?? 1,
          domain_count: overrides.domainCount ?? 1,
        } as T;
      }
      throw new Error(`unexpected one SQL: ${sql.slice(0, 80)}`);
    },
  };
  return new EmailsSelfHostedStore(client).forTenant("00000000-0000-0000-0000-000000000001");
}

describe("central outbound policy", () => {
  test("allows a tenant credential to send only from a registered verified ready address", async () => {
    const decision = await policyStore().evaluateOutboundPolicy({
      from: "Sender <sender@example.com>",
      recipients: ["recipient@example.net"],
      allowTenantWideSend: true,
    });
    expect(decision).toEqual({ allowed: true });
  });

  test("fails closed for missing, inactive, unverified, or unready senders", async () => {
    expect((await policyStore({ address: null }).evaluateOutboundPolicy({ from: "x@example.com", recipients: [] }))).toMatchObject({ code: "sender_not_registered" });
    const base = {
      id: "a", email: "sender@example.com", status: "active", verified: true, daily_quota: null,
      owner_id: null, administrator_id: null, provisioning_status: "ready", domain: "example.com",
      domain_status: "active", domain_verified: true, domain_provisioning_status: "ready",
    } satisfies PolicyAddress;
    expect((await policyStore({ address: { ...base, status: "suspended" } }).evaluateOutboundPolicy({ from: base.email, recipients: [] }))).toMatchObject({ code: "sender_inactive" });
    expect((await policyStore({ address: { ...base, verified: false } }).evaluateOutboundPolicy({ from: base.email, recipients: [] }))).toMatchObject({ code: "sender_unverified" });
    expect((await policyStore({ address: {
      ...base,
      provisioning_status: "none",
      domain_status: "pending",
      domain_verified: false,
      domain_provisioning_status: "none",
    } }).evaluateOutboundPolicy({ from: base.email, recipients: [] }))).toMatchObject({ code: "sender_not_ready" });
  });

  test("blocks suppression, per-address quota, and active warming limits", async () => {
    expect((await policyStore({ suppressed: "blocked@example.net" }).evaluateOutboundPolicy({
      from: "sender@example.com",
      recipients: ["blocked@example.net"],
      allowTenantWideSend: true,
    }))).toMatchObject({ code: "recipient_suppressed", status: 409 });
    const quotaStore = policyStore({ addressCount: 1 });
    const addressDecision = await policyStore({
      address: {
        id: "a", email: "sender@example.com", status: "active", verified: true, daily_quota: 0,
        owner_id: null, administrator_id: null, provisioning_status: "ready", domain: "example.com",
        domain_status: "active", domain_verified: true, domain_provisioning_status: "ready",
      },
      addressCount: 1,
    }).evaluateOutboundPolicy({ from: "sender@example.com", recipients: [], allowTenantWideSend: true });
    expect(addressDecision).toMatchObject({ code: "address_quota_exceeded", status: 429 });
    void quotaStore;
    expect((await policyStore({
      domainCount: 1,
      warming: { target_daily_volume: 0, start_date: new Date().toISOString(), status: "active" },
    }).evaluateOutboundPolicy({ from: "sender@example.com", recipients: [], allowTenantWideSend: true }))).toMatchObject({
      code: "warming_limit_exceeded",
      status: 429,
    });
  });

  test("a supplied send key must be valid and scoped to the sender owner", async () => {
    expect((await policyStore().evaluateOutboundPolicy({
      from: "sender@example.com", recipients: [], allowTenantWideSend: false,
    }))).toMatchObject({ code: "send_key_required" });

    const invalid = policyStore();
    invalid.verifySendKey = async () => null;
    expect((await invalid.evaluateOutboundPolicy({
      from: "sender@example.com", recipients: [], sendKeyToken: "esk_invalid",
    }))).toMatchObject({ code: "send_key_invalid" });

    const foreign = policyStore();
    foreign.verifySendKey = async () => ({
      id: "key", owner_id: "other-owner", prefix: "esk_other", label: null,
      last_used_at: null, revoked_at: null, created_at: "now", updated_at: "now",
    });
    expect((await foreign.evaluateOutboundPolicy({
      from: "sender@example.com", recipients: [], sendKeyToken: "esk_foreign",
    }))).toMatchObject({ code: "send_key_forbidden" });
  });
});
