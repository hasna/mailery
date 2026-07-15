import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  databaseFileExists,
  getDatabase,
  getDatabasePath,
  getDataDir,
  resetDatabase,
} from "./database.js";

type EnvKey = "HOME" | "USERPROFILE" | "HASNA_EMAILS_DB_PATH" | "EMAILS_DB_PATH";

const ENV_KEYS: EnvKey[] = [
  "HOME",
  "USERPROFILE",
  "HASNA_EMAILS_DB_PATH",
  "EMAILS_DB_PATH",
];

let root = "";
let previousEnv: Partial<Record<EnvKey, string>> = {};
let previousUmask = 0;
let previousCwd = "";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function runPostinstall(rootPath: string) {
  const packageRoot = join(import.meta.dir, "..", "..");
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    scripts: { postinstall: string };
  };
  expect(packageJson.scripts.postinstall).toBe("bun ./scripts/ensure-private-data-dir.mjs");
  return Bun.spawnSync([process.execPath, "./scripts/ensure-private-data-dir.mjs"], {
    cwd: packageRoot,
    env: { ...process.env, HOME: rootPath, PATH: join(rootPath, "empty-path") },
  });
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  closeDatabase();
  resetDatabase();
  previousCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "emails-sqlite-privacy-"));
  previousEnv = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) previousEnv[key] = value;
    delete process.env[key];
  }
  process.env.HOME = root;
  previousUmask = process.umask(0o022);
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  process.umask(previousUmask);
  restoreEnv();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

