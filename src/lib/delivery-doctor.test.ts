import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createAddress } from "../db/addresses.js";
import { createDomain, updateDnsStatus } from "../db/domains.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { setAddressProvisioning, setDomainProvisioning } from "../db/provisioning.js";
import { setInboundArchived, storeInboundEmail } from "../db/inbound.js";
import { diagnoseInboundDelivery } from "./delivery-doctor.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("delivery doctor", () => {
  it("reports configured address ownership and receive readiness", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = createAddress({ provider_id: provider.id, email: "ops@example.com" });
    const owner = createOwner({ type: "agent", name: "agent" });
    assignAddressOwner(address.id, owner.id);
    setAddressProvisioning(address.id, { provisioning_status: "ready" });

    const report = diagnoseInboundDelivery("ops@example.com");

    expect(report.checks.some((check) => check.name === "Configured address" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Ownership" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Address receive readiness" && check.status === "pass")).toBe(true);
  });

  it("diagnoses one address without depending on all address/domain rows", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const domain = updateDnsStatus(createDomain(provider.id, "Example.com").id, "verified", "verified", "verified");
    const address = createAddress({ provider_id: provider.id, email: "Ops@Example.com" });
    setAddressProvisioning(address.id, { domain_id: domain.id, provisioning_status: "ready" });

    const db = getDatabase();
    const timestamp = new Date().toISOString();
    db.run("BEGIN");
    try {
      for (let i = 0; i < 10025; i++) {
        db.run(
          `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 0, ?, ?)`,
          [`bulk-address-${i}`, provider.id, `bulk-${i}@other.example`, timestamp, timestamp],
        );
        db.run(
          `INSERT INTO domains (id, provider_id, domain, dkim_status, spf_status, dmarc_status, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 'pending', 'pending', ?, ?)`,
          [`bulk-domain-${i}`, provider.id, `bulk-${i}.example`, timestamp, timestamp],
        );
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    const report = diagnoseInboundDelivery("ops@example.com", db);
    expect(report.checks.some((check) => check.name === "Configured address" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Domain receive readiness" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Domain send readiness" && check.status === "pass")).toBe(true);
  });

  it("summarizes recent local mail without hydrating inbound bodies", () => {
    const db = getDatabase();
    storeInboundEmail({
      provider_id: null,
      message_id: "<old@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "old",
      text_body: "old body",
      html_body: "<p>old body</p>",
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-01T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: null,
      message_id: "<new@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "new",
      text_body: "new body",
      html_body: "<p>new body</p>",
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);
    const archived = storeInboundEmail({
      provider_id: null,
      message_id: "<archived@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "archived",
      text_body: "archived body",
      html_body: "<p>archived body</p>",
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);
    setInboundArchived(archived.id, true, db);
    storeInboundEmail({
      provider_id: null,
      message_id: "<other@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["other@example.com"],
      cc_addresses: [],
      subject: "other",
      text_body: "other body",
      html_body: "<p>other body</p>",
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-04T10:00:00.000Z",
    }, db);

    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    const report = diagnoseInboundDelivery("ops@example.com", recordingDb);

    expect(report.recent_local_messages).toBe(2);
    expect(report.latest_received_at).toBe("2026-01-02T10:00:00.000Z");
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "Recent local mail",
      status: "pass",
      message: "2 local message(s) found for ops@example.com.",
    }));
    expect(queries.some((sql) => sql.includes("FROM inbound_recipients recipient") && sql.includes("JOIN inbound_emails"))).toBe(true);
    expect(queries.some((sql) => sql.includes("SELECT * FROM inbound_emails"))).toBe(false);
  });

  it("batches provisioning and readiness lookups across duplicate provider matches", () => {
    const first = createProvider({ name: "first", type: "sandbox" });
    const second = createProvider({ name: "second", type: "sandbox" });
    const firstDomain = updateDnsStatus(createDomain(first.id, "example.com").id, "verified", "verified", "verified");
    const secondDomain = createDomain(second.id, "example.com");
    const firstAddress = createAddress({ provider_id: first.id, email: "ops@example.com" });
    const secondAddress = createAddress({ provider_id: second.id, email: "ops@example.com" });
    const owner = createOwner({ type: "agent", name: "agent" });
    assignAddressOwner(firstAddress.id, owner.id);
    assignAddressOwner(secondAddress.id, owner.id);
    setAddressProvisioning(firstAddress.id, { domain_id: firstDomain.id, provisioning_status: "ready" });
    setAddressProvisioning(secondAddress.id, { domain_id: secondDomain.id, provisioning_status: "requested" });
    setDomainProvisioning(firstDomain.id, { provisioning_status: "ready" });
    setDomainProvisioning(secondDomain.id, { provisioning_status: "requested" });

    const db = getDatabase();
    const queries: string[] = [];
    const recordingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      },
    }) as typeof db;

    const report = diagnoseInboundDelivery("ops@example.com", recordingDb);

    expect(report.checks.filter((check) => check.name === "Configured address" && check.status === "pass")).toHaveLength(2);
    expect(report.checks.filter((check) => check.name === "Ownership" && check.status === "pass")).toHaveLength(2);
    expect(report.checks.some((check) => check.name === "Address receive readiness" && check.status === "pass")).toBe(true);
    expect(report.checks.some((check) => check.name === "Address receive readiness" && check.status === "warn")).toBe(true);
    expect(report.checks.filter((check) => check.name === "Domain receive readiness")).toHaveLength(2);
    expect(queries.filter((sql) => sql.includes("FROM addresses") && sql.includes("WHERE id IN"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("FROM domains") && sql.includes("WHERE id IN"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("FROM addresses") && sql.includes("WHERE domain_id IN"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("FROM addresses") && sql.includes("WHERE id = ?"))).toHaveLength(0);
    expect(queries.filter((sql) => sql.includes("FROM domains") && sql.includes("WHERE id = ?"))).toHaveLength(0);
    expect(queries.filter((sql) => sql.includes("FROM addresses") && sql.includes("WHERE domain_id = ?"))).toHaveLength(0);
  });
});
