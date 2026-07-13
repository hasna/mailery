// Self-hosted-ONLY: scoped send keys. The generic `send-keys` /v1 resource is
// summary-only — the secret `key_hash` is NEVER stored on or fetched by a client
// — but minting and token verification are bespoke server operations exposed at
// POST /v1/send-keys/mint and POST /v1/send-keys/verify. The client holds only the
// one-time token; the hash stays on the server. Exercises the REAL synchronous
// curl transport against an out-of-process /v1 stub (see src/test-support/v1-stub.ts),
// whose mint/verify handlers mirror the server contract.
//
// Migrated from the deleted local-SQLite pattern. SQL-projection / hash-absence-
// in-SQL assertions inspected local SQL that no longer exists; the /v1 summary
// rows simply carry no key_hash. List/get/revoke route to /v1 and are seeded with
// explicit created_at for deterministic ordering.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { startV1Stub, type V1Stub } from "../test-support/v1-stub.js";
import { createAddress } from "./addresses.js";
import { createOwner, assignAddressOwner } from "./owners.js";
import {
  createSendKey, verifySendKey, getSendKey, listSendKeys, listSendKeysByOwners,
  listSendKeySummaries, listSendKeySummariesByOwners, revokeSendKey,
  canOwnerSendFrom, assertSendAuthorized,
} from "./send-keys.js";

let stub: V1Stub;

beforeAll(async () => {
  stub = await startV1Stub();
});

afterAll(() => stub.stop());

beforeEach(async () => {
  await stub.reset();
  stub.applyEnv();
});

afterEach(() => {
  stub.clearEnv();
});

const PROVIDER_ID = "provider-ses";

/** A summary-shaped /v1 send-key row (no key_hash — the client never sees it). */
function keyRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: overrides["id"],
    owner_id: overrides["owner_id"],
    prefix: overrides["prefix"] ?? "esk_00000000",
    label: overrides["label"] ?? null,
    created_at: overrides["created_at"] ?? "2026-01-01T00:00:00.000Z",
    last_used_at: overrides["last_used_at"] ?? null,
    revoked_at: overrides["revoked_at"] ?? null,
  };
}

