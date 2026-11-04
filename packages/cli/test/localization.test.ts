import { expect, test } from "bun:test";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MaileryError } from "@hasna/mailery-sdk-internal";
import { checkoutCountryCopy, displayLanguage, displayNumber, displayUsdCents } from "../src/checkout-country-copy.js";
import { languagePreferencePath, readLanguagePreference, saveLanguagePreference } from "../src/language-preference.js";
import { buildProgram, runCli } from "../src/program.js";
import { argv, makeHarness, parseJsonOut, type RouteHandler } from "./support.js";

const target = "http://127.0.0.1:1";
const version = "a".repeat(64);
const confirmation = ["--purchase-id", "purchase-fixture", "--idempotency-key", "confirmation-fixture"];
const orderConfirmation = ["--language", "en", "--checkout-protocol", "wrong", "--checkout-terms-version", version, "--idempotency-key", "confirmation-fixture"];

function harness(language: string, route?: RouteHandler) {
  return makeHarness({ env: { MAILERY_LANGUAGE: language, MAILERY_BASE_URL: target, MAILERY_API_URL: target, MAILERY_SESSION_TOKEN: "synthetic" }, route });
}

for (const language of ["en", "ro"] as const) {
  const copy = checkoutCountryCopy({ MAILERY_LANGUAGE: language });
  test(`${language}: every changed paid command has catalog help, including options and help labels`, () => {
    const h = harness(language);
    const program = buildProgram(h.deps);
    const billing = program.commands.find(command => command.name() === "billing")!;
    for (const [name, description] of [
      ["purchases", copy.purchasesCommand], ["withdraw", copy.withdrawCommand],
      ["confirm-withdrawal", copy.confirmWithdrawalCommand], ["withdrawal", copy.withdrawalCommand],
      ["order", copy.orderCommand], ["confirm-order", copy.confirmCommand], ["countries", copy.command], ["add-funds", copy.fundingCommand],
    ]) {
      const help = billing.commands.find(command => command.name() === name)!.helpInformation().replace(/\s+/g, " ");
      expect(help).toContain(description!);
      expect(help).toContain(copy.options);
      expect(help).toContain(copy.jsonOption);
      expect(help).toContain(copy.helpOption);
      if (language === "ro") {
        expect(help).not.toContain("Options:");
        expect(help).not.toContain("[options]");
        expect(help).not.toContain("display help for command");
        expect(help).not.toContain("Exact protocol");
        expect(help).not.toContain("Stable confirmation");
      }
    }
    const subscribe = program.commands.find(command => command.name() === "subscribe")!;
    expect(subscribe.helpInformation().replace(/\s+/g, " ")).toContain(copy.purchaseKeyOption);
  });

  test(`${language}: confirmation, acknowledgement-language and protocol refusals are local and localized`, async () => {
    for (const [args, message] of [
      [["billing", "confirm-withdrawal", "request-fixture", ...confirmation], copy.withdrawalRequired],
      [["billing", "withdraw", "purchase-fixture", "--email", "customer@example.invalid", "--idempotency-key", "request-fixture", "--language", "wrong"], copy.languageInvalid],
      [["billing", "confirm-order", "order-fixture", ...orderConfirmation], copy.protocolRequired],
    ] as const) {
      const h = harness(language);
      await runCli(argv(...args), h.deps);
      expect(h.exitCode()).toBe(1);
      expect(h.calls).toHaveLength(0);
      expect(h.err()).toContain(`${copy.error} ${message}`);
    }
    const missing = harness(language);
    await runCli(argv("billing", "withdraw", "purchase-fixture"), missing.deps);
    expect(missing.exitCode()).toBe(2);
    expect(missing.calls).toHaveLength(0);
    expect(missing.err()).toContain(language === "ro" ? copy.requiredOption : "required option");
  });

  test(`${language}: human result labels are localized while API language, ids and server text are preserved`, async () => {
    const result = { id: "request-fixture", purchase_id: "purchase-fixture", acknowledgement_email: "customer@example.invalid", language: "en", message: "Server-authored policy text", acknowledgement_status: "sent", refund_status: "pending_policy_execution" };
    const identified = harness(language, () => ({ body: result }));
    await runCli(argv("billing", "withdraw", "purchase-fixture", "--email", result.acknowledgement_email, "--idempotency-key", "request-fixture"), identified.deps);
    expect(identified.out()).toContain(`${copy.requestLabel} request-fixture`);
    expect(identified.out()).toContain(`${copy.purchaseLabel} purchase-fixture`);
    expect(identified.out()).toContain(`${copy.acknowledgementLabel} ${result.acknowledgement_email}`);
    expect(identified.out()).toContain(result.message);
    expect(identified.calls[0]!.body).toEqual({ email: result.acknowledgement_email, language: "en" });
    for (const args of [["billing", "withdrawal", "request-fixture"], ["billing", "confirm-withdrawal", "request-fixture", ...confirmation, "--yes"]]) {
      const h = harness(language, () => ({ body: result }));
      await runCli(argv(...args), h.deps);
      expect(h.exitCode()).toBe(0);
      expect(h.out()).toContain(`${copy.acknowledgementLabel} sent`);
      expect(h.out()).toContain(`${copy.refundLabel} pending_policy_execution`);
    }
    const purchases = harness(language, () => ({ body: { data: [{ id: "purchase-fixture", kind: "subscription", withdrawal_period: { status: "review_required" } }], next_cursor: null } }));
    await runCli(argv("billing", "purchases"), purchases.deps);
    expect(purchases.out()).toContain(`${copy.withdrawalPeriod} review_required`);
  });

  test(`${language}: JSON result and refusal envelopes keep their existing language-neutral contract`, async () => {
    const result = { id: "request-fixture", message: "Server text", refund_status: "pending_policy_execution" };
    const success = harness(language, () => ({ body: result }));
    await runCli(argv("billing", "withdrawal", "request-fixture", "--json"), success.deps);
    expect(parseJsonOut(success.out())).toEqual({ ok: true, data: result });
    const failure = harness(language);
    await runCli(argv("billing", "confirm-withdrawal", "request-fixture", ...confirmation, "--json"), failure.deps);
    expect(parseJsonOut(failure.out())).toEqual({ ok: false, error: { code: "withdrawal_confirmation_required", message: checkoutCountryCopy({}).withdrawalRequired } });
    expect(failure.calls).toHaveLength(0);
  });
}

