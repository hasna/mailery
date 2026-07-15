import { describe, expect, it } from "bun:test";
import { formatAttachmentSize, mergeAttachmentDetails } from "./attachment-actions.js";

describe("attachment action helpers", () => {
  it("formats stable human-readable sizes", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("merges metadata with local and S3 locations", () => {
    const attachments = mergeAttachmentDetails(
      [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 2048 },
        { filename: "remote.csv", content_type: "text/csv", size: 100 },
      ],
      [
        { filename: "invoice.pdf", local_path: "/tmp/invoice.pdf" },
        { filename: "remote.csv", s3_url: "s3://bucket/remote.csv" },
      ],
    );

    expect(attachments[0]).toMatchObject({
      filename: "invoice.pdf",
      location: "/tmp/invoice.pdf",
      location_type: "local",
      file_url: "file:///tmp/invoice.pdf",
      openable: true,
    });
    expect(attachments[1]).toMatchObject({
      filename: "remote.csv",
      location: "s3://bucket/remote.csv",
      location_type: "s3",
      openable: false,
    });
  });

  it("preserves duplicate filenames as distinct ordered attachments", () => {
    const attachments = mergeAttachmentDetails(
      [
        { filename: "invoice.pdf", content_type: "application/pdf", size: 10 },
        { filename: "invoice.pdf", content_type: "application/pdf", size: 20 },
      ],
      [
        { filename: "invoice.pdf", local_path: "/tmp/first.pdf" },
        { filename: "invoice.pdf", local_path: "/tmp/second.pdf" },
      ],
    );

    expect(attachments).toHaveLength(2);
    expect(attachments.map((item) => [item.size, item.location])).toEqual([
      [10, "/tmp/first.pdf"],
      [20, "/tmp/second.pdf"],
    ]);
  });

  it("rejects terminal and bidi controls before attachment metadata is displayed", () => {
    expect(() => mergeAttachmentDetails([
      { filename: "invoice\u001b[31m.pdf", content_type: "application/pdf", size: 10 },
    ])).toThrow(/unsafe/i);
    expect(() => mergeAttachmentDetails([], [
      { filename: "invoice\u202Efdp.exe", local_path: "/tmp/unsafe" },
    ])).toThrow(/unsafe/i);
  });
});