describe("send keys — /v1 mint + verify", () => {
  it("mints a key via /v1, returns the token once, and never exposes the hash", () => {
    const agent = createOwner({ type: "agent", name: "minter" });
    const { token, key } = createSendKey(agent.id, "ci");
    expect(token).toMatch(/^esk_/);
    expect(key.owner_id).toBe(agent.id);
    expect(key.label).toBe("ci");
    expect(key.key_hash).toBe(""); // never exposed to the client
    expect(key.prefix.length).toBeGreaterThan(0);
    // The minted key is listable via the summary-only /v1 resource.
    expect(listSendKeys(agent.id).map((k) => k.id)).toContain(key.id);
  });

  it("verifySendKey resolves a valid token and rejects unknown/revoked ones", () => {
    const agent = createOwner({ type: "agent", name: "verifier" });
    const { token, key } = createSendKey(agent.id);
    const resolved = verifySendKey(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(key.id);
    expect(resolved!.owner_id).toBe(agent.id);
    expect(resolved!.key_hash).toBe("");
    // Unknown token → null (not an error).
    expect(verifySendKey("esk_unknown")).toBeNull();
    // A revoked key stops verifying.
    revokeSendKey(key.id);
    expect(verifySendKey(token)).toBeNull();
  });

  it("assertSendAuthorized enforces the From scope and returns the owner", () => {
    const agent = createOwner({ type: "agent", name: "sender" });
    const mine = createAddress({ provider_id: PROVIDER_ID, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    createAddress({ provider_id: PROVIDER_ID, email: "other@x.com" });
    const { token } = createSendKey(agent.id);

    const owner = assertSendAuthorized(token, "ops@x.com");
    expect(owner.id).toBe(agent.id);
    expect(owner.name).toBe("sender");

    // Out-of-scope From is denied.
    expect(() => assertSendAuthorized(token, "other@x.com")).toThrow(/not authorized/i);
    // Invalid token is rejected.
    expect(() => assertSendAuthorized("esk_bogus", "ops@x.com")).toThrow(/invalid or revoked/i);
  });
});

describe("send keys — /v1 reads, revoke, and listing", () => {
  it("getSendKey returns a hash-free key by id, null for unknown", async () => {
    await stub.seed({
      "send-keys": [keyRow({ id: "k1", owner_id: "agent-1", prefix: "esk_abcdefgh", label: "ci" })],
    });
    const key = getSendKey("k1");
    expect(key).not.toBeNull();
    expect(key!.owner_id).toBe("agent-1");
    expect(key!.prefix).toBe("esk_abcdefgh");
    expect(key!.label).toBe("ci");
    expect(key!.key_hash).toBe(""); // never exposed to the client
    expect(getSendKey("missing")).toBeNull();
  });

  it("revokes a key once and reports the revoked timestamp", async () => {
    await stub.seed({
      "send-keys": [keyRow({ id: "k1", owner_id: "agent-1", label: "ci" })],
    });
    expect(revokeSendKey("k1")).toBe(true);
    // Idempotent: a second revoke of an already-revoked key is a no-op.
    expect(revokeSendKey("k1")).toBe(false);
    expect(listSendKeys("agent-1")[0]!.revoked_at).toBeTruthy();
  });

  it("revokeSendKey returns false for an unknown id", async () => {
    await stub.seed({ "send-keys": [] });
    expect(revokeSendKey("missing")).toBe(false);
  });

  it("lists keys for selected owners only", async () => {
    await stub.seed({
      "send-keys": [
        keyRow({ id: "kf", owner_id: "first", label: "first" }),
        keyRow({ id: "ks", owner_id: "second", label: "second" }),
        keyRow({ id: "ko", owner_id: "other", label: "other" }),
      ],
    });

    expect(listSendKeysByOwners(["first", "second", "first"]).map((key) => key.id).sort()).toEqual(["kf", "ks"]);
    expect(listSendKeysByOwners([])).toEqual([]);
  });

  it("lists hash-free key summaries for selected owners only", async () => {
    await stub.seed({
      "send-keys": [
        keyRow({ id: "kf", owner_id: "first", label: "first" }),
        keyRow({ id: "ks", owner_id: "second", label: "second" }),
        keyRow({ id: "ko", owner_id: "other", label: "other" }),
      ],
    });

    const summaries = listSendKeySummariesByOwners(["first", "second", "first"]);
    expect(summaries.map((key) => key.id).sort()).toEqual(["kf", "ks"]);
    expect(summaries.every((key) => !("key_hash" in key))).toBe(true);
    expect(listSendKeySummariesByOwners([])).toEqual([]);
  });

  it("paginates send keys after ordering newest first", async () => {
    await stub.seed({
      "send-keys": Array.from({ length: 5 }, (_v, i) => keyRow({
        id: `k-${i}`,
        owner_id: "agent-1",
        label: `key-${i}`,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });

    const page = listSendKeys("agent-1", { limit: 2, offset: 1 });

    expect(page.map((key) => key.label)).toEqual(["key-3", "key-2"]);
  });

  it("paginates hash-free send key summaries", async () => {
    await stub.seed({
      "send-keys": Array.from({ length: 5 }, (_v, i) => keyRow({
        id: `k-${i}`,
        owner_id: "agent-1",
        label: `summary-${i}`,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      })),
    });

    const page = listSendKeySummaries("agent-1", { limit: 2, offset: 1 });

    expect(page.map((key) => key.label)).toEqual(["summary-3", "summary-2"]);
    expect(page.every((key) => !("key_hash" in key))).toBe(true);
  });
});

describe("send keys — scope enforcement (canOwnerSendFrom)", () => {
  it("agent can send from an address it owns, not from others", () => {
    const agent = createOwner({ type: "agent", name: "Brutus" });
    const mine = createAddress({ provider_id: PROVIDER_ID, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    createAddress({ provider_id: PROVIDER_ID, email: "other@x.com" });
    expect(canOwnerSendFrom(agent.id, "ops@x.com")).toBe(true);
    expect(canOwnerSendFrom(agent.id, "other@x.com")).toBe(false);
    expect(canOwnerSendFrom(agent.id, "unregistered@x.com")).toBe(false);
  });

  it("agent administering a human-owned address can send from it", () => {
    const human = createOwner({ type: "human", name: "Morgan" });
    const agent = createOwner({ type: "agent", name: "Tiberius" });
    const addr = createAddress({ provider_id: PROVIDER_ID, email: "morgan@x.com" });
    assignAddressOwner(addr.id, human.id, agent.id);
    expect(canOwnerSendFrom(agent.id, "morgan@x.com")).toBe(true);
  });
});

describe("send keys — From-spoofing resistance", () => {
  it("denies a double angle-addr From even if the bracketed addr is owned", () => {
    const agent = createOwner({ type: "agent", name: "Galba" });
    const mine = createAddress({ provider_id: PROVIDER_ID, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    // attacker owns ops@x.com but smuggles victim@y.com as a second angle-addr
    expect(canOwnerSendFrom(agent.id, "x <ops@x.com> <victim@y.com>")).toBe(false);
  });

  it("matches case-insensitively on a clean From", () => {
    const agent = createOwner({ type: "agent", name: "Otho" });
    const mine = createAddress({ provider_id: PROVIDER_ID, email: "ops@x.com" });
    assignAddressOwner(mine.id, agent.id);
    expect(canOwnerSendFrom(agent.id, "OPS@X.COM")).toBe(true);
    expect(canOwnerSendFrom(agent.id, "Ops Team <Ops@X.com>")).toBe(true);
  });
});
