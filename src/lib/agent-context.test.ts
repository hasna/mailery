import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider, updateProvider } from "../db/providers.js";
import { createAddress, markVerified } from "../db/addresses.js";
import { createDomain, updateDnsStatus } from "../db/domains.js";
import { storeInboundEmail, setInboundArchived, setInboundRead } from "../db/inbound.js";
import { createOwner, assignAddressOwner } from "../db/owners.js";
import { setAddressProvisioning, setDomainProvisioning } from "../db/provisioning.js";
import { getEmailSystemStatus, getNextEmailAction } from "./agent-context.js";

let previousHome: string | undefined;
let tempHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-agent-context-test-home-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  previousHome = undefined;
});

describe("agent context", () => {
  it("summarizes providers, verified senders, and ownership", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const address = markVerified(createAddress({ provider_id: provider.id, email: "ops@example.com" }).id);
    const owner = createOwner({ type: "agent", name: "agent" });
    assignAddressOwner(address.id, owner.id);

    const status = getEmailSystemStatus();

    expect(status.providers.total).toBe(1);
    expect(status.addresses.total).toBe(1);
    expect(status.addresses.owned).toBe(1);
    expect(status.addresses.usable_from[0]?.email).toBe("ops@example.com");
  });

  it("builds status from provider summaries without selecting credentials", () => {
    const db = getDatabase();
    createProvider({
      name: "resend-prod",
      type: "resend",
      api_key: "re_secret",
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

    const status = getEmailSystemStatus(recordingDb);
    const providerQueries = queries.filter((sql) => sql.includes("FROM providers"));

    expect(status.providers.total).toBe(1);
    expect(status.providers.by_type.resend).toBe(1);
    expect(providerQueries.length).toBeGreaterThan(0);
    expect(providerQueries.join("\n")).not.toContain("SELECT *");
    expect(providerQueries.join("\n")).not.toMatch(/\b(api_key|access_key|secret_key|oauth_client_secret|oauth_refresh_token|oauth_access_token)\b/);
  });

  it("summarizes large address tables without hydrating every address as a usable sender", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const usable = markVerified(createAddress({ provider_id: provider.id, email: "usable@example.com" }).id);
    const owner = createOwner({ type: "agent", name: "agent" });
    assignAddressOwner(usable.id, owner.id);
    setAddressProvisioning(usable.id, { provisioning_status: "ready" });
    const suspended = markVerified(createAddress({ provider_id: provider.id, email: "suspended@example.com" }).id);

    const db = getDatabase();
    db.run("UPDATE addresses SET status = 'suspended' WHERE id = ?", [suspended.id]);
    const timestamp = new Date().toISOString();
    db.run("BEGIN");
    try {
      for (let i = 0; i < 10025; i++) {
        db.run(
          `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 0, ?, ?)`,
          [`bulk-${i}`, provider.id, `bulk-${i}@example.com`, timestamp, timestamp],
        );
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    const status = getEmailSystemStatus(db);
    expect(status.addresses.total).toBe(10027);
    expect(status.addresses.active).toBe(10026);
    expect(status.addresses.verified).toBe(2);
    expect(status.addresses.owned).toBe(1);
    expect(status.addresses.ready_to_receive).toBe(1);
    expect(status.addresses.usable_from.map((address) => address.email)).toEqual(["usable@example.com"]);
    expect(status.addresses.usable_from_truncated).toBe(false);
  });

  it("caps the usable_from orientation list for many verified senders", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    for (let i = 0; i < 55; i++) {
      const address = createAddress({ provider_id: provider.id, email: `usable-${i}@example.com` });
      markVerified(address.id);
    }

    const status = getEmailSystemStatus();

    expect(status.addresses.verified).toBe(55);
    expect(status.addresses.usable_from_limit).toBe(25);
    expect(status.addresses.usable_from).toHaveLength(25);
    expect(status.addresses.usable_from_truncated).toBe(true);
  });

  it("summarizes large domain tables without returning every readiness row", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const db = getDatabase();
    for (let i = 0; i < 55; i++) {
      const domain = updateDnsStatus(createDomain(provider.id, `ready-${i}.example.com`).id, "verified", "verified", "verified");
      setDomainProvisioning(domain.id, { provisioning_status: "ready" });
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-02-${String(i + 1).padStart(2, "0")} 00:00:00`, domain.id]);
    }

    const status = getEmailSystemStatus(db);

    expect(status.domains.total).toBe(55);
    expect(status.domains.send_ready).toBe(55);
    expect(status.domains.receive_ready).toBe(55);
    expect(status.domains.usable_limit).toBe(25);
    expect(status.domains.usable).toHaveLength(25);
    expect(status.domains.usable_truncated).toBe(true);
  });

  it("finds a domain fix command outside the bounded readiness list", () => {
    const provider = createProvider({ name: "sandbox", type: "sandbox" });
    const db = getDatabase();
    const old = createDomain(provider.id, "old-needs-dns.example.com");
    db.run("UPDATE domains SET created_at = ? WHERE id = ?", ["2026-01-01 00:00:00", old.id]);

    for (let i = 0; i < 30; i++) {
      const domain = updateDnsStatus(createDomain(provider.id, `ready-${i}.example.com`).id, "verified", "verified", "verified");
      setDomainProvisioning(domain.id, { provisioning_status: "ready" });
      db.run("UPDATE domains SET created_at = ? WHERE id = ?", [`2026-02-${String(i + 1).padStart(2, "0")} 00:00:00`, domain.id]);
    }

    const status = getEmailSystemStatus(db);

    expect(status.domains.usable.map((domain) => domain.domain)).not.toContain("old-needs-dns.example.com");
    expect(status.next_actions).toContain("emails domain dns old-needs-dns.example.com");
  });

  it("suggests wait-code for verification goals", () => {
    const next = getNextEmailAction("need verification code");
    expect(next).toMatchObject({ command: "emails inbox wait-code <address> --timeout 120" });
  });

  it("reports the newest inbound timestamp even when older mail is archived", () => {
    const older = storeInboundEmail({
      provider_id: null,
      message_id: "<older@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "older",
      text_body: "older",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-01T10:00:00.000Z",
    });
    setInboundArchived(older.id, true);
    storeInboundEmail({
      provider_id: null,
      message_id: "<newer@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "newer",
      text_body: "newer",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    });

    expect(getEmailSystemStatus().inbox.latest_received_at).toBe("2026-01-02T10:00:00.000Z");
  });

  it("summarizes inbox totals, unread, and latest timestamp with one aggregate query", () => {
    const db = getDatabase();
    const read = storeInboundEmail({
      provider_id: null,
      message_id: "<read@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "read",
      text_body: "read",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-01T10:00:00.000Z",
    }, db);
    setInboundRead(read.id, true, db);
    const archived = storeInboundEmail({
      provider_id: null,
      message_id: "<archived@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "archived",
      text_body: "archived",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-03T10:00:00.000Z",
    }, db);
    setInboundArchived(archived.id, true, db);
    storeInboundEmail({
      provider_id: null,
      message_id: "<unread@example.com>",
      from_address: "sender@example.com",
      to_addresses: ["ops@example.com"],
      cc_addresses: [],
      subject: "unread",
      text_body: "unread",
      html_body: null,
      attachments: [],
      headers: {},
      raw_size: 1,
      received_at: "2026-01-02T10:00:00.000Z",
    }, db);
    storeInboundEmail({
      provider_id: null,
      message_id: "<sent@example.com>",
      from_address: "ops@example.com",
      to_addresses: ["sender@example.com"],
      cc_addresses: [],
      subject: "sent",
      text_body: "sent",
      html_body: null,
      attachments: [],
      headers: {},
      label_ids: ["SENT"],
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

    const status = getEmailSystemStatus(recordingDb);

    expect(status.inbox.total).toBe(3);
    expect(status.inbox.unread).toBe(1);
    expect(status.inbox.latest_received_at).toBe("2026-01-03T10:00:00.000Z");
    expect(queries.filter((sql) => sql.includes("COUNT(*) AS total") && sql.includes("MAX(received_at) AS latest_received_at"))).toHaveLength(1);
    expect(queries.some((sql) => sql.includes("WHERE is_sent = 0"))).toBe(true);
    expect(queries.filter((sql) => sql.includes("COUNT(*) as count FROM inbound_emails"))).toHaveLength(0);
    expect(queries.filter((sql) => sql.includes("MAX(received_at) as latest FROM inbound_emails"))).toHaveLength(0);
  });
});
