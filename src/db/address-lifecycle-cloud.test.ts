// Integration test: with the client flipped to self_hosted, address id-resolution
// AND lifecycle writes (suspend/activate/quota) MUST route to the cloud HTTP API,
// never the local SQLite island. A stub of /v1/addresses runs in a SEPARATE
// process (the real client makes blocking `curl` calls, which would deadlock an
// in-process Bun.serve), so the test needs no external infra and runs in CI.
//
// Guards the split-brain bug the adversarial review found: on a flipped machine
// the local `addresses` table is empty, so any function that consults it silently
// operates on the wrong (empty) dataset. All assertions round-trip through the
// client, then confirm the local island stayed empty.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase, resolvePartialId, resolvePartialIdOrThrow } from "./database.js";
import { resetCloudConfigCache } from "./cloud-store.js";
import { getAddress, listAddresses } from "./addresses.js";
import { activateAddress, getAddressSendability, setAddressQuota, suspendAddress } from "./address-lifecycle.js";

const ID = "11111111-2222-4333-8444-555555555555";
const EMAIL = "ceo@example.com";

// Stub server run out-of-process. Seeds one active address and implements the
// slice of /v1/addresses the client uses: list, get-by-id, PATCH (status +
// daily_quota + display_name). Keeps its own in-memory state; each PATCH mutates
// it so subsequent GETs reflect the write.
const SERVER_SRC = `
const ID = ${JSON.stringify(ID)};
const store = new Map();
store.set(ID, {
  id: ID, email: ${JSON.stringify(EMAIL)}, domain: "example.com", display_name: "CEO",
  status: "active", verified: true, daily_quota: null,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
});
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\\/v1\\/addresses\\/([^/]+)$/);
    if (url.pathname === "/v1/addresses" && req.method === "GET") {
      return Response.json({ addresses: [...store.values()] });
    }
    if (m) {
      const rec = store.get(decodeURIComponent(m[1]));
      if (req.method === "GET") return rec ? Response.json({ address: rec }) : new Response(null, { status: 404 });
      if (req.method === "PATCH" || req.method === "PUT") {
        if (!rec) return new Response(null, { status: 404 });
        const body = await req.json();
        if (typeof body.status === "string") rec.status = body.status;
        if ("daily_quota" in body) rec.daily_quota = body.daily_quota;
        if (body.display_name === null || typeof body.display_name === "string") rec.display_name = body.display_name;
        rec.updated_at = new Date().toISOString();
        return Response.json({ address: rec });
      }
    }
    return new Response(null, { status: 404 });
  },
});
console.log("PORT=" + server.port);
`;

let proc: Subprocess;
let dir: string;
let baseUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailery-stub-"));
  const scriptPath = join(dir, "server.ts");
  writeFileSync(scriptPath, SERVER_SRC);
  proc = Bun.spawn(["bun", scriptPath], { stdout: "pipe", stderr: "inherit" });
  // Read the announced port from stdout.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;
  while (!buf.includes("PORT=") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  reader.releaseLock();
  const match = buf.match(/PORT=(\d+)/);
  if (!match) throw new Error(`stub server did not report a port: ${buf}`);
  baseUrl = `http://127.0.0.1:${match[1]}`;
});

afterAll(() => {
  proc.kill();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env["EMAILS_DB_PATH"] = ":memory:";
  resetDatabase();
  process.env.HASNA_MAILERY_STORAGE_MODE = "self_hosted";
  process.env.HASNA_MAILERY_API_URL = baseUrl;
  process.env.HASNA_MAILERY_API_KEY = "hasna_test_key";
  resetCloudConfigCache();
});

afterEach(() => {
  delete process.env.HASNA_MAILERY_STORAGE_MODE;
  delete process.env.HASNA_MAILERY_API_URL;
  delete process.env.HASNA_MAILERY_API_KEY;
  resetCloudConfigCache();
  closeDatabase();
  delete process.env["EMAILS_DB_PATH"];
});

function localAddressCount(): number {
  const row = getDatabase().query("SELECT COUNT(*) AS c FROM addresses").get() as { c: number };
  return row.c;
}

describe("address cloud routing (self_hosted) — no split-brain", () => {
  test("listAddresses reads the cloud dataset (local island empty)", () => {
    expect(localAddressCount()).toBe(0);
    expect(listAddresses().map((a) => a.id)).toContain(ID);
  });

  test("resolvePartialId resolves a short id against the cloud, not local sqlite", () => {
    expect(resolvePartialId(getDatabase(), "addresses", ID.slice(0, 8))).toBe(ID);
    expect(resolvePartialIdOrThrow(getDatabase(), "addresses", ID.slice(0, 8))).toBe(ID);
  });

  test("suspend writes to the cloud and getAddressSendability reflects it", () => {
    expect(suspendAddress(ID).status).toBe("suspended");
    expect(getAddress(ID)!.status).toBe("suspended");
    expect(getAddressSendability(EMAIL).sendable).toBe(false);
    expect(localAddressCount()).toBe(0);
  });

  test("activate writes to the cloud", () => {
    suspendAddress(ID);
    expect(activateAddress(ID).status).toBe("active");
    expect(getAddress(ID)!.status).toBe("active");
    expect(getAddressSendability(EMAIL).sendable).toBe(true);
    expect(localAddressCount()).toBe(0);
  });

  test("setAddressQuota persists to the cloud and clears with null", () => {
    expect(setAddressQuota(ID, 5).daily_quota).toBe(5);
    expect(getAddress(ID)!.daily_quota).toBe(5);
    expect(setAddressQuota(ID, null).daily_quota).toBeNull();
    expect(getAddress(ID)!.daily_quota).toBeNull();
    expect(localAddressCount()).toBe(0);
  });

  test("setAddressQuota rejects a negative quota", () => {
    expect(() => setAddressQuota(ID, -1)).toThrow(/quota/i);
  });
});
