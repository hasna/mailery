// Tests for `mailery verify --poll`: the bounded machine-bootstrap loop that
// waits for the human verification click and mints the session. No network,
// no DB — a routing fake `fetch` stands in for the server.

import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type Harness } from "./support.js";

const SESSION = "sess_owner_1";
const UNVERIFIED_USER = {
  id: "u1",
  email: "agent@example.com",
  name: "Agent",
  tenantId: "t1",
  role: "owner",
  isPlatformAdmin: false,
  emailVerifiedAt: null,
};
const TENANT = { id: "t1", name: "Agent Co", slug: "agent-co", plan: "starter" };

function pollCalls(h: Harness) {
  return h.calls.filter((c) => c.path === "/api/v1/auth/verify/poll");
}

describe("verify --poll (machine bootstrap)", () => {
  test("happy path: polls pending then verified, prints the fresh session once (exit 0)", async () => {
    let polls = 0;
    const h = makeHarness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => {
        if (c.path === "/api/v1/auth/verify/poll") {
          polls += 1;
          if (polls < 3) return { body: { status: "pending" } };
          return { body: { status: "verified", token: "sess_fresh_1" } };
        }
        return undefined;
      },
    });
    await runCli(argv("verify", "--poll", "--email", "agent@example.com", "--json"), h.deps);

    const calls = pollCalls(h);
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect((call.body as { email?: string }).email).toBe("agent@example.com");
      // The signup/login session authorizes issuance server-side.
      expect(call.auth).toBe(`Bearer ${SESSION}`);
    }

    expect(h.exitCode()).toBe(0);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(true);
    expect((env.data as { verified: boolean; token?: string }).verified).toBe(true);
    // The minted session rides the machine-readable envelope...
    expect((env.data as { token?: string }).token).toBe("sess_fresh_1");
    // ...and JSON mode stays quiet on stderr.
    expect(h.err()).toBe("");
  });

  test("resolves the polled email from the session identity when --email is omitted", async () => {
    let polls = 0;
    const h = makeHarness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => {
        if (c.path === "/api/v1/auth/me") {
          return { body: { user: UNVERIFIED_USER, tenant: TENANT, auth: { via: "session", scopes: [] } } };
        }
        if (c.path === "/api/v1/auth/verify/poll") {
          polls += 1;
          return polls < 2 ? { body: { status: "pending" } } : { body: { status: "verified", token: "sess_fresh_2" } };
        }
        return undefined;
      },
    });
    await runCli(argv("verify", "--poll", "--json"), h.deps);

    expect(h.exitCode()).toBe(0);
    const sent = pollCalls(h)[0]!;
    expect((sent.body as { email?: string }).email).toBe("agent@example.com");
  });

  test("times out with verification_poll_timeout after the bounded window (exit 1)", async () => {
    const h = makeHarness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => (c.path === "/api/v1/auth/verify/poll" ? { body: { status: "pending" } } : undefined),
    });
    // Real clock on purpose: the loop must keep polling across the deadline.
    // A 6s budget at the 5s minimum cadence fits exactly two checks (~5s).
    await runCli(argv("verify", "--poll", "--email", "agent@example.com", "--timeout", "6", "--interval", "5", "--json"), h.deps);

    expect(h.exitCode()).toBe(1);
    const env = parseJsonOut(h.out());
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("verification_poll_timeout");
    expect(env.error?.hint).toContain("--resend");
    // It kept polling until the deadline instead of giving up after the
    // first pending answer.
    expect(pollCalls(h).length).toBeGreaterThanOrEqual(2);
  }, 20000);

  test("prints clear progress lines while waiting (text mode)", async () => {
    let polls = 0;
    const h = makeHarness({
      env: { MAILERY_SESSION_TOKEN: SESSION },
      route: (c) => {
        if (c.path === "/api/v1/auth/verify/poll") {
          polls += 1;
          return polls < 2 ? { body: { status: "pending" } } : { body: { status: "verified", token: "sess_fresh_3" } };
        }
        return undefined;
      },
    });
    await runCli(argv("verify", "--poll", "--email", "agent@example.com"), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.err()).toContain("Waiting for email verification");
    expect(h.err()).toContain("Email verified");
    // The minted session is surfaced exactly once, like signup/login do.
    expect(h.out()).toContain("Session token (shown once)");
    expect(h.out()).toContain("export MAILERY_SESSION_TOKEN='sess_fresh_3'");
  });

  test("an API-key-only environment reports already verified without polling", async () => {
    const h = makeHarness({
      env: { MAILERY_API_KEY: "ml_key" },
      route: (c) =>
        c.path === "/api/v1/auth/me"
          ? { body: { user: null, tenant: TENANT, auth: { via: "api_key", scopes: ["full"] } } }
          : undefined,
    });
    await runCli(argv("verify", "--poll", "--json"), h.deps);

    expect(h.exitCode()).toBe(0);
    const env = parseJsonOut(h.out());
    expect((env.data as { verified: boolean }).verified).toBe(true);
    expect(pollCalls(h)).toHaveLength(0);
  });

  test("rejects a timeout above the 30-minute maximum as a usage error before any request", async () => {
    const h = makeHarness({ env: { MAILERY_SESSION_TOKEN: SESSION }, route: () => ({}) });
    await runCli(argv("verify", "--poll", "--email", "agent@example.com", "--timeout", "1801", "--json"), h.deps);

    // In-command usage errors follow the repo's fail() convention (exit 1,
    // cli_usage_error); commander parse errors are the exit-2 class.
    expect(h.exitCode()).toBe(1);
    expect(parseJsonOut(h.out()).error?.code).toBe("cli_usage_error");
    expect(pollCalls(h)).toHaveLength(0);
  });

  test("without a session or API key, --poll fails fast instead of spinning anonymously", async () => {
    const h = makeHarness({ route: () => ({}) });
    await runCli(argv("verify", "--poll", "--email", "agent@example.com", "--json"), h.deps);

    expect(parseJsonOut(h.out()).error?.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });

  test("--poll and --resend are mutually exclusive", async () => {
    const h = makeHarness({ env: { MAILERY_SESSION_TOKEN: SESSION }, route: () => ({}) });
    await runCli(argv("verify", "--poll", "--resend", "--json"), h.deps);

    expect(parseJsonOut(h.out()).error?.code).toBe("cli_usage_error");
    expect(h.calls).toHaveLength(0);
  });
});
