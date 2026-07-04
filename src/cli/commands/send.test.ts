/**
 * GAP-A: `mailery send` routes through the mail-data-source seam.
 *   • cloud mode  → server send API (POST /messages/send), never the local provider path
 *   • local mode  → unchanged local provider path (writes a local sent ledger row)
 *
 * Both surfaces are exercised end-to-end via a CLI subprocess so the real routing
 * (CLI → resolveMailDataSource → {Api,Sqlite}MailDataSource) is under test. Cloud mode
 * runs against an in-process fake Mailery Cloud API (Bun.serve) that records requests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../../db/database.js";
import { createProvider } from "../../db/providers.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  closeDatabase();
  for (const fn of cleanups.splice(0)) fn();
  delete process.env["EMAILS_DB_PATH"];
  delete process.env["MAILERY_MODE"];
  delete process.env["MAILERY_API_URL"];
  delete process.env["MAILERY_API_KEY"];
});

function baseLocalEnv(dbPath: string, homePath: string): NodeJS.ProcessEnv {
  mkdirSync(homePath, { recursive: true });
  const { MAILERY_MODE: _m, HASNA_EMAILS_MODE: _h, MAILERY_API_URL: _u, MAILERY_API_KEY: _k, ...rest } = process.env;
  return { ...rest, EMAILS_DB_PATH: dbPath, HOME: homePath, NO_COLOR: "1", MAILERY_MODE: "local", HASNA_EMAILS_MODE: "local" };
}

// Async spawn (never spawnSync): the in-process fake server must keep serving while the
// CLI subprocess runs, so the event loop cannot be blocked.
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({ cmd: ["bun", "src/cli/index.tsx", ...args], cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, out: out.trim(), err: err.trim() };
}

function seedSandboxProvider(dbPath: string, homePath: string): void {
  const prevDb = process.env["EMAILS_DB_PATH"];
  const prevHome = process.env["HOME"];
  closeDatabase();
  process.env["EMAILS_DB_PATH"] = dbPath;
  process.env["HOME"] = homePath;
  resetDatabase();
  try {
    createProvider({ name: "sandbox", type: "sandbox", active: true });
  } finally {
    closeDatabase();
    if (prevDb === undefined) delete process.env["EMAILS_DB_PATH"]; else process.env["EMAILS_DB_PATH"] = prevDb;
    if (prevHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = prevHome;
  }
}

function startFakeCloud() {
  const sent: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (path === "/api/v1/mailboxes" && req.method === "GET") return j({ data: [{ id: "mbx_1", email: "agent@acme.com" }] });
      if (path === "/api/v1/messages/send" && req.method === "POST") {
        return req.json().then((body) => {
          sent.push(body as Record<string, unknown>);
          return j({ id: "cloud_sent_1", provider_message_id: "prov-1", attachments: [] }, 202);
        });
      }
      return j({ data: [] });
    },
  });
  return { server, base: `http://127.0.0.1:${server.port}`, sent };
}

describe("mailery send — cloud mode routes through the server API", () => {
  it("POSTs to /messages/send with the resolved mailbox and never the local provider path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "send-cloud-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const homePath = join(dir, "home");
    mkdirSync(homePath, { recursive: true });

    const { server, base, sent } = startFakeCloud();
    cleanups.push(() => server.stop(true));

    const env: NodeJS.ProcessEnv = {
      ...baseLocalEnv(join(dir, "emails.db"), homePath),
      MAILERY_MODE: "cloud",
      MAILERY_API_URL: base,
      MAILERY_API_KEY: "test-token",
    };

    const res = await runCli(["send", "--from", "agent@acme.com", "--to", "dest@ext.com", "--subject", "Hi", "--body", "Body text"], env);

    expect(res.code).toBe(0);
    expect(res.out).toContain("Email sent");
    expect(res.out).toContain("prov-1");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ mailboxId: "mbx_1", to: ["dest@ext.com"], subject: "Hi", text: "Body text" });
  }, 30_000);
});

describe("mailery send — local mode is unchanged (local provider path)", () => {
  it("sends via the sandbox provider and writes a local sent ledger row (no cloud)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "send-local-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "emails.db");
    const homePath = join(dir, "home");
    const env = baseLocalEnv(dbPath, homePath);
    seedSandboxProvider(dbPath, homePath);

    const res = await runCli(["send", "--from", "me@example.com", "--to", "you@ext.com", "--subject", "Local Hi", "--body", "hello"], env);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Email sent");

    // The local ledger row proves the local provider path ran (cloud send writes none).
    const sentList = await runCli(["--json", "inbox", "list", "--folder", "sent"], env);
    expect(sentList.code).toBe(0);
    const rows = JSON.parse(sentList.out) as Array<{ subject: string }>;
    expect(rows.map((r) => r.subject)).toContain("Local Hi");
  }, 30_000);
});
