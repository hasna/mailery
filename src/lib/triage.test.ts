import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDatabase, closeDatabase, resetDatabase } from "../db/database.js";
import { storeEmailContent } from "../db/email-content.js";
import { storeInboundEmail } from "../db/inbound.js";
import { getTriage } from "../db/triage.js";

// We mock fetch globally to intercept Cerebras API calls
let fetchCallCount = 0;
let fetchResponses: unknown[] = [];
let fetchRequestBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];

function pushResponse(data: unknown) {
  fetchResponses.push(data);
}

function makeCerebrasResponse(content: unknown) {
  return {
    id: "resp-1",
    object: "chat.completion",
    created: Date.now(),
    model: "llama-4-scout-17b-16e-instruct",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

const originalFetch = globalThis.fetch;

function seedSentEmail(db: ReturnType<typeof getDatabase>, id: string, subject = "Test") {
  db.run(
    `INSERT INTO providers (id, name, type, active, created_at, updated_at)
     VALUES ('prov1', 'test', 'sandbox', 1, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO NOTHING`,
  );
  db.run(
    `INSERT INTO emails (id, provider_id, from_address, to_addresses, subject, status, sent_at, created_at, updated_at)
     VALUES (?, 'prov1', 'sender@test.com', '["recipient@test.com"]', ?, 'sent', datetime('now'), datetime('now'), datetime('now'))`,
    [id, subject],
  );
  storeEmailContent(id, { html: "<p>Hello world</p>", text: "Hello world" }, db);
}

function seedInboundEmail(db: ReturnType<typeof getDatabase>, id: string, subject = "Inbound") {
  db.run(
    `INSERT INTO inbound_emails (id, from_address, to_addresses, subject, text_body, received_at, created_at)
     VALUES (?, 'customer@ext.com', '["me@test.com"]', ?, 'Please help with my order', datetime('now'), datetime('now'))`,
    [id, subject],
  );
}

function seedReply(db: ReturnType<typeof getDatabase>, sentId: string, index: number, body: string) {
  storeInboundEmail({
    provider_id: null,
    message_id: `reply-${index}`,
    in_reply_to_email_id: sentId,
    from_address: `sender-${index}@ext.com`,
    to_addresses: ["sender@test.com"],
    cc_addresses: [],
    subject: `Reply ${index}`,
    text_body: body,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    headers: {},
    raw_size: body.length,
    received_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }, db);
}

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  process.env["CEREBRAS_API_KEY"] = "test-key";
  resetDatabase();
  fetchCallCount = 0;
  fetchResponses = [];
  fetchRequestBodies = [];

  // @ts-expect-error mock fetch
  globalThis.fetch = async (url: string, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      fetchRequestBodies.push(JSON.parse(init.body) as { messages?: Array<{ role: string; content: string }> });
    }
    const idx = fetchCallCount++;
    const data = fetchResponses[idx];
    if (!data) throw new Error(`No mock response for fetch call #${idx} to ${url}`);
    return new Response(JSON.stringify(makeCerebrasResponse(data)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["CEREBRAS_API_KEY"];
  globalThis.fetch = originalFetch;
});

describe("classifyEmail", () => {
  it("classifies an email and returns label + confidence", async () => {
    const { classifyEmail } = await import("./triage.js");
    pushResponse({ label: "urgent", confidence: 0.88 });
    const result = await classifyEmail({
      from: "boss@company.com",
      to: ["me@company.com"],
      subject: "URGENT: Server down",
      body: "Production server is unresponsive",
    });
    expect(result.label).toBe("urgent");
    expect(result.confidence).toBe(0.88);
    expect(fetchCallCount).toBe(1);
  });
});

describe("scorePriority", () => {
  it("returns priority score and reason", async () => {
    const { scorePriority } = await import("./triage.js");
    pushResponse({ priority: 1, reason: "Production issue" });
    const result = await scorePriority({
      from: "ops@company.com",
      to: ["team@company.com"],
      subject: "Server outage",
      body: "All services down",
    });
    expect(result.priority).toBe(1);
    expect(result.reason).toBe("Production issue");
  });
});

describe("summarizeEmail", () => {
  it("returns a summary string", async () => {
    const { summarizeEmail } = await import("./triage.js");
    pushResponse({ summary: "Meeting rescheduled to Friday" });
    const result = await summarizeEmail({
      from: "admin@company.com",
      to: ["all@company.com"],
      subject: "Meeting update",
      body: "The weekly meeting has been moved to Friday at 3pm",
    });
    expect(result).toBe("Meeting rescheduled to Friday");
  });
});

describe("analyzeSentiment", () => {
  it("returns sentiment classification", async () => {
    const { analyzeSentiment } = await import("./triage.js");
    pushResponse({ sentiment: "positive" });
    const result = await analyzeSentiment({
      from: "client@co.com",
      to: ["me@co.com"],
      subject: "Great work!",
      body: "Thanks for the excellent delivery",
    });
    expect(result).toBe("positive");
  });
});

describe("generateDraftReply", () => {
  it("generates a draft reply", async () => {
    const { generateDraftReply } = await import("./triage.js");
    pushResponse({ draft: "Hi, thanks for the feedback!" });
    const result = await generateDraftReply({
      from: "client@co.com",
      to: ["me@co.com"],
      subject: "Feedback",
      body: "Here is my feedback on the project",
    });
    expect(result).toBe("Hi, thanks for the feedback!");
  });
});

describe("triageEmail", () => {
  it("triages a sent email end-to-end", async () => {
    const { triageEmail } = await import("./triage.js");
    const db = getDatabase();
    seedSentEmail(db, "te1", "Invoice attached");

    // 4 parallel calls + 1 draft (action-required triggers draft)
    pushResponse({ label: "action-required", confidence: 0.91 });
    pushResponse({ priority: 2, reason: "Invoice needs review" });
    pushResponse({ summary: "Invoice for Q1 services attached" });
    pushResponse({ sentiment: "neutral" });
    pushResponse({ draft: "Thank you, I will review the invoice." });

    const result = await triageEmail("te1", "sent");
    expect(result.label).toBe("action-required");
    expect(result.priority).toBe(2);
    expect(result.summary).toBe("Invoice for Q1 services attached");
    expect(result.sentiment).toBe("neutral");
    expect(result.draft_reply).toBe("Thank you, I will review the invoice.");
    expect(result.confidence).toBe(0.91);

    // Verify persisted
    const saved = getTriage("te1", "sent");
    expect(saved).not.toBeNull();
    expect(saved!.label).toBe("action-required");
  });

  it("triages an inbound email", async () => {
    const { triageEmail } = await import("./triage.js");
    const db = getDatabase();
    seedInboundEmail(db, "ti1", "Help with order");

    pushResponse({ label: "urgent", confidence: 0.85 });
    pushResponse({ priority: 1, reason: "Customer needs help" });
    pushResponse({ summary: "Customer requesting order assistance" });
    pushResponse({ sentiment: "negative" });
    pushResponse({ draft: "I'm sorry for the inconvenience..." });

    const result = await triageEmail("ti1", "inbound");
    expect(result.inbound_email_id).toBe("ti1");
    expect(result.label).toBe("urgent");
    expect(result.draft_reply).toBe("I'm sorry for the inconvenience...");
  });

  it("skips draft for non-actionable emails", async () => {
    const { triageEmail } = await import("./triage.js");
    const db = getDatabase();
    seedSentEmail(db, "te2", "Weekly newsletter");

    pushResponse({ label: "newsletter", confidence: 0.95 });
    pushResponse({ priority: 5, reason: "Newsletter" });
    pushResponse({ summary: "Weekly company newsletter" });
    pushResponse({ sentiment: "neutral" });

    const result = await triageEmail("te2", "sent");
    expect(result.label).toBe("newsletter");
    expect(result.draft_reply).toBeNull();
    expect(fetchCallCount).toBe(4); // No draft call
  });

  it("skips draft when skip_draft option is true", async () => {
    const { triageEmail } = await import("./triage.js");
    const db = getDatabase();
    seedSentEmail(db, "te3", "Action needed");

    pushResponse({ label: "action-required", confidence: 0.9 });
    pushResponse({ priority: 1, reason: "Action needed" });
    pushResponse({ summary: "Requires action" });
    pushResponse({ sentiment: "neutral" });

    const result = await triageEmail("te3", "sent", { skip_draft: true });
    expect(result.label).toBe("action-required");
    expect(result.draft_reply).toBeNull();
    expect(fetchCallCount).toBe(4);
  });

  it("throws for nonexistent email", async () => {
    const { triageEmail } = await import("./triage.js");
    expect(triageEmail("nonexistent", "sent")).rejects.toThrow("Email not found");
  });
});

describe("triageBatch", () => {
  it("triages multiple untriaged emails", async () => {
    const { triageBatch } = await import("./triage.js");
    const db = getDatabase();
    seedSentEmail(db, "b1", "Email 1");
    seedSentEmail(db, "b2", "Email 2");

    // 4 calls per email (newsletter = no draft) x 2
    for (let i = 0; i < 2; i++) {
      pushResponse({ label: "newsletter", confidence: 0.8 });
      pushResponse({ priority: 4, reason: "Low priority" });
      pushResponse({ summary: `Summary ${i}` });
      pushResponse({ sentiment: "neutral" });
    }

    const { triaged, errors } = await triageBatch("sent", 10);
    expect(triaged.length).toBe(2);
    expect(errors.length).toBe(0);
  });
});

describe("generateDraftForEmail", () => {
  it("generates a draft for an existing email", async () => {
    const { generateDraftForEmail } = await import("./triage.js");
    const db = getDatabase();
    seedSentEmail(db, "dr1", "Follow up needed");

    pushResponse({ draft: "Following up on our conversation..." });
    const draft = await generateDraftForEmail("dr1", "sent");
    expect(draft).toBe("Following up on our conversation...");
  });

  it("bounds prompt body and reply thread context for sent emails", async () => {
    const { generateDraftForEmail } = await import("./triage.js");
    const db = getDatabase();
    seedSentEmail(db, "dr-bounded", "Long thread");
    storeEmailContent("dr-bounded", {
      text: `body-start ${"a".repeat(9000)} body-after-limit`,
    }, db);
    for (let i = 0; i < 12; i++) {
      seedReply(db, "dr-bounded", i, `reply-${i} ${"r".repeat(1200)} tail-${i}`);
    }

    pushResponse({ draft: "Bounded draft" });
    const draft = await generateDraftForEmail("dr-bounded", "sent");
    expect(draft).toBe("Bounded draft");

    const userPrompt = fetchRequestBodies[0]?.messages?.find((message) => message.role === "user")?.content ?? "";
    expect(userPrompt).toContain("body-start");
    expect(userPrompt).not.toContain("body-after-limit");
    expect(userPrompt).toContain("[2 older replies omitted]");
    expect(userPrompt).not.toContain("reply-0");
    expect(userPrompt).toContain("reply-2");
    expect(userPrompt).toContain("reply-11");
    expect(userPrompt).not.toContain("tail-11");
    expect(userPrompt).toContain("[truncated ");
  });

  it("throws for nonexistent email", async () => {
    const { generateDraftForEmail } = await import("./triage.js");
    expect(generateDraftForEmail("nope", "sent")).rejects.toThrow("Email not found");
  });
});
