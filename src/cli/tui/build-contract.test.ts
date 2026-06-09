import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

describe("emails ui build contract", () => {
  it("keeps React and OpenTUI packages external in the CLI build", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: { build: string };
    };
    const cliBuild = pkg.scripts.build
      .split("&&")
      .map((segment) => segment.trim())
      .find((segment) => segment.includes("bun build src/cli/index.tsx")) ?? "";

    expect(cliBuild).toContain("--packages external");
    expect(cliBuild).toContain("--splitting");
    expect(cliBuild).not.toContain("--packages bundle");
  });

  it("runs the UI in alternate screen and keeps renderer cleanup on signal paths", () => {
    const source = readFileSync(join(root, "src", "cli", "commands", "ui.tsx"), "utf8");

    expect(source).toContain('process.env["OTUI_USE_ALTERNATE_SCREEN"] = "true"');
    expect(source).toContain('screenMode: "alternate-screen"');
    expect(source).toContain("clearOnShutdown: true");
    expect(source).toContain("process.once(signal, handler)");
    expect(source).toContain("renderer?.destroy()");
    expect(source).not.toContain("process.exit(1)");
  });

  it("keeps send/provider runtime code out of the initial TUI data graph", () => {
    const source = readFileSync(join(root, "src", "cli", "tui", "data.ts"), "utf8");
    const offenders = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier === "../../lib/send.js" || specifier.startsWith("../../lib/send.js"));

    expect(offenders).toEqual([]);
    expect(source).toContain('await import("../../lib/send.js")');
  });
});
