import { expect, test } from "bun:test";
import { buildProgram } from "../src/program.js";
import { VERSION } from "../src/version.js";
const version = "b".repeat(64);
test("CLI signup and explicit acceptance declare the public CLI version without changing consent", async () => {
  for (const args of [
    ["signup", "--email", "fixture@example.test", "--password", "Synthetic password 1234", "--accept-terms", version],
    ["terms", "--accept", version],
  ]) {
    const calls: { path: string; headers: Record<string, string>; body: unknown }[] = [];
    let exitCode = 0;
    const program = buildProgram({ env: { MAILERY_BASE_URL: "http://127.0.0.1:9", MAILERY_SESSION_TOKEN: "synthetic" }, stdout: () => {}, stderr: () => {}, setExitCode: code => { exitCode = code; }, fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(path.endsWith("/current") ? { version, url: "/terms" } : { token: "synthetic-session", user: { email: "fixture@example.test" }, tenant: { slug: "fixture" } });
    } });
    await program.parseAsync(["node", "mailery", ...args]);
    expect(exitCode).toBe(0);
    expect(calls[0]!.headers["x-mailery-client-name"]).toBeUndefined();
    const accepted = calls[1]!;
    expect(accepted.headers["x-mailery-client-name"]).toBe("mailery-cli");
    expect(accepted.headers["x-mailery-client-version"]).toBe(VERSION);
    expect(accepted.body).toMatchObject({ acceptedTerms: true, termsVersion: version });
    if (args[0] === "terms") expect(accepted.headers.authorization).toBe("Bearer synthetic");
  }
});
