import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as emails from "./index.js";

const root = join(import.meta.dir, "..");
const staticHeavyImport = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["'](?:@aws-sdk\/|@hasna\/connectors|mailparser|pg|resend|chalk|@opentui\/|react(?:\/|["']))/m;
const staticRuntimeReexport = /^\s*export\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;
const lazyRootModules = [
  "./lib/send.js",
  "./lib/sync.js",
  "./lib/batch.js",
  "./lib/doctor.js",
  "./lib/health.js",
  "./lib/dns-check.js",
  "./lib/email-verify.js",
  "./lib/triage.js",
  "./lib/cerebras.js",
  "./lib/forwarding.js",
];

function runBuild(args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["bun", "build", ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bun build failed (${args.join(" ")}):\n${result.stdout.toString()}\n${result.stderr.toString()}`);
  }
}

describe("public package entrypoint", () => {
  it("exports the documented library API surface", () => {
    for (const name of [
      "sendWithFailover",
      "createProvider",
      "listProviders",
      "listProviderSummaries",
      "createDomain",
      "listDomains",
      "createAddress",
      "listInboundEmails",
      "listInboundEmailSummaries",
      "getInboundEmailSummary",
      "getInboundAttachmentPaths",
      "setInboundReadSummary",
      "setInboundArchivedSummary",
      "setInboundStarredSummary",
      "addInboundLabelSummary",
      "removeInboundLabelSummary",
      "listReplySummaries",
      "getReceivedInboundCount",
      "getLatestReceivedInboundAt",
      "storeInboundEmail",
      "createTemplate",
      "listTemplateSummaries",
      "renderTemplate",
      "upsertContact",
      "suppressContact",
      "createSequence",
      "addStep",
      "enroll",
      "getMember",
      "listMemberSummaries",
      "getEvent",
      "listEventSummaries",
      "exportEmailsJson",
      "exportEventsCsv",
      "createOwner",
      "setAddressOwnerByRef",
      "createSendKey",
      "listSendKeySummaries",
      "listSendKeySummariesByOwners",
      "assertSendAuthorized",
      "createForwardingRule",
      "listForwardingRules",
      "processForwardingRules",
      "extractEmailLinks",
      "formatEmailLinks",
      "buildReadOnlyMaileryTools",
      "runMaileryAgent",
      "formatMaileryAgentResult",
      "resolveMaileryAgentDefaults",
      "getInboundAttachmentStorageConfig",
      "getDefaultGmailArchiveS3Bucket",
      "getDefaultGmailArchiveS3Region",
      "getDefaultGmailArchiveS3Prefix",
      "getGmailArchiveConfig",
      "buildGmailArchiveKeys",
      "uploadGmailArchive",
      "uploadGmailArchiveAttachment",
      "uploadGmailArchiveManifest",
      "verifyGmailArchive",
      "migrateS3Prefix",
      "listSandboxEmailSummaries",
      "listScheduledEmailSummaries",
      "listTriagedSummaries",
    ]) {
      expect(typeof (emails as Record<string, unknown>)[name]).toBe("function");
    }
    expect(emails.CANONICAL_OPEN_EMAILS_S3_BUCKET).toBeNull();
    for (const storageInternal of ["PG_MIGRATIONS", "PgAdapterAsync", "storagePush", "storagePull", "storageSync"]) {
      expect((emails as Record<string, unknown>)[storageInternal]).toBeUndefined();
    }
  });

  it("exposes storage internals from the explicit storage subpath", async () => {
    const storage = await import("./storage.js");
    const migrations = await import("./db/pg-migrations.js");

    expect((storage as Record<string, unknown>).PG_MIGRATIONS).toBeUndefined();
    expect(Array.isArray(migrations.PG_MIGRATIONS)).toBe(true);
    expect(typeof storage.PgAdapterAsync).toBe("function");
    expect(typeof storage.getStorageStatus).toBe("function");
    expect(typeof storage.storagePush).toBe("function");
    expect(typeof storage.storagePull).toBe("function");
    expect(typeof storage.storageSync).toBe("function");
  });

  it("keeps build outputs lean by externalizing installed runtime packages", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const buildCommands = [
      scripts["build:cli"] ?? "",
      scripts["build:mcp"] ?? "",
      scripts["build:server"] ?? "",
      scripts["build:lib"] ?? "",
      scripts["build:pg-migrations"] ?? "",
    ].filter((command) => command.includes("bun build"));
    const tuiRuntimeBuild = scripts["build:tui-runtime"] ?? "";

    expect(buildCommands).toHaveLength(5);
    expect(buildCommands.every((command) => command.includes("--packages external"))).toBe(true);
    expect(buildCommands.every((command) => command.includes("--splitting"))).toBe(true);
    expect(tuiRuntimeBuild).toContain("scripts/build-tui-runtime.ts");
  });

  it("keeps operational root APIs behind lazy implementation imports", () => {
    const source = readFileSync(join(root, "src/index.ts"), "utf8");
    const offenders = [...source.matchAll(staticRuntimeReexport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => lazyRootModules.includes(specifier));

    expect(offenders).toEqual([]);
    for (const specifier of lazyRootModules) {
      expect(source).toContain(`await import("${specifier}")`);
    }
  });

  it("keeps packaged entry artifacts free of static heavy-package imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "emails-entry-build-"));
    try {
      const cliDir = join(dir, "cli");
      const rootDir = join(dir, "root");

      runBuild(["src/cli/index.tsx", "--outdir", cliDir, "--target", "bun", "--packages", "external", "--splitting"]);
      runBuild(["src/index.ts", "src/storage.ts", "--outdir", rootDir, "--target", "bun", "--packages", "external", "--splitting"]);

      const rootEntry = readFileSync(join(rootDir, "index.js"), "utf8");
      for (const entry of [join(cliDir, "index.js"), join(rootDir, "index.js")]) {
        expect(readFileSync(entry, "utf8")).not.toMatch(staticHeavyImport);
      }
      expect(rootEntry).not.toMatch(/^\s*import\s+[\s\S]*?\s+from\s+["']chalk["'];/m);
      for (const storageInternal of ["PG_MIGRATIONS", "PgAdapterAsync", "storagePush", "storagePull", "storageSync"]) {
        expect(rootEntry).not.toContain(storageInternal);
      }
      const storageEntry = readFileSync(join(rootDir, "storage.js"), "utf8");
      expect(storageEntry).toContain("storagePush");
      expect(storageEntry).not.toContain("var PG_MIGRATIONS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
