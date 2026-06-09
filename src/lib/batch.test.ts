import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "../db/database.js";
import { createProvider } from "../db/providers.js";
import { createTemplate } from "../db/templates.js";
import { getContact, suppressContact } from "../db/contacts.js";
import { parseCsv, batchSend } from "./batch.js";
import type { Provider } from "../types/index.js";

let testProvider: Provider;

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const db = getDatabase();
  testProvider = createProvider({ name: "test", type: "resend", api_key: "re_test" }, db);
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("parseCsv", () => {
  it("parses CSV with headers", () => {
    const csv = "email,name,company\nalice@example.com,Alice,Acme\nbob@example.com,Bob,Corp";
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "Alice", company: "Acme" });
    expect(rows[1]).toEqual({ email: "bob@example.com", name: "Bob", company: "Corp" });
  });

  it("handles empty values", () => {
    const csv = "email,name\nalice@example.com,";
    const rows = parseCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "" });
  });

  it("returns empty array for header-only CSV", () => {
    const csv = "email,name";
    expect(parseCsv(csv)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("trims whitespace from headers and values", () => {
    const csv = " email , name \n alice@example.com , Alice ";
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual({ email: "alice@example.com", name: "Alice" });
  });
});

describe("batchSend", () => {
  it("sends emails from CSV using template", async () => {
    createTemplate({
      name: "welcome",
      subject_template: "Hello {{name}}",
      html_template: "<p>Welcome {{name}} from {{company}}</p>",
    });

    const csvContent = "email,name,company\nalice@example.com,Alice,Acme\nbob@example.com,Bob,Corp";
    const mockSendEmail = mock(() => Promise.resolve("msg-123"));

    const result = await batchSend({
      csvPath: "/fake/path.csv",
      templateName: "welcome",
      from: "sender@example.com",
      provider: testProvider,
      _adapter: { sendEmail: mockSendEmail },
      _csvContent: csvContent,
    });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.suppressed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(getContact("alice@example.com")?.send_count).toBe(1);
    expect(getContact("bob@example.com")?.send_count).toBe(1);
  });

  it("skips suppressed contacts", async () => {
    createTemplate({
      name: "welcome",
      subject_template: "Hello {{name}}",
    });

    suppressContact("alice@example.com");

    const csvContent = "email,name\nalice@example.com,Alice\nbob@example.com,Bob";
    const mockSendEmail = mock(() => Promise.resolve("msg-123"));

    const result = await batchSend({
      csvPath: "/fake/path.csv",
      templateName: "welcome",
      from: "sender@example.com",
      provider: testProvider,
      _adapter: { sendEmail: mockSendEmail },
      _csvContent: csvContent,
    });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends to suppressed contacts with force flag", async () => {
    createTemplate({
      name: "welcome",
      subject_template: "Hello {{name}}",
    });

    suppressContact("alice@example.com");

    const csvContent = "email,name\nalice@example.com,Alice";
    const mockSendEmail = mock(() => Promise.resolve("msg-123"));

    const result = await batchSend({
      csvPath: "/fake/path.csv",
      templateName: "welcome",
      from: "sender@example.com",
      provider: testProvider,
      force: true,
      _adapter: { sendEmail: mockSendEmail },
      _csvContent: csvContent,
    });

    expect(result.total).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.suppressed).toBe(0);
  });

  it("throws if template not found", async () => {
    await expect(
      batchSend({
        csvPath: "/fake/path.csv",
        templateName: "nonexistent",
        from: "sender@example.com",
        provider: testProvider,
        _csvContent: "email\nalice@example.com",
      }),
    ).rejects.toThrow("Template not found: nonexistent");
  });

  it("handles rows missing email column", async () => {
    createTemplate({
      name: "welcome",
      subject_template: "Hello",
    });

    const csvContent = "name\nAlice";
    const mockSendEmail = mock(() => Promise.resolve("msg-123"));

    const result = await batchSend({
      csvPath: "/fake/path.csv",
      templateName: "welcome",
      from: "sender@example.com",
      provider: testProvider,
      _adapter: { sendEmail: mockSendEmail },
      _csvContent: csvContent,
    });

    expect(result.total).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.error).toContain("missing 'email' column");
  });

  it("tracks send failures", async () => {
    createTemplate({
      name: "welcome",
      subject_template: "Hello",
    });

    const csvContent = "email\nalice@example.com\nbob@example.com";
    let callCount = 0;
    const mockSendEmail = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("Connection refused"));
      return Promise.resolve("msg-123");
    });

    const result = await batchSend({
      csvPath: "/fake/path.csv",
      templateName: "welcome",
      from: "sender@example.com",
      provider: testProvider,
      _adapter: { sendEmail: mockSendEmail },
      _csvContent: csvContent,
    });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.email).toBe("alice@example.com");
    expect(result.errors[0]!.error).toBe("Connection refused");
  });
});
