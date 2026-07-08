import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStagedCloudEnv } from "./load-cloud-env.js";

const saved = { ...process.env };
const dirs: string[] = [];

// Every mode signal the loader now honors as a local-mode rollback (mirrors
// resolveCloudConfig in db/cloud-store.ts). Cleared before each test so ambient
// env (e.g. a machine flipped to local via HASNA_MAILERY_STORAGE_MODE) can't
// make the "loads staged creds" cases skip loading.
const MODE_ENV_KEYS = [
  "HASNA_MAILERY_STORAGE_MODE",
  "MAILERY_STORAGE_MODE",
  "HASNA_MAILERY_MODE",
  "MAILERY_MODE",
  "HASNA_EMAILS_STORAGE_MODE",
  "EMAILS_STORAGE_MODE",
  "HASNA_EMAILS_MODE",
];

beforeEach(() => {
  for (const key of MODE_ENV_KEYS) delete process.env[key];
});

function stageEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mailery-env-"));
  dirs.push(dir);
  const file = join(dir, "mailery.env");
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

afterEach(() => {
  for (const key of ["HASNA_MAILERY_API_URL", "HASNA_MAILERY_API_KEY", "HASNA_MAILERY_ENV_FILE", ...MODE_ENV_KEYS]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadStagedCloudEnv", () => {
  it("loads staged HASNA_MAILERY_* creds when none are set", () => {
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    delete process.env["MAILERY_MODE"];
    delete process.env["HASNA_EMAILS_MODE"];
    process.env["HASNA_MAILERY_ENV_FILE"] = stageEnvFile(
      "# staged flip\nHASNA_MAILERY_API_URL=https://mailery.hasna.xyz\nHASNA_MAILERY_API_KEY=secret-abc\n",
    );
    loadStagedCloudEnv();
    expect(process.env["HASNA_MAILERY_API_URL"]).toBe("https://mailery.hasna.xyz");
    expect(process.env["HASNA_MAILERY_API_KEY"]).toBe("secret-abc");
  });

  it("supports `export KEY=\"value\"` lines and never overrides existing env", () => {
    delete process.env["HASNA_MAILERY_API_KEY"];
    process.env["HASNA_MAILERY_API_URL"] = "https://preset.example";
    process.env["HASNA_MAILERY_ENV_FILE"] = stageEnvFile(
      'export HASNA_MAILERY_API_URL="https://mailery.hasna.xyz"\nexport HASNA_MAILERY_API_KEY="k2"\n',
    );
    loadStagedCloudEnv();
    // URL was already set → preserved; key was unset → loaded.
    expect(process.env["HASNA_MAILERY_API_URL"]).toBe("https://preset.example");
    expect(process.env["HASNA_MAILERY_API_KEY"]).toBe("k2");
  });

  it("skips loading when mode is explicitly local (rollback)", () => {
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    process.env["MAILERY_MODE"] = "local";
    process.env["HASNA_MAILERY_ENV_FILE"] = stageEnvFile("HASNA_MAILERY_API_URL=https://x\nHASNA_MAILERY_API_KEY=k\n");
    loadStagedCloudEnv();
    expect(process.env["HASNA_MAILERY_API_URL"]).toBeUndefined();
    expect(process.env["HASNA_MAILERY_API_KEY"]).toBeUndefined();
  });

  it("skips loading when HASNA_MAILERY_STORAGE_MODE is local (env rollback)", () => {
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    process.env["HASNA_MAILERY_STORAGE_MODE"] = "local";
    process.env["HASNA_MAILERY_ENV_FILE"] = stageEnvFile("HASNA_MAILERY_API_URL=https://x\nHASNA_MAILERY_API_KEY=k\n");
    loadStagedCloudEnv();
    expect(process.env["HASNA_MAILERY_API_URL"]).toBeUndefined();
    expect(process.env["HASNA_MAILERY_API_KEY"]).toBeUndefined();
  });

  it("is a no-op when the staged file is absent", () => {
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    delete process.env["MAILERY_MODE"];
    delete process.env["HASNA_EMAILS_MODE"];
    process.env["HASNA_MAILERY_ENV_FILE"] = join(tmpdir(), "does-not-exist-mailery.env");
    expect(() => loadStagedCloudEnv()).not.toThrow();
    expect(process.env["HASNA_MAILERY_API_URL"]).toBeUndefined();
  });

  it("ignores non-allowlisted keys in the staged file", () => {
    delete process.env["HASNA_MAILERY_API_URL"];
    delete process.env["HASNA_MAILERY_API_KEY"];
    delete process.env["MAILERY_MODE"];
    delete process.env["HASNA_EMAILS_MODE"];
    process.env["HASNA_MAILERY_ENV_FILE"] = stageEnvFile(
      "HASNA_MAILERY_API_URL=https://mailery.hasna.xyz\nHASNA_MAILERY_API_KEY=k\nEVIL=payload\nDATABASE_URL=postgres://x\n",
    );
    loadStagedCloudEnv();
    expect(process.env["EVIL"]).toBeUndefined();
    expect(process.env["DATABASE_URL"]).toBeUndefined();
  });
});
