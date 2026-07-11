import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const commandsDir = join(import.meta.dir, "commands");
const cliEntry = join(import.meta.dir, "index.tsx");
const routerFile = join(import.meta.dir, "router.ts");

const heavyRuntimeImports = [
  "@opentui/core",
  "@opentui/keymap",
  "@opentui/solid",
  "@aws-sdk/",
  "@hasna/connectors",
  "pg",
  "solid-js",
  "../../lib/s3-sync.js",
  "../../lib/sync.js",
  "../../lib/inbound.js",
  "../../lib/send.js",
  "../../lib/batch.js",
  "../../lib/completion.js",
  "../../lib/doctor.js",
  "../../lib/delivery-doctor.js",
  "../../lib/health.js",
  "../../lib/agent-context.js",
  "../tui/App.js",
  "../tui/data.js",
  "../tui/autopull.js",
  "marked",
];

function commandFiles(): string[] {
  return readdirSync(commandsDir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .map((file) => join(commandsDir, file));
}

describe("CLI startup contract", () => {
  it("keeps command modules out of the CLI entrypoint static import graph", () => {
    const source = readFileSync(cliEntry, "utf8");
    const routerSource = readFileSync(routerFile, "utf8");
    const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;
    const offenders = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier.startsWith("./commands/") || specifier === "./utils.js" || specifier === "../lib/logger.js");

    expect(offenders).toEqual([]);
    expect(source).toContain('from "./router.js"');
    expect(source).toContain("registerCommandsForArgs");
    expect(source).toContain("await Promise.all");
    expect(source).toContain("await program.parseAsync([process.argv[0]");
    expect(routerSource).toContain("shouldPrintVersionEarly");
    expect(routerSource).toContain("commandModulesFor");
    expect(routerSource).toContain('case "provider": return ["provider", "sync"]');
    expect(routerSource).toContain("routeRootPromptArgs");
  });

  it("keeps heavy command dependencies behind action-local dynamic imports", () => {
    const offenders: string[] = [];
    const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

    for (const file of commandFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImport)) {
        const specifier = match[1] ?? "";
        if (heavyRuntimeImports.some((heavy) => specifier === heavy || specifier.startsWith(heavy))) {
          offenders.push(`${file.replace(`${commandsDir}/`, "")}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
