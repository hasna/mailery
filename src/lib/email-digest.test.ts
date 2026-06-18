import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { getLatestEmailDigest } from "../db/email-digests.js";
import { storeInboundEmail } from "../db/inbound.js";
import { generateEmailDigest, loadEmailDigest, resolveEmailDigestWindow } from "./email-digest.js";

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["GROQ_API_KEY"];
});

function seedInbound(subject: string, received_at: string, labels: string[] = []) {
  return storeInboundEmail({
    provider_id: null,
    message_id: `<${subject}@digest.test>`,
    in_reply_to_email_id: null,
    from_address: "Digest Sender <digest@example.com>",
    to_addresses: ["me@example.com"],
    cc_addresses: [],
    subject,
    text_body: `Body for ${subject}`,
    html_body: null,
    attachments: [],
    attachment_paths: [],
    label_ids: labels,
    headers: {},
    raw_size: 10,
    received_at,
  });
}

describe("email digest", () => {
  it("resolves local digest windows", () => {
    const at = new Date("2026-06-18T15:30:00.000Z");
    expect(resolveEmailDigestWindow("today", at)).toMatchObject({
      period: "today",
      until: "2026-06-18T15:30:00.000Z",
    });
    expect(resolveEmailDigestWindow("yesterday", at).period).toBe("yesterday");
    expect(resolveEmailDigestWindow("last7", at).period).toBe("last7");
    const month = resolveEmailDigestWindow("month", at);
    expect(month.period).toBe("month");
    expect(new Date(month.since).getTime()).toBeLessThan(new Date(month.until).getTime());
  });

  it("generates and loads a deterministic local digest", async () => {
    seedInbound("Important contract", "2026-06-18T10:00:00.000Z", ["important", "action-required"]);
    seedInbound("Newsletter", "2026-06-18T09:00:00.000Z", ["newsletter"]);

    const digest = await generateEmailDigest({
      period: "today",
      offline: true,
      now: new Date("2026-06-18T12:00:00.000Z"),
      db: getDatabase(),
    });

    expect(digest.provider).toBe("local");
    expect(digest.message_count).toBe(2);
    expect(digest.summary).toContain("2 inbound messages");
    expect(digest.important_email_ids).toHaveLength(1);
    expect(digest.label_counts.important).toBe(1);
    expect(getLatestEmailDigest("today", getDatabase())?.id).toBe(digest.id);

    const loaded = await loadEmailDigest({ period: "today", offline: true, db: getDatabase() });
    expect(loaded.id).toBe(digest.id);
  });

  it("generates a Groq-backed digest through injected AI SDK dependencies", async () => {
    const email = seedInbound("Board meeting", "2026-06-18T10:00:00.000Z", ["important"]);
    const generateText = mock(async (opts: Record<string, unknown>) => {
      expect(String(opts.system)).toContain("read-only email digest agent");
      expect(String(opts.prompt)).toContain("Board meeting");
      expect(opts.providerOptions).toMatchObject({ groq: { structuredOutputs: false } });
      return {
        output: {
          summary: "Board meeting mail needs attention.",
          highlights: ["Board meeting from Digest Sender"],
          action_items: ["Review the board meeting message."],
          important_email_ids: [email.id, "not-a-real-id"],
        },
      };
    });

    const digest = await generateEmailDigest({
      period: "today",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      now: new Date("2026-06-18T12:00:00.000Z"),
      db: getDatabase(),
    }, {
      model: { provider: "test" },
      generateText,
      Output: { object: ({ schema }: { schema: unknown }) => ({ schema }) },
    });

    expect(digest.provider).toBe("groq");
    expect(digest.summary).toBe("Board meeting mail needs attention.");
    expect(digest.important_email_ids).toEqual([email.id]);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
