import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/program.js";
import * as actionOutput from "../src/output.js";
import type { CliError } from "../src/output.js";
const { run: runAction, withTermsDiscovery } = actionOutput;
const version = "b".repeat(64);
async function run(args: string[]) {
  const calls: Array<{ path: string; body: unknown }> = []; const output: string[] = []; let exitCode = 0;
  const program = buildProgram({ env: { MAILERY_BASE_URL: "http://127.0.0.1:9", MAILERY_SESSION_TOKEN: "synthetic" }, stdout: x => output.push(String(x)), stderr: x => output.push(x), setExitCode: x => { exitCode = x; }, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith("/current")) return Response.json({ version, url: `/api/v1/terms/versions/${version}` });
    return Response.json({ version, acceptedAt: "2026-10-23T00:00:00Z", token: "synthetic", user: { email: "new@example.test", emailVerifiedAt: null }, tenant: { slug: "new" } });
  }});
  await program.parseAsync(["node", "mailery", ...args]); return { calls, output: output.join(""), exitCode };
}
describe("CLI Terms acceptance", () => {
  test("held signup shows only the paused error for missing and explicit consent", async () => {
    const message = "Signup and new purchases are temporarily paused. Please try again later.";
    for (const consent of [[], ["--accept-terms", version]]) {
      const output: string[] = [], calls: string[] = []; let exitCode = 0;
      const program = buildProgram({ env: { MAILERY_BASE_URL: "http://127.0.0.1:9" }, stdout: x => output.push(String(x)), stderr: x => output.push(x), setExitCode: x => { exitCode = x; }, fetch: async url => {
        calls.push(new URL(String(url)).pathname);
        return Response.json({ error: { code: "terms_unavailable", message } }, { status: 503 });
      }});
      await program.parseAsync(["node", "mailery", "signup", "--email", "held@example.test", "--password", "Testing1234", ...consent]);
      expect(exitCode).toBe(1); expect(output.join("")).toContain(message);
      expect(output.join("")).not.toContain("Read GET");
      expect(calls.length).toBeGreaterThan(0); expect(calls.every(path => path === "/api/v1/terms/current")).toBe(true);
    }
  });

  test("signup displays link/version and refuses missing acceptance before POST", async () => {
    const result = await run(["signup", "--email", "new@example.test", "--password", "Testing1234"]);
    expect(result.exitCode).toBe(1); expect(result.calls).toHaveLength(1); expect(result.output).toContain(version); expect(result.output).toContain(`/api/v1/terms/versions/${version}`);
  });
  test("stale acceptance is never replaced with latest", async () => {
    const result = await run(["signup", "--email", "new@example.test", "--password", "Testing1234", "--accept-terms", "c".repeat(64)]);
    expect(result.calls).toHaveLength(1); expect(result.exitCode).toBe(1);
  });
  test("explicit signup forwards exact version and true", async () => {
    const result = await run(["signup", "--email", "new@example.test", "--password", "Testing1234", "--accept-terms", version]);
    expect(result.exitCode).toBe(0); expect(result.calls[1]!.body).toMatchObject({ acceptedTerms: true, termsVersion: version });
  });
  test("reading terms has no side effect and acceptance uses a separate explicit command", async () => {
    const reading = await run(["terms"]); expect(reading.calls).toHaveLength(1); expect(reading.output).toContain(version);
    const accepting = await run(["terms", "--accept", version]); expect(accepting.calls[1]!.path).toBe("/api/v1/terms/accept"); expect(accepting.calls[1]!.body).toEqual({ acceptedTerms: true, termsVersion: version });
  });
  test("JSON discovery retains exact Terms fields for reading, missing/stale consent, and successful signup", async () => {
    const expected = { url: `http://127.0.0.1:9/api/v1/terms/versions/${version}`, version };
    for (const consent of [[], ["--accept-terms", "c".repeat(64)]]) {
      const result = await run(["signup", "--json", "--email", "new@example.test", "--password", "Testing1234", ...consent]);
      expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: { code: "terms_acceptance_required", details: { terms: expected } } });
      expect(result.exitCode).toBe(1);
      expect(result.calls).toHaveLength(1);
    }
    const result = await run(["signup", "--json", "--email", "new@example.test", "--password", "Testing1234", "--accept-terms", version]);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, data: { terms: expected, token: "synthetic", user: { email: "new@example.test" }, tenant: { slug: "new" } } });
    expect(result.calls.map(call => call.path)).toEqual(["/api/v1/terms/current", "/api/v1/auth/signup"]);
    expect(result.calls[1]!.body).toMatchObject({ acceptedTerms: true, termsVersion: version });
    const reading = await run(["terms", "--json"]);
    expect(JSON.parse(reading.output)).toMatchObject({ ok: true, data: expected });
    expect(reading.calls).toHaveLength(1);
  });
  test("acceptance help requires showing the link/version and prior explicit consent", async () => {
    const program = buildProgram({ env: { MAILERY_BASE_URL: "http://127.0.0.1:9" }, stdout: () => {}, stderr: () => {}, setExitCode: () => {} });
    const output = program.commands.find(command => command.name() === "terms")!.helpInformation().replace(/\s+/g, " ");
    expect(output).toContain("Show the Terms link/version to the person");
    expect(output).toContain("an explicit yes from the person");
    expect(output).toContain("an agent they authorized");
    expect(output).toContain("exact version");
  });

});