test("display selection uses environment, then saved preference, then locale, with English fallback", () => {
  expect(displayLanguage({ MAILERY_LANGUAGE: "en", LANG: "ro_RO.UTF-8" }, "ro")).toBe("en");
  expect(displayLanguage({ LANG: "en_US.UTF-8" }, "ro")).toBe("ro");
  expect(displayLanguage({ LC_ALL: "", LC_MESSAGES: "ro_RO.UTF-8", LANG: "en_US.UTF-8" })).toBe("ro");
  expect(displayLanguage({ LANG: "ro-RO" })).toBe("ro");
  for (const selected of ["fr_FR.UTF-8", "robot", "invalid", ""]) expect(displayLanguage({ MAILERY_LANGUAGE: selected })).toBe("en");
  expect(displayNumber(1234.5, "ro")).toBe("1.234,5");
  expect(displayNumber(1234.5, "en")).toBe("1,234.5");
  expect(displayUsdCents(123450, "ro")).toContain("1.234,50");
});

test("language preference resolver matches Hasna config roots and never uses legacy MAILERY_CONFIG_DIR", () => {
  expect(languagePreferencePath({ HOME: "/synthetic/home" })).toBe("/synthetic/home/.hasna/mailery/config/preferences.json");
  expect(languagePreferencePath({ HASNA_HOME: "/synthetic/root", HOME: "/synthetic/home" })).toBe("/synthetic/root/mailery/config/preferences.json");
  expect(languagePreferencePath({ HASNA_CONFIG_HOME: "/synthetic/config", HASNA_HOME: "/synthetic/root" })).toBe("/synthetic/config/mailery/preferences.json");
  expect(languagePreferencePath({ MAILERY_CONFIG_DIR: "/legacy" })).toBeUndefined();
  expect(() => languagePreferencePath({ HASNA_CONFIG_HOME: "relative" })).toThrow();
});

