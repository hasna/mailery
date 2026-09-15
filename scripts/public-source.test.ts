import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPublicSource } from "./check-public-source.js";

const root = resolve(import.meta.dir, "..");

function fixture(change: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "mailery-public-boundary-"));
  try {
    const allowed = JSON.parse(readFileSync(join(root, "public-source-files.json"), "utf8")) as string[];
    for (const name of allowed) {
      mkdirSync(resolve(directory, name, ".."), { recursive: true });
      cpSync(join(root, name), join(directory, name));
    }
    expect(() => checkPublicSource(directory)).not.toThrow();
    change(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("the complete isolated client tree and source imports pass", () => {
  expect(checkPublicSource(root).length).toBeGreaterThan(40);
});

test("an unexpected private file is rejected even outside the tarball", () => {
  fixture((directory) => {
    mkdirSync(join(directory, "src/server"), { recursive: true });
    writeFileSync(join(directory, "src/server/private.ts"), "export const privateServer = true;");
    expect(() => checkPublicSource(directory)).toThrow("unexpected public file");
  });
});

test("a provider import into an allowed client source file is rejected", () => {
  fixture((directory) => {
    const file = join(directory, "packages/cli/src/client.ts");
    writeFileSync(file, readFileSync(file, "utf8") + '\nimport "@aws-sdk/client-ses";\n');
    expect(() => checkPublicSource(directory)).toThrow("external client import");
  });
});

test("relative escapes and dynamic requires cannot bypass the boundary", () => {
  for (const code of ['import "../../../src/server/private.js";', 'const load = require; load("postgres");', 'await import("postgres");']) {
    fixture((directory) => {
      const file = join(directory, "packages/cli/src/client.ts");
      writeFileSync(file, readFileSync(file, "utf8") + "\n" + code + "\n");
      expect(() => checkPublicSource(directory)).toThrow();
    });
  }
});

test("public publisher and npm package cannot silently change identity", () => {
  fixture((directory) => {
    const file = join(directory, "packages/cli/package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.repository.url = "git+https://github.com/example/other.git";
    writeFileSync(file, JSON.stringify(pkg));
    expect(() => checkPublicSource(directory)).toThrow("public package identity");
  });
});

test("the public lock cannot include a private provider dependency", () => {
  fixture((directory) => {
    const file = join(directory, "bun.lock");
    writeFileSync(file, readFileSync(file, "utf8").replace('"packages": {', '"packages": {\n    "postgres": ["postgres@3.4.5"],'));
    expect(() => checkPublicSource(directory)).toThrow("public dependency lock");
  });
});

test("the publisher must restrict dispatch to protected main", () => {
  fixture((directory) => {
    const file = join(directory, ".github/workflows/publish-npm.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace(" && github.ref == 'refs/heads/main'", ""));
    expect(() => checkPublicSource(directory)).toThrow("public provenance workflow");
  });
});
