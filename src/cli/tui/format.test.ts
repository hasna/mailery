import { describe, it, expect } from "bun:test";
import {
  truncate,
  pad,
  bareAddress,
  senderName,
  relativeTime,
  listDateTime,
  wrapText,
  htmlToReadableText,
  readableMessageText,
  renderReadableBodyLines,
  formatMessageForCopy,
  renderReadableEmailDocument,
} from "./format.js";

describe("format helpers", () => {
  it("truncates and pads", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
    expect(truncate("hi", 5)).toBe("hi");
    expect(pad("hi", 5)).toBe("hi   ");
  });

  it("extracts bare address and sender name", () => {
    expect(bareAddress("Morgan <a@x.com>")).toBe("a@x.com");
    expect(bareAddress("a@x.com")).toBe("a@x.com");
    expect(senderName('"Example User" <a@example.com>')).toBe("Example User");
    expect(senderName("Morgan <a@x.com>")).toBe("Morgan");
    expect(senderName("a@x.com")).toBe("a@x.com");
  });

  it("formats relative time", () => {
    const now = new Date("2026-06-03T12:00:00Z").getTime();
    expect(relativeTime("2026-06-03T11:59:30Z", now)).toBe("30s");
    expect(relativeTime("2026-06-03T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-06-03T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-06-01T12:00:00Z", now)).toBe("2d");
    expect(relativeTime("2026-05-01T12:00:00Z", now)).toBe("2026-05-01");
    expect(relativeTime(null, now)).toBe("—");
  });

  it("formats list dates with compact friendly labels", () => {
    const now = new Date(2026, 5, 3, 12, 0, 0).getTime();

    const today = listDateTime(new Date(2026, 5, 3, 13, 33, 0).toISOString(), now);
    const yesterday = listDateTime(new Date(2026, 5, 2, 9, 30, 0).toISOString(), now);
    const twoDays = listDateTime(new Date(2026, 5, 1, 9, 30, 0).toISOString(), now);
    const older = listDateTime(new Date(2026, 4, 1, 8, 5, 0).toISOString(), now);
    expect(today).toBe("13:33 PM");
    expect(yesterday).toBe("Yesterday");
    expect(twoDays).toBe("2 days ago");
    expect(older).toBe("May 1");
    expect([today, yesterday, twoDays, older].every((value) => value.length <= 10)).toBe(true);
    expect(older).not.toContain("2026-05-");
  });

  it("wraps text to width and max lines", () => {
    const lines = wrapText("the quick brown fox jumps over", 10, 5);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join(" ")).toContain("quick");
    expect(wrapText("a\n\nb", 10, 5)).toEqual(["a", "", "b"]);
    expect(wrapText("aaaa bbbb cccc dddd", 4, 2)).toHaveLength(2);
  });

  it("converts HTML messages to readable text", () => {
    const text = htmlToReadableText("<h1>Hi &amp; welcome</h1><p>Open <a href=\"https://example.com\">docs</a></p><ul><li>one</li><li>two</li></ul>");

    expect(text).toContain("Hi & welcome");
    expect(text).toContain("docs (https://example.com)");
    expect(text).toContain("- one");
    expect(text).not.toContain("<h1>");
  });

  it("renders markdown-ish bodies without raw formatting marks", () => {
    const text = readableMessageText("# Update\n\n- **hello**\n- [docs](https://example.com)\n\n> quoted", null);

    expect(text).toContain("Update");
    expect(text).toContain("- hello");
    expect(text).toContain("docs (https://example.com)");
    expect(text).toContain("| quoted");
    expect(text).not.toContain("**hello**");
  });

  it("renders HTML-looking text bodies instead of raw tags", () => {
    const text = readableMessageText("<!doctype html><html><head><style>.x{}</style></head><body><p>Hello <strong>there</strong></p></body></html>", null);

    expect(text).toContain("Hello there");
    expect(text).not.toContain("<!doctype");
    expect(text).not.toContain("<strong>");
  });

  it("wraps readable message text in an escaped local HTML document", () => {
    const doc = renderReadableEmailDocument({
      subject: "Hello <ops>",
      from: "sender@example.com",
      to: ["ops@example.com"],
      date: "2026-06-18T00:00:00.000Z",
      text: null,
      html: '<p>Open <a href="https://example.com">docs</a> &amp; confirm</p>',
    });

    expect(doc).toContain("Hello &lt;ops&gt;");
    expect(doc).toContain("docs (https://example.com) &amp; confirm");
    expect(doc).not.toContain("<ops>");
    expect(doc).not.toContain("<a href");
  });

  it("leaves invalid numeric HTML entities intact", () => {
    const text = htmlToReadableText("<p>Bad &#999999999999; entity</p>");

    expect(text).toContain("Bad &#999999999999; entity");
  });

  it("wraps readable body lines with display kinds", () => {
    const lines = renderReadableBodyLines("- one\n> quoted", null, 20, 10);

    expect(lines[0]).toEqual({ text: "- one", kind: "list" });
    expect(lines).toContainEqual({ text: "| quoted", kind: "quote" });
  });

  it("attaches clickable link spans to rendered body lines", () => {
    const lines = renderReadableBodyLines(
      "Open [docs](https://docs.example.com/start) and https://support.example.com/ticket",
      null,
      120,
      10,
    );
    const text = lines.map((entry) => entry.text).join("\n");
    const links = lines.flatMap((entry) => entry.links ?? []);

    expect(text).toContain("docs (https://docs.example.com/start)");
    expect(links.map((link) => link.url)).toEqual([
      "https://docs.example.com/start",
      "https://support.example.com/ticket",
    ]);
    expect(links.map((link) => text.slice(link.start, link.end))).toEqual([
      "https://docs.example.com/start",
      "https://support.example.com/ticket",
    ]);
  });

  it("formats a full message for clipboard copy", () => {
    const copied = formatMessageForCopy({
      subject: "Hello",
      from: "sender@example.com",
      to: "ops@example.com",
      cc: "",
      date: "2026-06-12T10:00:00.000Z",
      text: "**body**",
      html: null,
      flags: ["read"],
      attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 123 }],
    });

    expect(copied).toContain("Subject: Hello");
    expect(copied).toContain("Attachments: invoice.pdf");
    expect(copied).toContain("body");
    expect(copied).not.toContain("**body**");
  });
});