test("fresh processes persist only a language and obey overrides without changing acknowledgement defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "mailery-language-home-"));
  const entry = resolve(import.meta.dir, "../src/index.ts");
  const env = { HOME: home, PATH: process.env.PATH!, TMPDIR: tmpdir(), MAILERY_BASE_URL: target, MAILERY_API_URL: target };
  const execute = (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawnSync([process.execPath, "--no-install", entry, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
  };
  expect(execute(["language", "en"]).code).toBe(0);
  const path = languagePreferencePath(env)!;
  const original = readFileSync(path);
  const preserved = join(home, "preceding-language.json");
  copyFileSync(path, preserved);
  expect(readFileSync(preserved)).toEqual(original);
  expect(execute(["language", "ro"]).code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe('{"language":"ro"}\n');
  expect(readFileSync(preserved)).toEqual(original);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const selected = execute(["billing", "withdraw", "--help"]);
  expect(selected.code).toBe(0);
  expect(selected.out).toContain("Identifică");
  expect(selected.out).toContain('implicit: "en"');
  expect(execute(["billing", "withdraw", "--help"], { MAILERY_LANGUAGE: "en" }).out).toContain("Identify a purchase");
  expect(execute(["billing", "withdraw", "--help"], { MAILERY_LANGUAGE: "fr" }).out).toContain("Identify a purchase");
  expect(JSON.parse(execute(["language", "--json"]).out)).toEqual({ ok: true, data: { language: "ro" } });
});

test("malformed, unreadable and uncertain language preferences refuse explicitly before dispatch", async () => {
  const home = mkdtempSync(join(tmpdir(), "mailery-language-failures-"));
  const env = { HOME: home, MAILERY_BASE_URL: target, MAILERY_API_URL: target };
  const path = languagePreferencePath(env)!;
  mkdirSync(resolve(path, ".."), { recursive: true });
  for (const data of ['broken', '{"language":"fr"}', '{"language":"ro","extra":"untrusted"}', '[]']) {
    writeFileSync(path, data);
    await expect(readLanguagePreference(env)).rejects.toMatchObject({ code: "preferences_invalid" });
    const h = harness("ro");
    h.deps.readLanguagePreference = () => readLanguagePreference(env);
    await runCli(argv("billing", "withdrawal", "request-fixture"), h.deps);
    expect(h.exitCode()).toBe(1);
    expect(h.calls).toHaveLength(0);
    expect(h.err()).toContain(checkoutCountryCopy({ MAILERY_LANGUAGE: "ro" }).preferencesInvalid);
    expect(h.err()).not.toContain(data);
    await expect(saveLanguagePreference(env, "en")).rejects.toMatchObject({ code: "preferences_write" });
    expect(readFileSync(path, "utf8")).toBe(data);
  }
  const readFailure = harness("en");
  readFailure.deps.readLanguagePreference = async () => { throw new MaileryError("preferences_read", { code: "preferences_read" }); };
  await runCli(argv("billing", "withdrawal", "request-fixture", "--json"), readFailure.deps);
  expect(parseJsonOut(readFailure.out()).error?.message).toBe(checkoutCountryCopy({}).preferencesRead);
  expect(readFailure.calls).toHaveLength(0);
  const uncertain = harness("ro");
  uncertain.deps.saveLanguagePreference = async () => { throw new MaileryError("preferences_write", { code: "preferences_write" }); };
  await runCli(argv("language", "en"), uncertain.deps);
  expect(uncertain.exitCode()).toBe(1);
  expect(uncertain.err()).toContain(checkoutCountryCopy({ MAILERY_LANGUAGE: "ro" }).preferencesWrite);
  expect(uncertain.out()).not.toContain("saved");
  expect(uncertain.calls).toHaveLength(0);
});


test("Romanian entitlement output formats numbers while JSON preserves neutral numeric values", async () => {
  for (const json of [false, true]) {
    const h = harness("ro", () => ({ body: { balance: 1234, subscriptions: [] } }));
    await runCli(argv("subscribe", "pro", "--resume", ...(json ? ["--json"] : [])), h.deps);
    expect(h.exitCode()).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.method).toBe("GET");
    if (json) expect((parseJsonOut(h.out()).data as { balance: number }).balance).toBe(1234);
    else expect(h.out()).toContain("Acces activ. Sold: 1.234.");
  }
});


test("Romanian SDK-owned session and version refusals are localized without dispatch or JSON changes", async () => {
  const copy = checkoutCountryCopy({ MAILERY_LANGUAGE: "ro" });
  for (const json of [false, true]) {
    const h = harness("ro");
    h.env.MAILERY_SESSION_TOKEN = undefined;
    await runCli(argv("billing", "order", "order-fixture", ...(json ? ["--json"] : [])), h.deps);
    expect(h.exitCode()).toBe(1);
    expect(h.calls).toHaveLength(0);
    if (json) expect(parseJsonOut(h.out()).error?.message).toBe(checkoutCountryCopy({}).sessionRequired);
    else { expect(h.err()).toContain(copy.sessionRequired); expect(h.err()).toContain(copy.sessionHint); }
    const malformed = harness("ro");
    const args = orderConfirmation.map(value => value === "wrong" ? "stripe-terms-v1" : value === version ? "bad-version" : value);
    await runCli(argv("billing", "confirm-order", "order-fixture", ...args, ...(json ? ["--json"] : [])), malformed.deps);
    expect(malformed.exitCode()).toBe(1);
    expect(malformed.calls).toHaveLength(0);
    if (json) expect(parseJsonOut(malformed.out()).error?.message).toBe(checkoutCountryCopy({}).protocolInputRequired);
    else expect(malformed.err()).toContain(copy.protocolInputRequired);
  }
});
