import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../db/database.js";
import { getLatestEmailDigest } from "../db/email-digests.js";
import { storeInboundEmail } from "../db/inbound.js";
import { generateEmailDigest, loadEmailDigest, resolveEmailDigestWindow } from "./email-digest.js";

let previousHome: string | undefined;
let tempHome: string | undefined;

beforeEach(() => {
  previousHome = process.env["HOME"];
  tempHome = mkdtempSync(join(tmpdir(), "emails-digest-test-home-"));
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

  it("fresh generation remains deterministic and local", async () => {
    const email = seedInbound("Board meeting", "2026-06-18T10:00:00.000Z", ["important"]);

    const digest = await generateEmailDigest({
      period: "today",
      now: new Date("2026-06-18T12:00:00.000Z"),
      db: getDatabase(),
    });

    expect(digest.provider).toBe("local");
    expect(digest.model).toBe("local-emails-digest");
    expect(digest.summary).toContain("1 inbound message");
    expect(digest.important_email_ids).toEqual([email.id]);
  });
});
