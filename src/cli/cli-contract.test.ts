import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function isolatedEnv(dbPath: string, homePath: string): NodeJS.ProcessEnv {
  mkdirSync(homePath, { recursive: true });
  return {
    ...process.env,
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

  it("reports remote storage status with canonical env names", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["storage", "status", "--json"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(stdout) as {
      configured: boolean;
      mode: string;
      env: string[];
      canonical: {
        cluster: string;
        database: string;
        runtimePath: string;
        env: string;
        fallbackEnv: string;
      };
      service: string;
      tables: string[];
    };
    expect(parsed.configured).toBe(false);
    expect(parsed.mode).toBe("local");
    expect(parsed.env).toEqual(["HASNA_EMAILS_DATABASE_URL", "EMAILS_DATABASE_URL"]);
    expect(parsed.canonical).toEqual({
      cluster: "hasna-xyz-infra-apps-prod-postgres",
      database: "emails",
      runtimePath: "hasna/xyz/opensource/emails/prod/rds",
      env: "HASNA_EMAILS_DATABASE_URL",
      fallbackEnv: "EMAILS_DATABASE_URL",
    });
    expect(parsed.service).toBe("emails");
    expect(parsed.tables).toContain("providers");
  });

  it("prints canonical RDS setup instructions without a secret value", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["storage", "setup"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("hasna-xyz-infra-apps-prod-postgres/emails");
    expect(stdout).toContain("hasna/xyz/opensource/emails/prod/rds");
    expect(stdout).toContain("HASNA_EMAILS_DATABASE_URL");
    expect(stdout).not.toContain("postgres://");
  });

  it("documents storage command without legacy cloud wording", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-cli-contract-"));
    tempDirs.push(dir);
    const env = isolatedEnv(join(dir, "emails.db"), join(dir, "home"));

    const result = runCli(["storage", "--help"], env);
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("remote PostgreSQL storage");
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
    expect(parsed.error.fix_commands).toContain("emails provider list --json");
  });
});
