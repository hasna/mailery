import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import {
  HASNA_EMAILS_MODE_ENV,
  LEGACY_STORAGE_MODE_ENV,
  MAILERY_MODE_CONFIG_KEY,
  MAILERY_MODE_ENV,
  getMaileryMode,
  normalizeMaileryMode,
  resolveMaileryMode,
} from "./mode.js";

const TMP_HOME = join("/tmp", `mailery-mode-test-${process.pid}`);
const ORIGINAL_HOME = process.env["HOME"];
const MODE_ENV = [
  MAILERY_MODE_ENV,
  HASNA_EMAILS_MODE_ENV,
  LEGACY_STORAGE_MODE_ENV,
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_DATABASE_URL",
  "EMAILS_DATABASE_URL",
] as const;

beforeEach(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env["HOME"] = TMP_HOME;
  for (const key of MODE_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of MODE_ENV) delete process.env[key];
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("Mailery mode resolution", () => {
  it("uses local as the OSS default", () => {
    const resolved = resolveMaileryMode();
    expect(resolved).toMatchObject({
      mode: "local",
      label: "Local",
      source: { kind: "default" },
      warning: null,
    });
  });

  it("uses self_hosted when a self-hosted database URL is configured", () => {
    process.env["HASNA_EMAILS_DATABASE_URL"] = "postgres://self-hosted.example/mailery";

    expect(getMaileryMode()).toBe("self_hosted");
    expect(resolveMaileryMode()).toMatchObject({
      mode: "self_hosted",
      label: "Self-hosted",
    });
  });

  it("normalizes canonical and deprecated mode names", () => {
    expect(normalizeMaileryMode("local")).toEqual({ mode: "local", deprecatedAlias: null });
    expect(normalizeMaileryMode("self-hosted")).toEqual({ mode: "self_hosted", deprecatedAlias: null });
    expect(normalizeMaileryMode("cloud")).toEqual({ mode: "cloud", deprecatedAlias: null });
    expect(normalizeMaileryMode("remote")).toEqual({ mode: "self_hosted", deprecatedAlias: "remote" });
    expect(normalizeMaileryMode("hybrid")).toEqual({ mode: "self_hosted", deprecatedAlias: "hybrid" });
  });

  it("normalizes deprecated deployment env aliases without mutating config", () => {
    process.env["MAILERY_MODE"] = "remote";

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("self_hosted");
    expect(resolved.warning).toContain("Deprecated Mailery mode 'remote'");
    expect(resolved.warning).toContain("MAILERY_MODE=self_hosted");
    expect(loadConfig()).toEqual({});
  });

  it("does not treat storage sync env as the Mailery deployment mode", () => {
    process.env["HASNA_EMAILS_STORAGE_MODE"] = "remote";

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved.mode).toBe("local");
    expect(resolved.warning).toBeNull();
    expect(loadConfig()).toEqual({});
  });

  it("observes legacy config mode values without migrating on read", () => {
    saveConfig({ storage_mode: "remote", other: "kept" });

    const resolved = resolveMaileryMode();

    expect(resolved).toMatchObject({
      mode: "self_hosted",
      migratedConfig: false,
    });
    expect(resolved.warning).toContain("Deprecated Mailery mode 'remote'");
    expect(loadConfig()).toEqual({ storage_mode: "remote", other: "kept" });
  });

  it("migrates legacy config mode values to mailery_mode=self_hosted", () => {
    saveConfig({ storage_mode: "remote", other: "kept" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "self_hosted",
      migratedConfig: true,
    });
    expect(resolved.warning).toContain("Migrated deprecated Mailery mode 'remote'");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "self_hosted", other: "kept" });
  });

  it("migrates legacy config keys without treating canonical values as deprecated aliases", () => {
    saveConfig({ mode: "cloud" });

    const resolved = resolveMaileryMode({ migrateConfig: true });

    expect(resolved).toMatchObject({
      mode: "cloud",
      migratedConfig: true,
    });
    expect(resolved.warning).toBe("Migrated deprecated Mailery mode config key 'mode' to 'mailery_mode=cloud'.");
    expect(loadConfig()).toEqual({ [MAILERY_MODE_CONFIG_KEY]: "cloud" });
  });

  it("rejects unknown mode values with canonical guidance", () => {
    saveConfig({ mailery_mode: "remoteish" });

    expect(() => resolveMaileryMode()).toThrow("Use local, self_hosted, or cloud");
  });
});
