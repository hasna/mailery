import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

describe("emails ui build contract", () => {
  it("keeps the main CLI external and builds a bundled TUI runtime", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const cliBuild = pkg.scripts["build:cli"] ?? "";
    const tuiRuntimeBuild = pkg.scripts["build:tui-runtime"] ?? "";
    const buildHelper = readFileSync(join(root, "scripts", "build-tui-runtime.ts"), "utf8");

    expect(cliBuild).toContain("--packages external");
    expect(cliBuild).toContain("--splitting");
    expect(cliBuild).not.toContain("--packages bundle");
    expect(tuiRuntimeBuild).toContain("scripts/build-tui-runtime.ts");
    expect(buildHelper).toContain("src/cli/tui/runtime.tsx");
    expect(buildHelper).toContain("ui-runtime-bundle.[ext]");
    expect(buildHelper).not.toContain("--packages external");
    expect(buildHelper).toContain('"@opentui/core-linux-arm64"');
    expect(buildHelper).toContain('"@opentui/core-darwin-arm64"');
  });

  it("runs the UI in alternate screen and keeps renderer cleanup on signal paths", () => {
    const source = readFileSync(join(root, "src", "cli", "tui", "runtime.tsx"), "utf8");

    expect(source).toContain('process.env["OTUI_USE_ALTERNATE_SCREEN"] = "true"');
    expect(source).toContain('screenMode: "alternate-screen"');
    expect(source).toContain("clearOnShutdown: true");
    expect(source).toContain("process.once(signal, handler)");
    expect(source).toContain("renderer?.destroy()");
    expect(source).not.toContain("process.exit(1)");
  });

  it("keeps the command module lightweight and defers OpenTUI imports to the runtime", () => {
    const source = readFileSync(join(root, "src", "cli", "commands", "ui.tsx"), "utf8");

    expect(source).toContain("ui-runtime-bundle.js");
    expect(source).toContain("../../../dist/cli/ui-runtime-bundle.js");
    expect(source).toContain("../tui/runtime.js");
    expect(source).not.toContain('from "@opentui/core"');
    expect(source).not.toContain('from "@opentui/react"');
    expect(source).not.toContain('from "react"');
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