describe("CLI signup discovery after preflight", () => {
  const base = "http://127.0.0.1:9";
  const preflight = { url: `${base}/api/v1/terms/versions/${version}`, version };
  async function rejectedSignup(failure: Error | { code: string; status: number; details?: unknown }, held = false) {
    const output: string[] = [], calls: Array<{ path: string; body: unknown }> = []; let exitCode = 0;
    const program = buildProgram({ env: { MAILERY_BASE_URL: base }, stdout: x => output.push(String(x)), stderr: x => output.push(x), setExitCode: code => { exitCode = code; }, sleep: async () => {}, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith("/current") && !held) return Response.json({ version, url: `/api/v1/terms/versions/${version}` });
      if (failure instanceof Error) throw failure;
      return Response.json({ error: { code: failure.code, message: "Synthetic request rejection", details: failure.details } }, { status: failure.status });
    }});
    await program.parseAsync(["node", "mailery", "signup", "--json", "--email", "new@example.test", "--password", "Testing1234", "--accept-terms", version]);
    return { envelope: JSON.parse(output.join("")), calls, exitCode };
  }
  test("POST 400 retains preflight discovery and unrelated error details", async () => {
    const result = await rejectedSignup({ code: "bad_request", status: 400, details: { reason: "invalid field", fields: ["name"] } });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "bad_request", status: 400, message: "Synthetic request rejection", terms: preflight, details: { reason: "invalid field", fields: ["name"], terms: preflight } } });
    expect(result.calls.map(call => call.path)).toEqual(["/api/v1/terms/current", "/api/v1/auth/signup"]);
    expect(result.calls[1]!.body).toMatchObject({ acceptedTerms: true, termsVersion: version });
  });
  test("server terms_version_changed 409 supersedes preflight with resolved authoritative Terms", async () => {
    const newer = "d".repeat(64), terms = { version: newer, url: `${base}/api/v1/terms/versions/${newer}` };
    const result = await rejectedSignup({ code: "terms_version_changed", status: 409, details: { terms: { version: newer, url: `/api/v1/terms/versions/${newer}`, notice: "new publication" }, retry: true } });
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "terms_version_changed", status: 409, terms, details: { terms: { ...terms, notice: "new publication" }, retry: true } } });
    expect(result.exitCode).toBe(1);
    expect(result.calls.map(call => call.path)).toEqual(["/api/v1/terms/current", "/api/v1/auth/signup"]);
    expect(result.calls[1]!.body).toMatchObject({ termsVersion: version });
  });
  test("transport rejection retains preflight without changing the SDK error", async () => {
    const result = await rejectedSignup(new Error("Synthetic transport failure"));
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "network", message: `cannot reach Mailery at ${base}`, terms: preflight, details: { terms: preflight } } });
    expect(result.envelope.error.status).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.calls.filter(call => call.path === "/api/v1/terms/current")).toHaveLength(1);
  });
  test("held GET failure adds no inferred Terms or account POST", async () => {
    const result = await rejectedSignup({ code: "terms_unavailable", status: 503, details: { publication: "held" } }, true);
    expect(result.envelope).toEqual({ ok: false, error: { code: "terms_unavailable", message: "Synthetic request rejection", status: 503, details: { publication: "held" } } });
    expect(result.exitCode).toBe(1);
    expect(result.calls.every(call => call.path === "/api/v1/terms/current")).toBe(true);
  });
});

describe("CLI action error mapping", () => {
  const terms = { version, url: `http://127.0.0.1:9/api/v1/terms/versions/${version}` };
  test("default runner preserves a non-signup generic error", async () => {
    const output: string[] = []; let status = 0;
    await runAction({ env: {}, stdout: value => output.push(String(value)), stderr: () => {}, setExitCode: value => { status = value; } }, true, async () => { throw new Error("Synthetic generic error"); });
    expect(status).toBe(1);
    expect(JSON.parse(output.join(""))).toEqual({ ok: false, error: { code: "cli_error", message: "Synthetic generic error" } });
  });
  test("runner maps a normalized generic error only on failure", async () => {
    const output: string[] = []; let status = 0, mapped = 0;
    const deps = { env: {}, stdout: (value: string) => output.push(value), stderr: () => {}, setExitCode: (value: number) => { status = value; } };
    const mapper = (error: CliError) => { mapped++; return withTermsDiscovery(error, terms, "http://127.0.0.1:9"); };
    await runAction(deps, true, async () => {}, mapper);
    expect(mapped).toBe(0); expect(output).toHaveLength(0);
    await runAction(deps, true, async () => { throw new Error("Synthetic generic error"); }, mapper);
    expect(mapped).toBe(1); expect(status).toBe(1);
    expect(JSON.parse(output.join(""))).toEqual({ ok: false, error: { code: "cli_error", message: "Synthetic generic error", terms, details: { terms } } });
  });
  test("enrichment preserves non-object details, hint, code and status", () => {
    for (const details of [null, "synthetic detail", ["synthetic detail"]]) {
      const error = { code: "bad_request", message: "Synthetic error", status: 400, hint: "Existing hint", details };
      expect(withTermsDiscovery(error, terms, "http://127.0.0.1:9")).toEqual({ ...error, terms });
    }
  });
});
