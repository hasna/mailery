import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { storeEmailContent } from "../db/email-content.js";
import { createEmail } from "../db/emails.js";
import { storeInboundEmail } from "../db/inbound.js";
import { createProvider } from "../db/providers.js";
import { storeSandboxEmail } from "../db/sandbox.js";

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
  const {
    HASNA_EMAILS_DATABASE_URL: _canonicalDb,
    EMAILS_DATABASE_URL: _fallbackDb,
    HASNA_EMAILS_STORAGE_MODE: _canonicalMode,
    EMAILS_STORAGE_MODE: _fallbackMode,
    MAILERY_MODE: _maileryMode,
    HASNA_EMAILS_MODE: _hasnaEmailsMode,
    ...baseEnv
  } = process.env;
  return {
    ...baseEnv,
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
  expect(result.exitCode).toBe(0);
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
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "mailery", "--", "mailery-mcp"],
      shell: "claude mcp add --transport stdio --scope user mailery -- mailery-mcp",
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

  it("reports self-hosted storage status with canonical env names", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["storage", "status", "--json"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as {
      configured: boolean;
      mode: string;
      sourceOfTruth: string;
      localCache: string;
      maileryMode: string;
      maileryModeLabel: string;
      env: string[];
      canonical: {
        cluster: string | null;
        database: string | null;
        runtimePath: string | null;
        env: string;
        fallbackEnv: string;
      };
      service: string;
      tables: string[];
    };
    expect(parsed.configured).toBe(false);
    expect(parsed.mode).toBe("local");
    expect(parsed.sourceOfTruth).toBe("local");
    expect(parsed.localCache).toBe("source");
    expect(parsed.maileryMode).toBe("local");
    expect(parsed.maileryModeLabel).toBe("Local");
    expect(parsed.env).toEqual(["HASNA_EMAILS_DATABASE_URL", "EMAILS_DATABASE_URL"]);
    expect(parsed.canonical).toEqual({
      cluster: null,
      database: null,
      runtimePath: null,
      env: "HASNA_EMAILS_DATABASE_URL",
      fallbackEnv: "EMAILS_DATABASE_URL",
    });
    expect(parsed.service).toBe("emails");
    expect(parsed.tables).toContain("providers");
  });

  it("prints generic self-hosted setup instructions without a secret value", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["storage", "setup"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Self-hosted Mailery uses your PostgreSQL connection string");
    expect(stdout).toContain("HASNA_EMAILS_DATABASE_URL");
    expect(stdout).toContain("MAILERY_MODE=self_hosted");
    expect(stdout).toContain("HASNA_EMAILS_STORAGE_MODE=remote");
    expect(stdout).toContain("HASNA_EMAILS_STORAGE_MODE=hybrid");
    expect(stdout).not.toContain("postgres://");
  });

  it("exposes self-hosted setup and status commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const env = isolatedEnv(dbPath, join(dir, "home"));

    const status = runCli(["self-hosted", "status", "--json"], env);
    expect(status.exitCode).toBe(0);
    const parsed = JSON.parse(stdoutText(status)) as {
      enabled: boolean;
      sourceOfTruth: string;
      localCache: string;
      storage: { configured: boolean; mode: string };
    };
    expect(parsed.enabled).toBe(false);
    expect(parsed.sourceOfTruth).toBe("local");
    expect(parsed.localCache).toBe("local_store");
    expect(parsed.storage).toMatchObject({ configured: false, mode: "local" });
    expect(existsSync(dbPath)).toBe(false);

    const setup = runCli(["self-hosted", "setup"], env);
    expect(setup.exitCode).toBe(0);
    expect(stdoutText(setup)).toContain("mailery self-hosted status");
    expect(stdoutText(setup)).not.toContain("postgres://");
    expect(existsSync(dbPath)).toBe(false);

    const setupJson = expectCliJsonOk<{ commands: string[]; database: { env: string; configured: boolean } }>(
      runCli(["self-hosted", "setup", "--json"], env),
    );
    expect(setupJson.database).toMatchObject({ env: "HASNA_EMAILS_DATABASE_URL", configured: false });
    expect(setupJson.commands).toContain("mailery self-hosted check --json");
    expect(JSON.stringify(setupJson)).not.toContain("postgres://");

    const migrateDryRun = expectCliJsonOk<{ status: string; statements: number }>(
      runCli(["self-hosted", "migrate", "--dry-run", "--json"], env),
    );
    expect(migrateDryRun.status).toBe("dry-run");
    expect(migrateDryRun.statements).toBeGreaterThan(0);
  });

  it("reports coherent misconfigured self-hosted status without creating a local DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const env = {
      ...isolatedEnv(dbPath, join(dir, "home")),
      MAILERY_MODE: "self_hosted",
    };

    const parsed = expectCliJsonOk<{
      enabled: boolean;
      configured: boolean;
      sourceOfTruth: string;
      localCache: string;
      storage: { configured: boolean; mode: string; sourceOfTruth: string; localCache: string };
    }>(runCli(["self-hosted", "status", "--json"], env));
    expect(parsed).toMatchObject({
      enabled: true,
      configured: false,
      sourceOfTruth: "postgres",
      localCache: "runtime_cache",
      storage: {
        configured: false,
        mode: "remote",
        sourceOfTruth: "postgres",
        localCache: "runtime-cache",
      },
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("reports self-hosted readiness blockers without printing secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "emails.db");
    const env = isolatedEnv(dbPath, join(dir, "home"));

    const result = runCli(["self-hosted", "check", "--json"], env);
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toBe("");
    const parsed = JSON.parse(stdoutText(result)) as {
      summary: { ready: boolean; blockers: string[] };
      checks: Array<{ name: string; ok: boolean; status: string; fix_commands?: string[] }>;
      runtime: { enabled: boolean; sourceOfTruth: string };
      remote: { activeSesProviders: Array<{ name: string; region: string | null }> };
    };
    expect(parsed.summary.ready).toBe(false);
    expect(parsed.summary.blockers).toContain("runtime_mode");
    expect(parsed.summary.blockers).toContain("database_url");
    expect(parsed.summary.blockers).toContain("database_access");
    expect(parsed.checks.find((entry) => entry.name === "database_url")?.fix_commands).toContain(
      "export HASNA_EMAILS_DATABASE_URL='<postgresql-connection-url>'",
    );
    expect(parsed.runtime).toMatchObject({ enabled: false, sourceOfTruth: "local" });
    expect(parsed.remote.activeSesProviders).toEqual([]);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("secret");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses empty local-to-self-hosted migrations before creating a local DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "missing.db");
    const env = {
      ...isolatedEnv(dbPath, join(dir, "home")),
      HASNA_EMAILS_DATABASE_URL: "postgres://self-hosted-target",
    };

    const result = runCli(["--json", "self-hosted", "migrate-local"], env);
    expect(result.exitCode).toBe(1);
    expect(stdoutText(result)).toBe("");
    const parsed = JSON.parse(stderrText(result)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("missing_required_input");
    expect(parsed.error.message).toContain("found no local mail rows");
    expect(parsed.error.message).not.toContain("postgres://self-hosted-target");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("requires a database URL for self-hosted source-of-truth runtime commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = {
      ...isolatedEnv(join(dir, "emails.db"), join(dir, "home")),
      HASNA_EMAILS_STORAGE_MODE: "remote",
    };

    const result = runCli(["--json", "inbox", "list"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(stdout).toBe("");
    const parsed = JSON.parse(stderr) as { error: { message: string; code: string; fix_commands: string[] } };
    expect(parsed.error.code).toBe("self_hosted_runtime_not_configured");
    expect(parsed.error.message).toContain("Self-hosted source-of-truth mode requires");
    expect(parsed.error.fix_commands).toContain("mailery self-hosted setup");

    const storage = runCli(["--json", "storage", "status"], env);
    expect(storage.exitCode).toBe(0);

    const feedback = runCli(["--json", "storage", "feedback", "hello"], env);
    expect(feedback.exitCode).toBe(1);
    expect(stdoutText(feedback)).toBe("");
    const feedbackParsed = JSON.parse(stderrText(feedback)) as { error: { code: string } };
    expect(feedbackParsed.error.code).toBe("self_hosted_runtime_not_configured");

    const mcpDryRun = runCli(["--json", "mcp", "--claude", "--dry-run"], env);
    expect(mcpDryRun.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(mcpDryRun))).toMatchObject({ target: "claude", action: "install" });
  });

  it("requires --force for pull-then-push storage sync", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "storage", "sync"], env);
    expect(result.exitCode).toBe(1);
    expect(stdoutText(result)).toBe("");
    const parsed = JSON.parse(stderrText(result)) as { error: { message: string } };
    expect(parsed.error.message).toContain("can overwrite local rows");
  });

  it("documents storage command without legacy cloud wording", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["storage", "--help"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("self-hosted PostgreSQL storage");
    expect(stdout).not.toContain("cloud");
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
    expect(parsed.error.message).toContain("Could not resolve ID");
    expect(parsed.error.fix_commands).toContain("mailery provider list --json");
  });

  it("routes natural-language root prompts to the read-only agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    delete env.CEREBRAS_API_KEY;

    const result = runCli(["--json", "extract", "links", "from", "latest", "email"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderr) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("auth_error");
    expect(parsed.error.message).toContain("CEREBRAS_API_KEY");
  });

  it("routes natural-language links prompts to the read-only agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    delete env.CEREBRAS_API_KEY;

    const result = runCli(["--json", "links", "from", "latest", "email"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderr) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("auth_error");
    expect(parsed.error.message).toContain("CEREBRAS_API_KEY");
  });

  it("honors saved Groq provider config for agent prompts", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    delete env.CEREBRAS_API_KEY;
    delete env.GROQ_API_KEY;

    const config = runCli(["config", "set", "ai_provider", "groq"], env);
    expect(config.exitCode).toBe(0);

    const result = runCli(["--json", "agent", "extract", "links"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderr) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("auth_error");
    expect(parsed.error.message).toContain("GROQ_API_KEY");
    expect(parsed.error.message).not.toContain("CEREBRAS_API_KEY");
  });

  it("keeps one-word unknown commands as command errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    delete env.CEREBRAS_API_KEY;

    const result = runCli(["definitely-not-a-command"], env);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command");
    expect(stderr).not.toContain("CEREBRAS_API_KEY");
  });

  it("prints JSON errors for unknown subcommands when JSON mode is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["--json", "self-hosted", "definitely-missing"], env);
    expect(result.exitCode).toBe(1);
    expect(stdoutText(result)).toBe("");
    const parsed = JSON.parse(stderrText(result)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
  });

  it("prints managed email agent defaults as stable redacted JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    env.GROQ_API_KEY = "gsk_cli_contract_secret";

    const result = runCli(["--json", "agent", "defaults"], env);
    const stdout = stdoutText(result);
    const parsed = expectCliJsonOk<{
      defaultProvider: string;
      defaultGroqModel: string;
      credentials: string;
    }>(result);

    expect(parsed.defaultProvider).toBe("groq");
    expect(parsed.defaultGroqModel).toBe("llama-3.3-70b-versatile");
    expect(parsed.credentials).toBe("***");
    expect(stdout).not.toContain("gsk_cli_contract_secret");
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

    const storage = expectCliJsonOk<{
      mode: string;
      sourceOfTruth: string;
      localCache: string;
      configured: boolean;
    }>(runCli(["--json", "storage", "status"], env));
    expect(storage).toMatchObject({
      mode: "local",
      sourceOfTruth: "local",
      localCache: "source",
      configured: false,
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

    const search = expectCliJsonOk<Array<{ id: string; subject: string }>>(runCli(["--json", "inbox", "search", "offline"], env));
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

  it("prints a project panel contract from local Mailery state", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));
    const seeded = withSeededCliDb(env, () => {
      const provider = createProvider({ name: "sandbox", type: "sandbox" });
      const inbound = storeInboundEmail({
        provider_id: provider.id,
        message_id: "project-panel-message",
        in_reply_to_email_id: null,
        from_address: "ionut@example.com",
        to_addresses: ["andrei@example.com"],
        cc_addresses: [],
        subject: "Project panel email",
        text_body: "Body should stay out of the panel.",
        html_body: null,
        attachments: [],
        attachment_paths: [],
        headers: {},
        raw_size: 64,
        received_at: "2026-06-29T00:00:00.000Z",
      });
      return { inboundId: inbound.id };
    });

    const panel = expectCliJsonOk<{
      schema: string;
      projectId: string;
      provider: { kind: string };
      metrics: Array<{ id: string; value: unknown }>;
      items: Array<{ id: string }>;
    }>(runCli(["project-panel", "--project", "Swiss Bank Account", "--json", "--contract"], env));

    expect(panel.schema).toBe("hasna.project_panel.v1");
    expect(panel.projectId).toBe("swiss-bank-account");
    expect(panel.provider.kind).toBe("mailery");
    expect(panel.metrics.find((metric) => metric.id === "inbox_unread")?.value).toBe(1);
    expect(panel.items.some((item) => item.id === seeded.inboundId)).toBe(true);
  });

});
