import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildS3PullTargets } from "./autopull-targets.js";

const ENV_KEYS = [
  "HOME",
  "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_MODE",
  "HASNA_EMAILS_MODE",
  "EMAILS_SELF_HOSTED_URL",
  "EMAILS_SELF_HOSTED_API_KEY",
  "MAILERY_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "MAILERY_API_URL",
  "MAILERY_API_KEY",
  "MAILERY_CLOUD_API_URL",
  "MAILERY_CLOUD_TOKEN",
  "HASNA_MAILERY_API_URL",
  "HASNA_MAILERY_API_KEY",
  "HASNA_MAILERY_ENV_FILE",
] as const;

function localDbPath(home: string): string {
  return join(home, ".hasna", "emails", "emails.db");
}

describe("buildS3PullTargets", () => {
  it("pulls registered live S3 sources even without legacy inbound bucket config", () => {
    const targets = buildS3PullTargets({
      liveSources: [{
        id: "s3-registered-source",
        bucket: "registered-bucket",
        prefix: "inbound/example.com/",
        region: "us-east-1",
        provider_id: "provider-1",
      }],
      buckets: [],
    });

    expect(targets).toEqual([{
      sourceId: "s3-registered-source",
      bucket: "registered-bucket",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId: "provider-1",
    }]);
  });

  it("skips bucket-root scans when registered sources cover the same bucket", () => {
    const targets = buildS3PullTargets({
      liveSources: [{
        id: "s3-prefix-source",
        bucket: "shared-bucket",
        prefix: "inbound/example.com/",
        region: "us-east-1",
        provider_id: "provider-1",
      }],
      buckets: [{ bucket: "shared-bucket", region: "us-east-1", providerId: "provider-1" }],
    });

    expect(targets).toEqual([{
      sourceId: "s3-prefix-source",
      bucket: "shared-bucket",
      prefix: "inbound/example.com/",
      region: "us-east-1",
      providerId: "provider-1",
    }]);
  });

  it("still supports legacy inbound bucket config when no registered source exists", () => {
    const targets = buildS3PullTargets({
      liveSources: [],
      buckets: [{ bucket: "legacy-bucket", region: "us-east-1", providerId: "provider-1" }],
      inboundPrefix: "inbound/",
    });

    expect(targets).toEqual([{
      bucket: "legacy-bucket",
      prefix: "inbound/",
      region: "us-east-1",
      providerId: "provider-1",
    }]);
  });
});

describe("TUI autopull in self_hosted mode", () => {
  it("no-ops before local S3 sync, forwarding, or SQLite writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "emails-autopull-self-hosted-"));
    const home = join(root, "home");
    try {
      const script = `
        import { existsSync } from "node:fs";
        import { join } from "node:path";
        import { autoPull } from "./src/cli/tui/autopull.ts";
        const result = await autoPull({ s3: true, forwarding: true, limit: 2 });
        console.log(JSON.stringify({
          result,
          localDbExists: existsSync(join(process.env.HOME, ".hasna", "emails", "emails.db")),
        }));
      `;
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        EMAILS_MODE: "self_hosted",
        EMAILS_SELF_HOSTED_URL: "https://emails.example.test",
        EMAILS_SELF_HOSTED_API_KEY: "test-api-key",
        NO_COLOR: "1",
      };
      for (const key of ENV_KEYS) {
        if (!(key in env)) delete env[key];
      }
      const proc = Bun.spawn(["bun", "-e", script], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { result: unknown; localDbExists: boolean };
      expect(parsed.result).toEqual({
        pulled: 0,
        ok: true,
        reason: "self_hosted API-only mode: local S3 autopull and forwarding are disabled",
        configured: false,
      });
      expect(parsed.localDbExists).toBe(false);
      expect(existsSync(localDbPath(home))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
