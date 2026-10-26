import { describe, expect, test } from "bun:test";
import { runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut } from "./support.js";

const version = "a".repeat(64);
function harness(stdin = "") {
  return makeHarness({
    stdin,
    env: { MAILERY_BASE_URL: "http://127.0.0.1:9" },
    route: (call) => call.path === "/api/v1/terms/current"
      ? { body: { version, url: "/terms" } }
      : { body: { user: { email: "fixture@example.com", emailVerifiedAt: "verified" }, tenant: { slug: "fixture" } } },
  });
}
function args(command: string, ...options: string[]) {
  return argv(command, "--email", "fixture@example.com", ...(command === "signup" ? ["--accept-terms", version] : []), ...options, "--json");
}
for (const command of ["signup", "login"]) {
  describe(command + " password input", () => {
    for (const ending of ["", "\n", "\r\n"]) {
      test("stdin preserves password whitespace with line-ending length " + ending.length, async () => {
        const password = " \t" + crypto.randomUUID() + " \t";
        const h = harness(password + ending);
        const commandArgs = args(command, "--password-stdin");
        expect(commandArgs.some((arg) => arg.includes(password))).toBe(false);
        await runCli(commandArgs, h.deps);
        expect(h.exitCode()).toBe(0);
        expect(parseJsonOut(h.out()).ok).toBe(true);
        const body = h.calls.find((call) => call.path === "/api/v1/auth/" + command)?.body as { password?: string };
        expect(body?.password === password).toBe(true);
        expect((h.out() + h.err()).includes(password)).toBe(false);
      });
    }
    test("removes only one newline", async () => {
      const password = crypto.randomUUID() + "\n";
      const h = harness(password + "\n");
      await runCli(args(command, "--password-stdin"), h.deps);
      const body = h.calls.find((call) => call.path === "/api/v1/auth/" + command)?.body as { password?: string };
      expect(body?.password === password).toBe(true);
    });
    test("legacy password option stays compatible and does not read stdin", async () => {
      const password = crypto.randomUUID();
      const h = harness();
      let reads = 0;
      h.deps.readStdin = async () => { reads++; throw new Error("unexpected stdin read"); };
      await runCli(args(command, "--password", password), h.deps);
      expect(h.exitCode()).toBe(0);
      expect(reads).toBe(0);
      const body = h.calls.find((call) => call.path === "/api/v1/auth/" + command)?.body as { password?: string };
      expect(body?.password === password).toBe(true);
      expect((h.out() + h.err()).includes(password)).toBe(false);
    });
    for (const mode of ["missing", "empty-stdin", "lf-only", "crlf-only", "empty-option", "both"]) {
      test(mode + " refuses before any request", async () => {
        const secret = crypto.randomUUID();
        const stdin = mode === "lf-only" ? "\n" : mode === "crlf-only" ? "\r\n" : "";
        const h = harness(stdin);
        const options = mode === "missing" ? [] : mode === "both" ? ["--password", secret, "--password-stdin"]
          : mode === "empty-option" ? ["--password", ""] : ["--password-stdin"];
        let reads = 0;
        h.deps.readStdin = async () => { reads++; return stdin; };
        await runCli(args(command, ...options), h.deps);
        expect(h.exitCode()).toBe(1);
        expect(parseJsonOut(h.out()).error?.code).toBe("usage_error");
        expect(h.calls).toHaveLength(0);
        expect((h.out() + h.err()).includes(secret)).toBe(false);
        if (mode === "both" || mode === "missing") expect(reads).toBe(0);
      });
    }
    test("stdin read errors do not disclose their contents or send a request", async () => {
      const secret = crypto.randomUUID();
      const h = harness();
      h.deps.readStdin = async () => { throw new Error(secret); };
      await runCli(args(command, "--password-stdin"), h.deps);
      expect(h.exitCode()).toBe(1);
      expect(parseJsonOut(h.out()).error?.code).toBe("usage_error");
      expect(h.calls).toHaveLength(0);
      expect((h.out() + h.err()).includes(secret)).toBe(false);
    });
  });
}
