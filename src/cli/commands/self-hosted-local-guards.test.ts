import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeSelfHostedEnv(home: string): NodeJS.ProcessEnv {
  const {
    EMAILS_DB_PATH: _db,
    HASNA_EMAILS_DB_PATH: _hdb,
    HASNA_EMAILS_MODE: _hm,
    MAILERY_MODE: _mm,
    HASNA_MAILERY_MODE: _hmm,
    MAILERY_STORAGE_MODE: _msm,
    HASNA_MAILERY_STORAGE_MODE: _hmsm,
    EMAILS_STORAGE_MODE: _esm,
    HASNA_EMAILS_STORAGE_MODE: _hesm,
    MAILERY_API_URL: _mau,
    MAILERY_API_KEY: _mak,
    MAILERY_CLOUD_API_URL: _mcau,
    MAILERY_CLOUD_TOKEN: _mct,
    HASNA_MAILERY_API_URL: _hmau,
    HASNA_MAILERY_API_KEY: _hmak,
    HASNA_MAILERY_ENV_FILE: _hmef,
    ...rest
  } = process.env;
  return {
    ...rest,
    HOME: home,
    NO_COLOR: "1",
    EMAILS_MODE: "self_hosted",
    EMAILS_SELF_HOSTED_URL: "https://emails.example.test",
    EMAILS_SELF_HOSTED_API_KEY: "test-api-key",
  };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "src/cli/index.tsx", ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    proc.kill();
  }, 2_500);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timeout);
  return { code: proc.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

function tempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "home");
}

function localDbPath(home: string): string {
  return join(home, ".hasna", "emails", "emails.db");
}

describe("self_hosted local listener and forwarding guards", () => {
  for (const { args, command, detail } of [
    { args: ["serve"], command: "emails serve", detail: "local HTTP/webhook/SMTP listeners" },
    { args: ["serve", "--all"], command: "emails serve", detail: "local HTTP/webhook/SMTP listeners" },
    { args: ["refresh"], command: "emails refresh", detail: "local S3 inbox sync" },
  ]) {
    it(`fails closed for ${args.join(" ")} before creating a local DB`, async () => {
      const home = tempHome("emails-self-hosted-guard-");
      const result = await runCli(args, makeSelfHostedEnv(home));

      expect(result.code).toBe(1);
      expect(result.err).toContain(command);
      expect(result.err).toContain(detail);
      expect(result.err).toContain("self_hosted");
      expect(existsSync(localDbPath(home))).toBe(false);
    });
  }

  for (const { args, command } of [
    { args: ["forwarding", "add", "user@example.com", "archive@example.net"], command: "emails forwarding add" },
    { args: ["forwarding", "list"], command: "emails forwarding list" },
    { args: ["forwarding", "enable", "abc123"], command: "emails forwarding enable" },
    { args: ["forwarding", "disable", "abc123"], command: "emails forwarding disable" },
    { args: ["forwarding", "remove", "abc123"], command: "emails forwarding remove" },
    { args: ["forwarding", "run"], command: "emails forwarding run" },
    { args: ["forwarding", "explain", "user@example.com"], command: "emails forwarding explain" },
  ]) {
    it(`fails closed for ${command} before reading local forwarding state`, async () => {
      const home = tempHome("emails-self-hosted-forwarding-");
      const result = await runCli(args, makeSelfHostedEnv(home));

      expect(result.code).toBe(1);
      expect(result.err).toContain(command);
      expect(result.err).toContain("local app-level forwarding rules");
      expect(result.err).toContain("API-backed self-hosted route");
      expect(existsSync(localDbPath(home))).toBe(false);
    });
  }
});
