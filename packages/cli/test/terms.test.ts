import { describe, expect, test } from "bun:test";
import { buildProgram } from "../src/program.js";
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
});
