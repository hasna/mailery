import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "./database.js";
import { createProvider } from "./providers.js";
import { createEmail } from "./emails.js";
import { storeEmailContent, getEmailContent } from "./email-content.js";

let providerId: string;
let emailId: string;

const baseOpts = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  subject: "Test Subject",
  text: "Hello world",
};

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  const p = createProvider({ name: "Test", type: "resend" });
  providerId = p.id;
  const email = createEmail(providerId, baseOpts);
  emailId = email.id;
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

describe("storeEmailContent", () => {
  it("stores text content", () => {
    storeEmailContent(emailId, { text: "Hello world" });
    const content = getEmailContent(emailId);
    expect(content).not.toBeNull();
    expect(content!.text_body).toBe("Hello world");
    expect(content!.html).toBeNull();
    expect(content!.headers).toEqual({});
  });

  it("stores html content", () => {
    storeEmailContent(emailId, { html: "<p>Hello</p>" });
    const content = getEmailContent(emailId);
    expect(content).not.toBeNull();
    expect(content!.html).toBe("<p>Hello</p>");
    expect(content!.text_body).toBeNull();
  });

  it("stores both html and text", () => {
    storeEmailContent(emailId, { html: "<p>Hello</p>", text: "Hello" });
    const content = getEmailContent(emailId);
    expect(content!.html).toBe("<p>Hello</p>");
    expect(content!.text_body).toBe("Hello");
  });

  it("stores headers", () => {
    storeEmailContent(emailId, {
      text: "body",
      headers: { "X-Custom": "value", "X-Priority": "1" },
    });
    const content = getEmailContent(emailId);
    expect(content!.headers).toEqual({ "X-Custom": "value", "X-Priority": "1" });
  });

  it("replaces existing content on re-store", () => {
    storeEmailContent(emailId, { text: "first" });
    storeEmailContent(emailId, { text: "second" });
    const content = getEmailContent(emailId);
    expect(content!.text_body).toBe("second");
  });
});

describe("getEmailContent", () => {
  it("returns null for unknown email id", () => {
    expect(getEmailContent("nonexistent")).toBeNull();
  });

  it("returns stored content with email_id", () => {
    storeEmailContent(emailId, { text: "test" });
    const content = getEmailContent(emailId);
    expect(content!.email_id).toBe(emailId);
  });

  it("tolerates malformed header JSON", () => {
    storeEmailContent(emailId, { text: "test", headers: { "X-Test": "1" } });
    getDatabase().run("UPDATE email_content SET headers_json = ? WHERE email_id = ?", ["not-json", emailId]);

    const content = getEmailContent(emailId);
    expect(content?.headers).toEqual({});
  });
});
