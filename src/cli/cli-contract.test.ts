// Self-hosted-ONLY end-to-end CLI contracts. These spawn the REAL `emails` CLI
// (bun src/cli/index.tsx) as a subprocess pointed at an out-of-process /v1 stub
// (see src/test-support/v1-stub.ts) — the stub listens on TCP, so the spawned
// process reaches it over HTTP/curl exactly like a real self-hosted server.
// The deleted commands (config, sandbox, refresh) and the old local-SQLite mode
// are gone, so their contracts are gone; what remains is verified against /v1.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { redactSecrets } from "../lib/redaction.js";

let stub: V1Stub;
const tempDirs: string[] = [];

const LEGACY_ENV_KEYS = [
  "HASNA_EMAILS_DATABASE_URL", "EMAILS_DATABASE_URL", "EMAILS_STORAGE_MODE", "EMAILS_DB_PATH",
  "HASNA_EMAILS_DB_PATH", "HASNA_EMAILS_MODE", "EMAILS_CLIENT_ENV_SECRET",
  "MAILERY_MODE", "HASNA_MAILERY_MODE", "MAILERY_STORAGE_MODE", "HASNA_MAILERY_STORAGE_MODE",
  "MAILERY_API_URL", "MAILERY_API_KEY", "HASNA_MAILERY_API_URL", "HASNA_MAILERY_API_KEY",
] as const;

function cliEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
  tempDirs.push(dir);
  const homePath = join(dir, "home");
  mkdirSync(homePath, { recursive: true });
  const base = { ...process.env };
  for (const key of LEGACY_ENV_KEYS) delete base[key];
  return {
    ...base,
    EMAILS_MODE: "self_hosted",
    EMAILS_SELF_HOSTED_URL: stub.baseUrl,
    EMAILS_SELF_HOSTED_API_KEY: stub.apiKey,
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

beforeAll(async () => {
  stub = await startV1Stub();
});
afterAll(() => stub.stop());
beforeEach(async () => {
  await stub.reset();
});
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI JSON contracts (self-hosted /v1)", () => {
  it("prints valid credential-free JSON for provider CRUD routed to /v1", () => {
    const env = cliEnv();

    const add = runCli([
      "provider", "add",
      "--name", "secret-ses",
      "--type", "ses",
      "--region", "us-east-1",
      "--access-key", "AKIA_CLI_SHOULD_NOT_LEAK",
      "--secret-key", "CLI_SECRET_SHOULD_NOT_LEAK",
      "--skip-validation",
    ], env);
    expect(add.exitCode, stderrText(add)).toBe(0);

    const list = runCli(["--json", "provider", "list"], env);
    const stdout = stdoutText(list);
    expect(list.exitCode, stderrText(list)).toBe(0);
    expect(stderrText(list)).toBe("");
    expect(stdout).not.toContain("AKIA_CLI_SHOULD_NOT_LEAK");
    expect(stdout).not.toContain("CLI_SECRET_SHOULD_NOT_LEAK");
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: "secret-ses" });
    expect(parsed[0]).not.toHaveProperty("access_key");
    expect(parsed[0]).not.toHaveProperty("secret_key");
    expect(parsed[0]).not.toHaveProperty("oauth_refresh_token");
    const providerId = String(parsed[0]!.id);

    const update = runCli(["provider", "update", providerId, "--name", "renamed-ses", "--skip-validation"], env);
    expect(update.exitCode, stderrText(update)).toBe(0);
    const updated = JSON.parse(stdoutText(runCli(["--json", "provider", "list"], env))) as Array<Record<string, unknown>>;
    expect(updated[0]).toMatchObject({ id: providerId, name: "renamed-ses" });

    const remove = runCli(["provider", "remove", providerId, "--yes"], env);
    expect(remove.exitCode, stderrText(remove)).toBe(0);
    const empty = runCli(["--json", "provider", "list"], env);
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(empty))).toEqual([]);
  }, 20_000);

  it("prints machine-readable MCP Claude install dry-run output", () => {
    const result = runCli(["--json", "mcp", "--claude", "--dry-run"], cliEnv());
    expect(result.exitCode, stderrText(result)).toBe(0);
    const parsed = JSON.parse(stdoutText(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      target: "claude",
      action: "install",
      command: "claude",
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "emails", "--", "emails-mcp", "--stdio"],
      shell: "claude mcp add --transport stdio --scope user emails -- emails-mcp --stdio",
    });
  });

  it("wraps direct human logs in stable JSON when --json is enabled", () => {
    const result = runCli(["--json", "provider", "add", "--name", "dev", "--type", "sandbox"], cliEnv());
    expect(result.exitCode, stderrText(result)).toBe(0);
    const parsed = JSON.parse(stdoutText(result)) as { output: string[]; errors: string[] };
    expect(parsed.output.join("\n")).toContain("Sandbox provider created: dev");
    expect(parsed.output.join("\n")).not.toContain("undefined");
    expect(parsed.errors).toEqual([]);
  });

  it("prints structured JSON errors with fix commands", () => {
    const result = runCli(["--json", "provider", "remove", "missing", "--yes"], cliEnv());
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderrText(result)) as { error: { message: string; code: string; fix_commands: string[] } };
    expect(parsed.error.code).toBe("not_found");
    expect(parsed.error.message).toContain("Provider not found or ambiguous");
    expect(parsed.error.fix_commands).toContain("emails provider list --json");
  });

  it("keeps natural-language root prompts as command errors instead of routing to AI", () => {
    const result = runCli(["--json", "extract", "links", "from", "latest", "email"], cliEnv());
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderrText(result)) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
    expect(parsed.error.message).not.toContain("API_KEY");
  });

  it("does not expose the removed ask command", () => {
    const result = runCli(["--json", "ask", "latest"], cliEnv());
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(stderrText(result)) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
  });

  it("rejects the removed cloud command with a JSON unknown-command error", () => {
    const result = runCli(["--json", "cloud"], cliEnv());
    expect(result.exitCode).toBe(1);
    expect(stdoutText(result)).toBe("");
    const parsed = JSON.parse(stderrText(result)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toContain("unknown command");
  });

  it("keeps one-word unknown commands as command errors", () => {
    const result = runCli(["definitely-not-a-command"], cliEnv());
    expect(result.exitCode).not.toBe(0);
    const stderr = stderrText(result);
    expect(stderr).toContain("unknown command");
    expect(stderr).not.toContain("API_KEY");
  });

  it("prints self-hosted agent context as stable redacted JSON", () => {
    const parsed = expectCliJsonOk<{ status: { mode: { current: string } } }>(
      runCli(["--json", "agent", "context"], cliEnv()),
    );
    expect(parsed.status.mode.current).toBe("self_hosted");
  });

  it("prints valid JSON for inbox list, read, and links routed to /v1", async () => {
    await stub.seed({
      messages: [{
        id: "cli-json-inbox",
        direction: "inbound",
        message_id: "<cli-json-inbox@example.com>",
        from_addr: "sender@example.com",
        to_addrs: ["ops@example.com"],
        subject: "CLI JSON contract",
        body_text: "# Contract\n\nOpen https://example.com/read and mailto:ops@example.com",
        received_at: "2026-06-18T08:00:00.000Z",
        is_read: false,
        labels: [],
      }],
    });
    const env = cliEnv();

    const list = expectCliJsonOk<Array<{ id: string; subject: string }>>(
      runCli(["--json", "inbox", "list", "--search", "contract", "--limit", "1"], env),
    );
    expect(list).toEqual([expect.objectContaining({ id: "cli-json-inbox", subject: "CLI JSON contract" })]);

    const read = expectCliJsonOk<{ id: string; subject: string; text_body?: string }>(
      runCli(["--json", "inbox", "read", "cli-json-inbox", "--keep-unread"], env),
    );
    expect(read).toMatchObject({ id: "cli-json-inbox", subject: "CLI JSON contract" });

    const links = expectCliJsonOk<{ links: Array<{ url: string }> }>(
      runCli(["--json", "links", "cli-json-inbox", "--all"], env),
    );
    expect(links.links.map((link) => link.url)).toContain("https://example.com/read");
  }, 20_000);

  it("prints valid JSON for domains list routed to /v1", async () => {
    await stub.seed({
      domains: [
        { id: "dom-1", domain: "one.example.com", provider: "self_hosted", verified: true },
        { id: "dom-2", domain: "two.example.com", provider: "self_hosted", verified: false },
      ],
    });
    const rows = expectCliJsonOk<Array<{ domain: string }>>(
      runCli(["--json", "domains", "list", "--limit", "10"], cliEnv()),
    );
    expect(rows.map((row) => row.domain).sort()).toEqual(["one.example.com", "two.example.com"]);
  }, 20_000);

  it("redacts secrets stored under sensitive keys (last line of defense)", () => {
    // redaction.ts guards every JSON emit: a connection string under a sensitive
    // key must be replaced with the redaction sentinel.
    const connectionString = "postgres://emails_user:sup3r-s3cret@db.internal:5432/emails";
    expect(redactSecrets({ resend_api_key: connectionString })).toEqual({ resend_api_key: "***" });
  });
});
