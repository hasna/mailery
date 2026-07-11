import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { createProvider, updateProvider } from "../db/providers.js";
import { createDomain, updateDnsStatus } from "../db/domains.js";
import { createAddress } from "../db/addresses.js";
import { createTemplate } from "../db/templates.js";
import { suppressContact, upsertContact } from "../db/contacts.js";
import { runDiagnostics, formatDiagnostics } from "./doctor.js";
import type { DoctorCheck } from "./doctor.js";
import type { Database } from "../db/database.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let previousHome: string | undefined;
let tempHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-doctor-test-home-"));
  process.env["HOME"] = tempHome;
  process.env["EMAILS_DB_PATH"] = ":memory:";
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_STORAGE_MODE"];
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["EMAILS_MODE"];
  delete process.env["HASNA_EMAILS_MODE"];
  delete process.env["EMAILS_MODE"];
  delete process.env["EMAILS_STORAGE_MODE"];
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  previousHome = undefined;
});

describe("runDiagnostics", () => {
  it("reports database accessible", async () => {
    const checks = await runDiagnostics();
    const dbCheck = checks.find((c) => c.name === "Database");
    expect(dbCheck).toBeDefined();
    expect(dbCheck!.status).toBe("pass");
    expect(dbCheck!.message).toContain("accessible");
  });

  it("returns a database failure instead of continuing with a broken handle", async () => {
    const brokenDb = {
      query: () => ({
        get: () => {
          throw new Error("cannot open database");
        },
      }),
    } as unknown as Database;

    const checks = await runDiagnostics(brokenDb);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "Database",
      status: "fail",
    });
    expect(checks[0]?.message).toContain("cannot open database");
  });

  it("warns when no providers configured", async () => {
    const checks = await runDiagnostics();
    const provCheck = checks.find((c) => c.name === "Providers");
    expect(provCheck).toBeDefined();
    expect(provCheck!.status).toBe("warn");
    expect(provCheck!.message).toContain("No providers configured");
  });

  it("passes when providers exist", async () => {
    createProvider({ name: "Test", type: "resend", api_key: "re_test" });
    const checks = await runDiagnostics();
    const provCheck = checks.find((c) => c.name === "Providers");
    expect(provCheck!.status).toBe("pass");
    expect(provCheck!.message).toContain("1 provider(s)");
  });

  it("checks domain verification status", async () => {
    const p = createProvider({ name: "Test", type: "resend" });
    createDomain(p.id, "example.com");
    createDomain(p.id, "test.com");

    const checks = await runDiagnostics();
    const domCheck = checks.find((c) => c.name === "Domains");
    expect(domCheck).toBeDefined();
    expect(domCheck!.message).toContain("0/2 domains verified");
    expect(domCheck!.status).toBe("warn");
  });

  it("passes when all domains verified", async () => {
    const p = createProvider({ name: "Test", type: "resend" });
    const d1 = createDomain(p.id, "example.com");
    updateDnsStatus(d1.id, "verified", "verified", "verified");

    const checks = await runDiagnostics();
    const domCheck = checks.find((c) => c.name === "Domains");
    expect(domCheck!.status).toBe("pass");
    expect(domCheck!.message).toContain("1/1 domains verified");
  });

  it("counts addresses", async () => {
    const p = createProvider({ name: "Test", type: "resend" });
    createAddress({ provider_id: p.id, email: "a@test.com" });
    createAddress({ provider_id: p.id, email: "b@test.com" });

    const checks = await runDiagnostics();
    const addrCheck = checks.find((c) => c.name === "Addresses");
    expect(addrCheck).toBeDefined();
    expect(addrCheck!.message).toContain("2 sender address(es)");
  });

  it("warns on suppressed contacts", async () => {
    upsertContact("a@test.com");
    suppressContact("b@test.com");

    const checks = await runDiagnostics();
    const contactCheck = checks.find((c) => c.name === "Contacts");
    expect(contactCheck).toBeDefined();
    expect(contactCheck!.status).toBe("warn");
    expect(contactCheck!.message).toContain("1 suppressed");
  });

  it("passes contacts when none suppressed", async () => {
    upsertContact("a@test.com");

    const checks = await runDiagnostics();
    const contactCheck = checks.find((c) => c.name === "Contacts");
    expect(contactCheck!.status).toBe("pass");
    expect(contactCheck!.message).toContain("0 suppressed");
  });

  it("counts templates", async () => {
    createTemplate({ name: "welcome", subject_template: "Welcome!", text_template: "Hi" });

    const checks = await runDiagnostics();
    const tmplCheck = checks.find((c) => c.name === "Templates");
    expect(tmplCheck).toBeDefined();
    expect(tmplCheck!.message).toContain("1 template(s)");
  });

  it("aggregates large diagnostic counts without hydrating list rows", async () => {
    const provider = createProvider({ name: "Local", type: "sandbox" });
    const db = getDatabase();
    const timestamp = new Date().toISOString();
    const total = 10025;
    db.run("BEGIN");
    try {
      for (let i = 0; i < total; i++) {
        db.run(
          `INSERT INTO domains (id, provider_id, domain, dkim_status, spf_status, dmarc_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 'pending', ?, ?)`,
          [`diag-domain-${i}`, provider.id, `diag-${i}.example.com`, i % 2 === 0 ? "verified" : "pending", timestamp, timestamp],
        );
        db.run(
          `INSERT INTO addresses (id, provider_id, email, display_name, verified, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 0, ?, ?)`,
          [`diag-address-${i}`, provider.id, `diag-${i}@example.com`, timestamp, timestamp],
        );
        db.run(
          `INSERT INTO contacts (id, email, name, send_count, bounce_count, complaint_count, last_sent_at, suppressed, created_at, updated_at)
           VALUES (?, ?, NULL, 0, 0, 0, NULL, ?, ?, ?)`,
          [`diag-contact-${i}`, `diag-${i}@example.com`, i % 4 === 0 ? 1 : 0, timestamp, timestamp],
        );
        db.run(
          `INSERT INTO templates (id, name, subject_template, html_template, text_template, metadata, created_at, updated_at)
           VALUES (?, ?, 'Subject', NULL, 'Text', '{}', ?, ?)`,
          [`diag-template-${i}`, `diag-template-${i}`, timestamp, timestamp],
        );
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    const checks = await runDiagnostics(db);
    expect(checks.find((c) => c.name === "Domains")?.message).toContain("5013/10025 domains verified");
    expect(checks.find((c) => c.name === "Addresses")?.message).toContain("10025 sender address(es)");
    expect(checks.find((c) => c.name === "Contacts")?.message).toContain("10025 contacts (2507 suppressed)");
    expect(checks.find((c) => c.name === "Templates")?.message).toContain("10025 template(s)");
  });

  it("includes provider health checks for active providers", async () => {
    createProvider({ name: "MyResend", type: "resend", api_key: "re_test" });
    const checks = await runDiagnostics();
    const provHealthCheck = checks.find((c) => c.name.startsWith("Provider: MyResend"));
    expect(provHealthCheck).toBeDefined();
    expect(provHealthCheck?.message).toContain("live credential check skipped");
  });

  it("does not treat stored SES provider keys as full AWS provisioning readiness", async () => {
    createProvider({
      name: "SES",
      type: "ses",
      region: "us-east-1",
      access_key: "AKIA_TEST",
      secret_key: "secret",
    });

    const saved = {
      AWS_PROFILE: process.env["AWS_PROFILE"],
      AWS_ACCESS_KEY_ID: process.env["AWS_ACCESS_KEY_ID"],
      AWS_SECRET_ACCESS_KEY: process.env["AWS_SECRET_ACCESS_KEY"],
      AWS_SESSION_TOKEN: process.env["AWS_SESSION_TOKEN"],
    };
    delete process.env["AWS_PROFILE"];
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AWS_SESSION_TOKEN"];
    try {
      const checks = await runDiagnostics();
      const awsProvisioning = checks.find((c) => c.name === "Provisioning: aws");
      expect(awsProvisioning).toMatchObject({
        status: "warn",
      });
      expect(awsProvisioning?.message).toContain("Stored SES provider credentials");
      expect(awsProvisioning?.message).toContain("AWS domain purchase");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("can run live provider credential checks explicitly", async () => {
    createProvider({ name: "BrokenResend", type: "resend" });
    const checks = await runDiagnostics(undefined, { liveProviderChecks: true });
    const provHealthCheck = checks.find((c) => c.name.startsWith("Provider: BrokenResend"));
    expect(provHealthCheck).toBeDefined();
    expect(provHealthCheck?.message).toContain("Credentials invalid");
  });
});

describe("formatDiagnostics", () => {
  it("formats checks with pass/warn/fail icons", () => {
    const checks: DoctorCheck[] = [
      { name: "Database", status: "pass", message: "OK" },
      { name: "Config", status: "warn", message: "Missing" },
      { name: "Creds", status: "fail", message: "Invalid" },
    ];
    const out = formatDiagnostics(checks);
    expect(out).toContain("Database");
    expect(out).toContain("OK");
    expect(out).toContain("Config");
    expect(out).toContain("Missing");
    expect(out).toContain("Creds");
    expect(out).toContain("Invalid");
    expect(out).toContain("Summary");
    expect(out).toContain("1 passed");
    expect(out).toContain("1 warnings");
    expect(out).toContain("1 failed");
  });

  it("formats all-pass summary without warnings/failures", () => {
    const checks: DoctorCheck[] = [
      { name: "A", status: "pass", message: "Good" },
      { name: "B", status: "pass", message: "Great" },
    ];
    const out = formatDiagnostics(checks);
    expect(out).toContain("2 passed");
    expect(out).not.toContain("warnings");
    expect(out).not.toContain("failed");
  });

  it("contains diagnostics header", () => {
    const out = formatDiagnostics([]);
    expect(out).toContain("Email System Diagnostics");
    expect(out).toContain("Summary");
  });
});
