// Packaging guard: the private internal @hasna/mailery-sdk-internal package must be importable under
// plain Node (the README promises `npm i` + a bare `import` on Node 18+). The
// bug this guards against: pointing main/module/types/exports at raw
// `./src/index.ts`, which Node cannot parse and whose `./client.js`-style
// re-exports do not exist as .js under src/. Node-visible entry points must
// therefore resolve to the built ./dist/*.js output.
//
// Two layers:
//   1. Static — assert package.json's Node-facing entries point at dist (.js /
//      .d.ts) and that NOTHING Node reads points at a raw .ts file.
//   2. Dynamic — build the package, then in a clean throwaway dir resolve it by
//      package name under a real `node` process (Node ignores the "bun"
//      condition, so this exercises exactly what an `npm i` consumer gets) and
//      confirm `MaileryClient` is a usable export.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const pkg = require(join(PKG_DIR, "package.json")) as {
  name: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, Record<string, string>>;
};

describe("@hasna/mailery-sdk-internal packaging (Node-importable)", () => {
  test("no Node-facing entry point references a raw .ts source file", () => {
    const nodeFacing: Array<[string, string | undefined]> = [
      ["main", pkg.main],
      ["module", pkg.module],
      ["types", pkg.types],
      ["exports['.'].types", pkg.exports?.["."]?.types],
      ["exports['.'].import", pkg.exports?.["."]?.import],
      ["exports['.'].require", pkg.exports?.["."]?.require],
      ["exports['.'].default", pkg.exports?.["."]?.default],
    ];
    // Raw TypeScript source (.ts) is unparseable by Node; .d.ts (types only) is fine.
    const rawTs = nodeFacing.filter(
      ([, v]) => typeof v === "string" && v.endsWith(".ts") && !v.endsWith(".d.ts"),
    );
    expect(rawTs).toEqual([]);
  });

  test("runtime + type entries point at built ./dist output", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.module).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    const dot = pkg.exports?.["."] ?? {};
    expect(dot.types).toBe("./dist/index.d.ts");
    expect(dot.import).toBe("./dist/index.js");
    expect(dot.default).toBe("./dist/index.js");
  });

  // Optional source-first resolution for the in-repo Bun workspace: Bun honors
  // the "bun" condition and runs TypeScript directly, so consumers here don't
  // need a build. Node never sees this condition, so it can't break Node import.
  test("the optional bun condition (if present) resolves to source", () => {
    const bunCond = pkg.exports?.["."]?.bun;
    if (bunCond !== undefined) expect(bunCond).toBe("./src/index.ts");
  });
});

describe("@hasna/mailery-sdk-internal resolves under a real Node process", () => {
  let cleanDir: string | undefined;

  beforeAll(() => {
    // Build the published artifact so the import target actually exists.
    const build = spawnSync("bun", ["run", "build"], { cwd: PKG_DIR, encoding: "utf8" });
    if (build.status !== 0) {
      throw new Error(`sdk build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`);
    }
    // A throwaway package whose node_modules symlinks back to the SDK, so Node's
    // own resolver (honoring package.json "exports") picks the entry point — the
    // same Node resolver path the public CLI bundle uses during build tests.
    cleanDir = mkdtempSync(join(tmpdir(), "mailery-sdk-pack-"));
    const [scopeName, packageName] = pkg.name.split("/");
    const scope = join(cleanDir, "node_modules", scopeName);
    mkdirSync(scope, { recursive: true });
    symlinkSync(PKG_DIR, join(scope, packageName), "dir");
    writeFileSync(join(cleanDir, "package.json"), JSON.stringify({ type: "module", private: true }));
  });

  afterAll(() => {
    if (cleanDir) rmSync(cleanDir, { recursive: true, force: true });
  });

  test("dist/index.js and its re-exported .js files exist", () => {
    for (const f of ["index.js", "client.js", "errors.js", "endpoints.js", "types.js"]) {
      expect(existsSync(join(PKG_DIR, "dist", f))).toBe(true);
    }
  });

  test("plain `node` can import the package by name and use MaileryClient", () => {
    const probe = [
      'import * as sdk from "@hasna/mailery-sdk-internal";',
      'if (typeof sdk.MaileryClient !== "function") { console.error("no MaileryClient export"); process.exit(3); }',
      'const c = new sdk.MaileryClient({ baseUrl: "https://mailery.co" });',
      'if (typeof c.send !== "function") { console.error("client missing send()"); process.exit(4); }',
      'if (typeof sdk.MaileryError !== "function") { console.error("no MaileryError export"); process.exit(5); }',
      'console.log("NODE-IMPORT-OK");',
    ].join("\n");
    const res = spawnSync("node", ["--input-type=module", "-e", probe], {
      cwd: cleanDir,
      encoding: "utf8",
    });
    expect(`${res.stderr ?? ""}${res.stdout ?? ""}`).toContain("NODE-IMPORT-OK");
    expect(res.status).toBe(0);
  });
});
