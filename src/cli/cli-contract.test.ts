import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { createDomain, updateDnsStatus, updateDomainReadiness } from "../db/domains.js";
import { storeEmailContent } from "../db/email-content.js";
import { createEmail } from "../db/emails.js";
import { storeInboundEmail } from "../db/inbound.js";
import { createProvider } from "../db/providers.js";
import { setDomainProvisioning } from "../db/provisioning.js";
import { storeSandboxEmail } from "../db/sandbox.js";
import { registerS3Source } from "../lib/s3-sync.js";
import { redactSecrets } from "../lib/redaction.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function isolatedEnv(dbPath: string, homePath: string): NodeJS.ProcessEnv {
  mkdirSync(homePath, { recursive: true });
  const baseEnv = { ...process.env };
  for (const key of [
    "HASNA_EMAILS_DATABASE_URL", "EMAILS_DATABASE_URL", "EMAILS_STORAGE_MODE",
    "HASNA_EMAILS_MODE", "MAILERY_MODE", "HASNA_MAILERY_MODE",
    "MAILERY_STORAGE_MODE", "HASNA_MAILERY_STORAGE_MODE", "MAILERY_API_URL",
    "MAILERY_API_KEY", "HASNA_MAILERY_API_URL", "HASNA_MAILERY_API_KEY",
    "EMAILS_SELF_HOSTED_URL", "EMAILS_SELF_HOSTED_API_KEY",
  ]) delete baseEnv[key];
  return {
    ...baseEnv,
    EMAILS_MODE: "local",
    EMAILS_DB_PATH: dbPath,
    HOME: homePath,
    NO_COLOR: "1",
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return Bun.spawnSync({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdoutText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

function stderrText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stderr);
}

function expectCliJsonOk<T>(result: ReturnType<typeof runCli>): T {
  const stdout = stdoutText(result);
  const stderr = stderrText(result);
  expect(result.exitCode, stderr).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as T;
}

function withSeededCliDb<T>(env: NodeJS.ProcessEnv, seed: () => T): T {
  const previousDb = process.env["EMAILS_DB_PATH"];
  const previousHome = process.env["HOME"];
  closeDatabase();
  process.env["EMAILS_DB_PATH"] = String(env.EMAILS_DB_PATH);
  process.env["HOME"] = String(env.HOME);
  resetDatabase();
  try {
    return seed();
  } finally {
    closeDatabase();
    if (previousDb === undefined) delete process.env["EMAILS_DB_PATH"];
    else process.env["EMAILS_DB_PATH"] = previousDb;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
  }
}

describe("CLI JSON contracts", () => {
  it("prints valid credential-free JSON for provider list", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const homePath = join(dir, "home");
    const env = isolatedEnv(dbPath, homePath);

    const add = runCli([
      "provider", "add",
      "--name", "secret-ses",
      "--type", "ses",
      "--region", "us-east-1",
      "--access-key", "AKIA_CLI_SHOULD_NOT_LEAK",
      "--secret-key", "CLI_SECRET_SHOULD_NOT_LEAK",
      "--skip-validation",
    ], env);
    expect(add.exitCode).toBe(0);

    const list = runCli(["--json", "provider", "list"], env);
    const stdout = new TextDecoder().decode(list.stdout);
    const stderr = new TextDecoder().decode(list.stderr);
    expect(list.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain("AKIA_CLI_SHOULD_NOT_LEAK");
    expect(stdout).not.toContain("CLI_SECRET_SHOULD_NOT_LEAK");
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "secret-ses",
    });
    expect(parsed[0]).not.toHaveProperty("access_key");
    expect(parsed[0]).not.toHaveProperty("secret_key");
    expect(parsed[0]).not.toHaveProperty("oauth_refresh_token");
    const providerId = String(parsed[0]!.id);

    const update = runCli(["provider", "update", providerId, "--name", "renamed-ses", "--skip-validation"], env);
    expect(update.exitCode).toBe(0);
    const updated = runCli(["--json", "provider", "list"], env);
    expect(updated.exitCode).toBe(0);
    const updatedProviders = JSON.parse(new TextDecoder().decode(updated.stdout)) as Array<Record<string, unknown>>;
    expect(updatedProviders[0]).toMatchObject({ id: providerId, name: "renamed-ses" });

    const remove = runCli(["provider", "remove", providerId, "--yes"], env);
    expect(remove.exitCode).toBe(0);
    const empty = runCli(["--json", "provider", "list"], env);
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(empty.stdout))).toEqual([]);

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(join(homePath, ".emails", "emails.db"))).toBe(false);
  }, 15_000);

  it("prints machine-readable MCP Claude install dry-run output", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "mcp", "--claude", "--dry-run"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      target: "claude",
      action: "install",
      command: "claude",
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "emails", "--", "emails-mcp"],
      shell: "claude mcp add --transport stdio --scope user emails -- emails-mcp",
    });
  });

  it("wraps direct human logs in stable JSON when --json is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "provider", "add", "--name", "dev", "--type", "sandbox"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as { output: string[]; errors: string[] };
    expect(parsed.output.join("\n")).toContain("Sandbox provider created: dev");
    expect(parsed.output.join("\n")).not.toContain("undefined");
    expect(parsed.errors).toEqual([]);
  });

  it("never leaks a postgres connection string through the CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-redaction-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const connectionString = "postgres://emails_user:sup3r-s3cret@db.internal:5432/emails";

    // redaction.ts is the last line of defense: a connection string stored under
    // a sensitive key must be replaced with the redaction sentinel.
    expect(redactSecrets({ resend_api_key: connectionString })).toEqual({ resend_api_key: "***" });

    const set = runCli(["config", "set", "resend_api_key", connectionString], env);
    expect(set.exitCode).toBe(0);
    expect(stdoutText(set)).toContain("***");
    expect(stdoutText(set)).not.toContain(connectionString);
    expect(stdoutText(set)).not.toContain("sup3r-s3cret");

    const get = runCli(["config", "get", "resend_api_key"], env);
    expect(get.exitCode).toBe(0);
    const getOut = stdoutText(get);
    expect(getOut).toContain("***");
    expect(getOut).not.toContain(connectionString);
    expect(getOut).not.toContain("sup3r-s3cret");

    const list = runCli(["--json", "config", "list"], env);
    expect(list.exitCode).toBe(0);
    const listOut = stdoutText(list);
    expect(listOut).not.toContain(connectionString);
    expect(listOut).not.toContain("sup3r-s3cret");
    expect(listOut).not.toContain("postgres://");
  });

  it("prints structured JSON errors with fix commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "provider", "remove", "missing", "--yes"], env);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(1);

    const parsed = JSON.parse(stderr) as { error: { message: string; code: string; fix_commands: string[] } };
    expect(parsed.error.code).toBe("not_found");
    expect(parsed.error.message).toContain("Provider not found or ambiguous");
    expect(parsed.error.fix_commands).toContain("emails provider list --json");
  });

  it("keeps natural-language root prompts as command errors instead of routing to AI", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "extract", "links", "from", "latest", "email"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderr) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
    expect(parsed.error.message).not.toContain("API_KEY");
  });

  it("does not expose the removed ask command", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "ask", "latest"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderr) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
  });

  it("does not advertise cloud AI provider config keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["config", "keys", "--verbose"], env);
    const stdout = stdoutText(result);

    expect(result.exitCode).toBe(0);
    expect(stdout).not.toContain("ai_provider");
    expect(stdout).not.toContain("api_key for `emails agent`");
    expect(stdout).not.toContain("brave_search_api_key");
  });

  it("keeps one-word unknown commands as command errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const result = runCli(["definitely-not-a-command"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command");
    expect(stderr).not.toContain("API_KEY");
  });

  it("rejects the removed cloud command with a JSON unknown-command error", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "cloud"], env);
    expect(result.exitCode).toBe(1);
    expect(stdoutText(result)).toBe("");
    const parsed = JSON.parse(stderrText(result)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
  });

  it("prints local agent context as stable redacted JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "agent", "context"], env);
    const parsed = expectCliJsonOk<{
      status: { mode: { current: string } };
    }>(result);

    expect(parsed.status.mode.current).toBe("local");
  });

  it("prints valid JSON for inbox list, read, links, and attachments", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const seeded = withSeededCliDb(env, () => {
      const provider = createProvider({ name: "ses", type: "ses" });
      const email = storeInboundEmail({
        provider_id: provider.id,
        message_id: "<cli-json-inbox@example.com>",
        in_reply_to_email_id: null,
        from_address: "sender@example.com",
        to_addresses: ["ops@example.com"],
        cc_addresses: [],
        subject: "CLI JSON contract",
        text_body: "# Contract\n\nOpen https://example.com/read and mailto:ops@example.com",
        html_body: null,
        attachments: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 2048 }],
        attachment_paths: [{ filename: "invoice.pdf", content_type: "application/pdf", size: 2048, local_path: "/tmp/contract-invoice.pdf" }],
        headers: {},
        raw_size: 123,
        received_at: "2026-06-18T08:00:00.000Z",
      });
      return { emailId: email.id };
    });

    const list = expectCliJsonOk<Array<{ id: string; subject: string }>>(runCli(["--json", "inbox", "list", "--search", "contract", "--limit", "1"], env));
    expect(list).toEqual([expect.objectContaining({ id: seeded.emailId, subject: "CLI JSON contract" })]);

    const read = expectCliJsonOk<{ id: string; subject: string; text_body: string }>(runCli(["--json", "inbox", "read", seeded.emailId, "--keep-unread"], env));
    expect(read).toMatchObject({ id: seeded.emailId, subject: "CLI JSON contract" });
    expect(read.text_body).toContain("https://example.com/read");

    const links = expectCliJsonOk<{ links: Array<{ url: string }> }>(runCli(["--json", "links", seeded.emailId, "--all"], env));
    expect(links.links.map((link) => link.url)).toEqual(["https://example.com/read", "mailto:ops@example.com"]);

    const attachments = expectCliJsonOk<Array<{ filename: string; file_url?: string; location_type?: string }>>(runCli(["--json", "inbox", "attachment", seeded.emailId, "--filename", "invoice.pdf"], env));
    expect(attachments).toEqual([
      expect.objectContaining({
        filename: "invoice.pdf",
        file_url: "file:///tmp/contract-invoice.pdf",
        location_type: "local",
      }),
    ]);
  });

  it("keeps a fresh local-only install working without self-hosted env vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-local-only-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const seeded = withSeededCliDb(env, () => {
      const provider = createProvider({ name: "local-sandbox", type: "sandbox" });
      const email = storeInboundEmail({
        provider_id: provider.id,
        message_id: "<local-only@example.com>",
        in_reply_to_email_id: null,
        from_address: "sender@example.com",
        to_addresses: ["agent@example.com"],
        cc_addresses: [],
        subject: "Local only contract",
        text_body: "Local mode stays offline. Open https://example.com/local",
        html_body: null,
        attachments: [],
        attachment_paths: [],
        headers: {},
        raw_size: 128,
        received_at: "2026-07-01T10:00:00.000Z",
      });
      return { providerId: provider.id, emailId: email.id };
    });

    const status = expectCliJsonOk<{
      mode: { current: string };
      inbox: { total: number; unread: number; latest_received_at: string | null };
    }>(runCli(["--json", "status"], env));
    expect(status.mode.current).toBe("local");
    expect(status.inbox).toMatchObject({
      total: 1,
      unread: 1,
      latest_received_at: "2026-07-01T10:00:00.000Z",
    });

    const list = expectCliJsonOk<Array<{ id: string; subject: string }>>(runCli(["--json", "inbox", "list", "--search", "local", "--limit", "1"], env));
    expect(list).toEqual([expect.objectContaining({ id: seeded.emailId, subject: "Local only contract" })]);

    // Search routes through the mail data source seam (subject/from/snippet scope in
    // both modes), so match on a subject term rather than a body-only word.
    const search = expectCliJsonOk<Array<{ id: string; subject: string }>>(runCli(["--json", "inbox", "search", "contract"], env));
    expect(search).toEqual([expect.objectContaining({ id: seeded.emailId, subject: "Local only contract" })]);

    const read = expectCliJsonOk<{ id: string; text_body: string }>(runCli(["--json", "inbox", "read", seeded.emailId, "--keep-unread"], env));
    expect(read.id).toBe(seeded.emailId);
    expect(read.text_body).toContain("Local mode stays offline");

    const links = expectCliJsonOk<{ links: Array<{ url: string }> }>(runCli(["--json", "links", seeded.emailId], env));
    expect(links.links.map((link) => link.url)).toEqual(["https://example.com/local"]);

    const send = runCli([
      "send",
      "--provider", seeded.providerId,
      "--from", "agent@example.com",
      "--to", "recipient@example.com",
      "--subject", "Local dry run",
      "--body", "No network send",
      "--dry-run",
    ], env);
    expect(send.exitCode).toBe(0);
    expect(stdoutText(send)).toContain("[NOT SENT]");
    expect(stderrText(send)).toBe("");
  }, 15_000);

  it("prints JSON domain lifecycle state for local cache-only and self-hosted source rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-domains-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const seeded = withSeededCliDb(env, () => {
      const localProvider = createProvider({ name: "local-sandbox", type: "sandbox" });
      const localDomain = createDomain(localProvider.id, "local-only.example.com");
      updateDomainReadiness(localDomain.id, {
        domain_type: "local_only",
        source_of_truth: "local",
      });

      const selfHostedProvider = createProvider({ name: "self-hosted-ses", type: "ses", region: "us-east-1" });
      const selfHostedDomain = createDomain(selfHostedProvider.id, "selfhosted.example.com");
      updateDnsStatus(selfHostedDomain.id, "verified", "verified", "verified");
      updateDomainReadiness(selfHostedDomain.id, {
        domain_type: "self_hosted",
        source_of_truth: "postgres",
        ownership_status: "verified",
        inbound_status: "ready",
        outbound_status: "ready",
      });
      setDomainProvisioning(selfHostedDomain.id, { provisioning_status: "ready", send_provider: "ses" });
      registerS3Source({
        bucket: "temp-self-hosted-inbound",
        prefix: "inbound/selfhosted.example.com/",
        region: "us-east-1",
        providerId: selfHostedProvider.id,
        status: "live",
        liveSyncEnabled: true,
      });
      return { localDomainId: localDomain.id, selfHostedDomainId: selfHostedDomain.id };
    });

    const localRows = expectCliJsonOk<Array<{
      id: string;
      domain: string;
      mode: string;
      domain_type: string;
      source_of_truth: string;
      readiness: { send_ready: boolean; receive_ready: boolean };
    }>>(runCli(["--json", "domains", "list", "--limit", "10"], env));
    const local = localRows.find((row) => row.id === seeded.localDomainId);
    expect(local).toMatchObject({
      domain: "local-only.example.com",
      mode: "local",
      domain_type: "local_only",
      source_of_truth: "local",
      readiness: { send_ready: false, receive_ready: false },
    });

    const selfHosted = expectCliJsonOk<{
      id: string;
      domain: string;
      mode: string;
      domain_type: string;
      source_of_truth: string;
      readiness: {
        send_ready: boolean;
        receive_ready: boolean;
        inbound_evidence_ready: boolean;
        inbound_evidence: { live_s3_sources: number };
      };
    }>(runCli(["--json", "domains", "status", "selfhosted.example.com"], env));

    expect(selfHosted).toMatchObject({
      id: seeded.selfHostedDomainId,
      domain: "selfhosted.example.com",
      mode: "local",
      domain_type: "self_hosted",
      source_of_truth: "postgres",
      readiness: {
        send_ready: true,
        receive_ready: true,
        inbound_evidence_ready: true,
        inbound_evidence: { live_s3_sources: 1 },
      },
    });
  }, 20_000);

  it("prints valid JSON for sent email show", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const seeded = withSeededCliDb(env, () => {
      const provider = createProvider({ name: "sandbox", type: "sandbox" });
      const email = createEmail(provider.id, {
        from: "sender@example.com",
        to: "ops@example.com",
        subject: "Show JSON contract",
        text: "plain fallback",
      }, "show-json-message");
      storeEmailContent(email.id, {
        html: '<p>Hello <strong>show</strong> &amp; JSON</p>',
      });
      return { emailId: email.id };
    });

    const shown = expectCliJsonOk<{ id: string; subject: string; provider_message_id: string }>(
      runCli(["--json", "email", "show", seeded.emailId], env),
    );

    expect(shown).toMatchObject({
      id: seeded.emailId,
      subject: "Show JSON contract",
      provider_message_id: "show-json-message",
    });
  });

  it("prints valid JSON for sandbox list and count", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    withSeededCliDb(env, () => {
      const provider = createProvider({ name: "sandbox", type: "sandbox" });
      storeSandboxEmail({
        provider_id: provider.id,
        from_address: "sender@example.com",
        to_addresses: ["ops@example.com"],
        cc_addresses: [],
        bcc_addresses: [],
        reply_to: null,
        subject: "Sandbox JSON",
        html: "<p>hidden</p>",
        text_body: null,
        attachments: [],
        headers: {},
      });
    });

    const rows = expectCliJsonOk<Array<Record<string, unknown>>>(runCli(["--json", "sandbox", "list", "--limit", "1"], env));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: "Sandbox JSON" });
    expect(rows[0]).not.toHaveProperty("html");
    expect(rows[0]).not.toHaveProperty("text_body");

    const count = expectCliJsonOk<{ count: number }>(runCli(["--json", "sandbox", "count"], env));
    expect(count).toEqual({ count: 1 });
  });

});