// These mode and symlink contracts are POSIX-only. A Windows no-op unit belongs
// beside an injectable permission helper once production exposes that boundary.
if (process.platform !== "win32") {
  describe("SQLite filesystem privacy regressions", () => {
    it("creates a traversable shared root and a private app-owned default directory", () => {
      const dataDir = getDataDir();

      expect(dataDir).toBe(join(root, ".hasna", "emails"));
      expect([
        mode(join(root, ".hasna")),
        mode(dataDir),
      ]).toEqual([0o755, 0o700]);
    });

    it("preserves a safe shared root while repairing the app-owned directory to 0700", () => {
      const hasnaDir = join(root, ".hasna");
      const dataDir = join(hasnaDir, "emails");
      mkdirSync(dataDir, { recursive: true, mode: 0o755 });
      chmodSync(hasnaDir, 0o755);
      chmodSync(dataDir, 0o755);

      expect(getDataDir()).toBe(dataDir);
      expect([mode(hasnaDir), mode(dataDir)]).toEqual([0o755, 0o700]);
    });

    it("preserves mode 0700 on already-private default directories", () => {
      const hasnaDir = join(root, ".hasna");
      const dataDir = join(hasnaDir, "emails");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(hasnaDir, 0o700);
      chmodSync(dataDir, 0o700);

      expect(getDataDir()).toBe(dataDir);
      expect([mode(hasnaDir), mode(dataDir)]).toEqual([0o700, 0o700]);
    });

    it("rejects an unsafe shared default root instead of changing its cross-app permissions", () => {
      const hasnaDir = join(root, ".hasna");
      mkdirSync(hasnaDir, { mode: 0o777 });
      chmodSync(hasnaDir, 0o777);

      expect(() => getDataDir()).toThrow(/unsafe|writ|permission/i);
      expect(mode(hasnaDir)).toBe(0o777);
      expect(existsSync(join(hasnaDir, "emails"))).toBe(false);
    });

    it("rejects a symlink in the app-owned default directory chain", () => {
      const target = join(root, "redirected-hasna");
      mkdirSync(target, { mode: 0o755 });
      chmodSync(target, 0o755);
      symlinkSync(target, join(root, ".hasna"), "dir");

      expect(() => getDataDir()).toThrow(/symbolic link|symlink/i);
      expect(mode(target)).toBe(0o755);
      expect(readdirSync(target)).toEqual([]);
    });

    it("canonicalizes a system-style alias in HOME before appending app-owned directories", () => {
      const canonicalHome = join(root, "canonical-home");
      const aliasHome = join(root, "alias-home");
      mkdirSync(canonicalHome, { mode: 0o700 });
      symlinkSync(canonicalHome, aliasHome, "dir");
      process.env.HOME = aliasHome;

      const dataDir = getDataDir();

      expect(dataDir).toBe(join(realpathSync(canonicalHome), ".hasna", "emails"));
      expect(mode(join(canonicalHome, ".hasna"))).toBe(0o755);
      expect(mode(dataDir)).toBe(0o700);
    });

    it("creates private default directories from the Bun package postinstall hook", () => {
      const result = runPostinstall(root);

      expect(result.exitCode).toBe(0);
      expect([
        mode(join(root, ".hasna")),
        mode(join(root, ".hasna", "emails")),
      ]).toEqual([0o755, 0o700]);
    });

    it("postinstall preserves a safe shared root and repairs an existing permissive emails directory", () => {
      const hasnaDir = join(root, ".hasna");
      const dataDir = join(hasnaDir, "emails");
      mkdirSync(dataDir, { recursive: true, mode: 0o755 });
      chmodSync(hasnaDir, 0o755);
      chmodSync(dataDir, 0o755);

      const result = runPostinstall(root);

      expect(result.exitCode).toBe(0);
      expect([mode(hasnaDir), mode(dataDir)]).toEqual([0o755, 0o700]);
    });

    it("postinstall canonicalizes a system-style HOME alias and creates only under its target", () => {
      const canonicalHome = join(root, "postinstall-canonical-home");
      const aliasHome = join(root, "postinstall-alias-home");
      mkdirSync(canonicalHome, { mode: 0o700 });
      symlinkSync(canonicalHome, aliasHome, "dir");

      const result = runPostinstall(aliasHome);

      expect(result.exitCode).toBe(0);
      expect(mode(join(canonicalHome, ".hasna"))).toBe(0o755);
      expect(mode(join(canonicalHome, ".hasna", "emails"))).toBe(0o700);
    });

    it("postinstall rejects a symlink target without changing it", () => {
      const target = join(root, "postinstall-target");
      mkdirSync(target, { mode: 0o755 });
      chmodSync(target, 0o755);
      symlinkSync(target, join(root, ".hasna"), "dir");

      const result = runPostinstall(root);

      expect(result.exitCode).not.toBe(0);
      expect(mode(target)).toBe(0o755);
      expect(readdirSync(target)).toEqual([]);
    });

    it("hardens pre-existing WAL, SHM, and journal artifacts before the first SQLite statement", () => {
      const parent = join(root, "custom");
      const path = join(parent, "emails.db");
      mkdirSync(parent, { mode: 0o755 });

      const keeper = new BunDatabase(path);
      keeper.run("PRAGMA journal_mode = WAL");
      keeper.run("CREATE TABLE privacy_probe (id INTEGER PRIMARY KEY)");
      keeper.run("INSERT INTO privacy_probe DEFAULT VALUES");

      const sidecars = ["-wal", "-shm", "-journal"].map((suffix) => `${path}${suffix}`);
      writeFileSync(`${path}-journal`, "", { mode: 0o644 });
      for (const sidecar of sidecars) {
        expect(existsSync(sidecar)).toBe(true);
        chmodSync(sidecar, 0o644);
      }

      const originalRun = BunDatabase.prototype.run;
      let observedAtFirstStatement: number[] | undefined;
      BunDatabase.prototype.run = function (...args: Parameters<typeof originalRun>) {
        observedAtFirstStatement ??= sidecars.map(mode);
        // The journal fixture exists only to observe its mode. Remove it before
        // SQLite can interpret its intentionally empty contents.
        rmSync(`${path}-journal`, { force: true });
        return originalRun.apply(this, args);
      };

      try {
        getDatabase(path);
      } finally {
        BunDatabase.prototype.run = originalRun;
        keeper.close();
      }

      expect(observedAtFirstStatement).toEqual([0o600, 0o600, 0o600]);
    });

    for (const [label, parentMode] of [
      ["group-writable", 0o770],
      ["world-writable", 0o777],
    ] as const) {
      it(`rejects a database under a ${label} custom parent`, () => {
        const parent = join(root, label);
        const path = join(parent, "emails.db");
        mkdirSync(parent, { mode: parentMode });
        chmodSync(parent, parentMode);

        expect(() => getDatabase(path)).toThrow(/parent|directory|writ|unsafe|permission/i);
        expect(existsSync(path)).toBe(false);
      });
    }

    it("canonicalizes an existing system-style alias used as the custom database parent", () => {
      const target = join(root, "custom-parent-target");
      const parent = join(root, "custom-parent-link");
      const path = join(parent, "emails.db");
      mkdirSync(target, { mode: 0o755 });
      symlinkSync(target, parent, "dir");
      const canonicalPath = join(realpathSync(target), "emails.db");

      getDatabase(path);

      expect(existsSync(canonicalPath)).toBe(true);
      expect(mode(canonicalPath)).toBe(0o600);
    });

    it("creates missing custom parents beneath the canonical target of a system-style alias", () => {
      const target = join(root, "custom-missing-target");
      const alias = join(root, "custom-missing-link");
      const path = join(alias, "missing", "nested", "emails.db");
      mkdirSync(target, { mode: 0o755 });
      symlinkSync(target, alias, "dir");
      const canonicalPath = join(realpathSync(target), "missing", "nested", "emails.db");

      getDatabase(path);

      expect(existsSync(canonicalPath)).toBe(true);
      expect(mode(join(target, "missing"))).toBe(0o700);
      expect(mode(join(target, "missing", "nested"))).toBe(0o700);
      expect(mode(canonicalPath)).toBe(0o600);
    });

    it("reports and checks the actual canonical storage path", () => {
      const target = join(root, "canonical-target");
      const alias = join(root, "canonical-link");
      mkdirSync(target, { mode: 0o755 });
      symlinkSync(target, alias, "dir");
      process.env.EMAILS_DB_PATH = join(alias, "emails.db");

      const canonicalPath = getDatabasePath();
      expect(canonicalPath).toBe(join(realpathSync(target), "emails.db"));
      expect(databaseFileExists()).toBe(false);

      getDatabase();

      expect(databaseFileExists()).toBe(true);
      expect(existsSync(canonicalPath)).toBe(true);
      expect(mode(canonicalPath)).toBe(0o600);
    });

    it("does not return to an alias retargeted after SQLite opens the canonical path", () => {
      const firstTarget = join(root, "retarget-first");
      const secondTarget = join(root, "retarget-second");
      const alias = join(root, "retarget-link");
      const requestedPath = join(alias, "emails.db");
      mkdirSync(firstTarget, { mode: 0o755 });
      mkdirSync(secondTarget, { mode: 0o755 });
      symlinkSync(firstTarget, alias, "dir");

      const originalRun = BunDatabase.prototype.run;
      let retargeted = false;
      BunDatabase.prototype.run = function (...args: Parameters<typeof originalRun>) {
        if (!retargeted) {
          rmSync(alias);
          symlinkSync(secondTarget, alias, "dir");
          retargeted = true;
        }
        return originalRun.apply(this, args);
      };

      try {
        getDatabase(requestedPath);
      } finally {
        BunDatabase.prototype.run = originalRun;
      }

      expect(existsSync(join(firstTarget, "emails.db"))).toBe(true);
      expect(existsSync(join(secondTarget, "emails.db"))).toBe(false);
    });

    it("rejects a safe direct parent beneath an unsafe non-sticky writable ancestor", () => {
      const ancestor = join(root, "unsafe-ancestor");
      const parent = join(ancestor, "owned-parent");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      chmodSync(ancestor, 0o777);
      chmodSync(parent, 0o700);

      expect(() => getDatabase(join(parent, "emails.db"))).toThrow(/ancestor|writ|unsafe/i);
      expect(existsSync(join(parent, "emails.db"))).toBe(false);
    });

    it("allows a current-owned safe parent beneath a trusted sticky directory", () => {
      const sticky = join(root, "sticky-ancestor");
      const parent = join(sticky, "owned-parent");
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // Bun 1.3.14's chmodSync drops S_ISVTX, so use the platform chmod to
      // construct the same mode as /tmp for this POSIX-only regression.
      expect(Bun.spawnSync(["chmod", "1777", sticky]).exitCode).toBe(0);
      chmodSync(parent, 0o700);
      const path = join(parent, "emails.db");

      getDatabase(path);

      expect(mode(path)).toBe(0o600);
    });

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      it("rejects a custom database parent owned by another uid", () => {
        const parent = join(root, "foreign-parent");
        mkdirSync(parent, { mode: 0o700 });
        chownSync(parent, 65534, 65534);

        expect(() => getDatabase(join(parent, "emails.db"))).toThrow(/owned|uid/i);
        expect(existsSync(join(parent, "emails.db"))).toBe(false);
      });

      it("rejects a non-writable custom database ancestor owned by another uid", () => {
        const ancestor = join(root, "foreign-ancestor");
        const parent = join(ancestor, "owned-parent");
        const path = join(parent, "emails.db");
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        chmodSync(parent, 0o700);
        chownSync(ancestor, 65534, 65534);
        chmodSync(ancestor, 0o555);

        expect(() => getDatabase(path)).toThrow(/ancestor.*owned|foreign uid/i);
        expect(existsSync(path)).toBe(false);
      });

      it("postinstall rejects a non-writable HOME ancestor owned by another uid", () => {
        const ancestor = join(root, "foreign-postinstall-ancestor");
        const home = join(ancestor, "home");
        mkdirSync(home, { recursive: true, mode: 0o700 });
        chmodSync(home, 0o700);
        chownSync(ancestor, 65534, 65534);
        chmodSync(ancestor, 0o555);

        const result = runPostinstall(home);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toMatch(/ancestor.*owned|foreign uid/i);
        expect(existsSync(join(home, ".hasna"))).toBe(false);
      });
    }

    it("rejects a symlink database artifact before touching its target", () => {
      const parent = join(root, "symlink");
      const target = join(root, "target.db");
      const path = join(parent, "emails.db");
      mkdirSync(parent, { mode: 0o755 });
      writeFileSync(target, "", { mode: 0o644 });
      chmodSync(target, 0o644);
      symlinkSync(target, path, "file");

      expect(() => getDatabase(path)).toThrow(/symbolic link|symlink/i);
      expect(mode(target)).toBe(0o644);
    });

    it("rejects non-regular database artifacts", () => {
      const parent = join(root, "non-regular");
      const path = join(parent, "emails.db");
      mkdirSync(path, { recursive: true, mode: 0o700 });

      expect(() => getDatabase(path)).toThrow(/regular file/i);
    });

    it("rejects a symlink sidecar before touching its target", () => {
      const parent = join(root, "symlink-sidecar");
      const target = join(root, "sidecar-target");
      const path = join(parent, "emails.db");
      mkdirSync(parent, { mode: 0o755 });
      writeFileSync(target, "unchanged", { mode: 0o644 });
      chmodSync(target, 0o644);
      symlinkSync(target, `${path}-wal`, "file");

      expect(() => getDatabase(path)).toThrow(/symbolic link|symlink/i);
      expect(readFileSync(target, "utf8")).toBe("unchanged");
      expect(mode(target)).toBe(0o644);
    });

    it("preserves a traversable custom parent while keeping SQLite artifacts at mode 0600", () => {
      const parent = join(root, "shared-traversable");
      const path = join(parent, "emails.db");
      mkdirSync(parent, { mode: 0o755 });
      chmodSync(parent, 0o755);

      const db = getDatabase(path);
      db.run("CREATE TABLE privacy_probe (id INTEGER PRIMARY KEY)");
      db.run("INSERT INTO privacy_probe DEFAULT VALUES");

      expect(mode(parent)).toBe(0o755);
      expect(mode(path)).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${path}${suffix}`;
        expect(existsSync(sidecar)).toBe(true);
        expect(mode(sidecar)).toBe(0o600);
      }
    });

    it("migrates legacy SQLite artifacts into private default directories and files", () => {
      const legacyDir = join(root, ".emails");
      mkdirSync(legacyDir, { mode: 0o755 });
      chmodSync(legacyDir, 0o755);
      for (const name of ["emails.db", "emails.db-wal", "emails.db-shm", "emails.db-journal"]) {
        const path = join(legacyDir, name);
        writeFileSync(path, name, { mode: 0o644 });
        chmodSync(path, 0o644);
      }

      const dataDir = getDataDir();

      const migratedNames = readdirSync(legacyDir).sort();
      expect([
        mode(join(root, ".hasna")),
        mode(dataDir),
        ...migratedNames.map((name) => mode(join(dataDir, name))),
      ]).toEqual([0o755, 0o700, ...migratedNames.map(() => 0o600)]);

      // Migration currently copies rather than renames. If the source remains,
      // it must no longer expose the same database artifacts.
      if (existsSync(legacyDir)) {
        expect([
          mode(legacyDir),
          ...migratedNames.map((name) => mode(join(legacyDir, name))),
        ]).toEqual([0o700, ...migratedNames.map(() => 0o600)]);
      }
    });

    it("ignores an unused legacy symlink once the new app directory exists", () => {
      const hasnaDir = join(root, ".hasna");
      const dataDir = join(hasnaDir, "emails");
      const legacyTarget = join(root, "legacy-target");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(hasnaDir, 0o755);
      chmodSync(dataDir, 0o700);
      mkdirSync(legacyTarget, { mode: 0o755 });
      symlinkSync(legacyTarget, join(root, ".emails"), "dir");

      expect(getDataDir()).toBe(dataDir);
      expect(readdirSync(legacyTarget)).toEqual([]);
    });

    it("preserves committed and WAL-resident rows through legacy migration", () => {
      const legacyDir = join(root, ".emails");
      const legacyPath = join(legacyDir, "emails.db");
      mkdirSync(legacyDir, { mode: 0o700 });
      const legacy = new BunDatabase(legacyPath);
      legacy.run("PRAGMA journal_mode = WAL");
      legacy.run("PRAGMA wal_autocheckpoint = 0");
      legacy.run("CREATE TABLE migration_probe (value TEXT NOT NULL)");
      legacy.run("INSERT INTO migration_probe VALUES ('preserved')");
      expect(existsSync(`${legacyPath}-wal`)).toBe(true);

      const dataDir = getDataDir();
      const migratedPath = join(dataDir, "emails.db");
      const migrated = new BunDatabase(migratedPath);
      try {
        expect(migrated.query("SELECT value FROM migration_probe").get()).toEqual({ value: "preserved" });
      } finally {
        migrated.close();
        legacy.close();
      }
      expect(mode(migratedPath)).toBe(0o600);
    });
  });
}

describe("SQLite in-memory path compatibility", () => {
  it("leaves the filesystem untouched for :memory:", () => {
    process.env.EMAILS_DB_PATH = ":memory:";
    process.chdir(root);

    const db = getDatabase();
    expect(db.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
    expect(readdirSync(root)).toEqual([]);
  });

  it("treats file::memory: as a literal private SQLite file under Bun", () => {
    process.env.EMAILS_DB_PATH = "file::memory:";
    process.chdir(root);

    expect(databaseFileExists()).toBe(false);
    const db = getDatabase();
    db.run("CREATE TABLE literal_file_probe (value INTEGER)");

    expect(databaseFileExists()).toBe(true);
    expect(existsSync(join(root, "file::memory:"))).toBe(true);
    if (process.platform !== "win32") expect(mode(join(root, "file::memory:"))).toBe(0o600);
  });
});
