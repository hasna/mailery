import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT_DIR = join(PKG_DIR, "..", "..");
const pkg = require(join(PKG_DIR, "package.json")) as {
  name: string;
  bin?: Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
  files?: string[];
  publishConfig?: { registry?: string; access?: string; provenance?: boolean };
};

const FORBIDDEN_PUBLIC_PACKAGE_TOKENS = [
  "registrar",
  "vendor",
  "provider + stored",
  "platform registrar",
  "spends real money",
  "shared infrastructure",
  "config/env",
  "MAILERY_DOMAIN_REGISTRATION_CONTACT",
  "spend-containment",
  "OpenDomains",
  "open-domains",
  "mailery-cloud",
  "Mailery Cloud",
];

describe("@hasna/mailery public package", () => {
  test("publishes the mailery binary and SDK subpath, not a mailery-cloud surface", () => {
    expect(pkg.name).toBe("@hasna/mailery");
    expect(pkg.bin?.mailery).toBe("dist/index.js");
    expect(pkg.bin?.["mailery-cloud"]).toBeUndefined();
    expect(pkg.exports?.["./sdk"]).toMatchObject({
      types: "./dist/sdk.d.ts",
      import: "./dist/sdk.js",
      default: "./dist/sdk.js",
    });
    expect(pkg.files).toContain("LICENSE");
    expect(pkg.files).toContain("NOTICE");
    expect(pkg.publishConfig).toEqual({
      registry: "https://registry.npmjs.org",
      access: "public",
      provenance: true,
    });
  });
});

describe("@hasna/mailery/sdk resolves under a real Node process", () => {
  let cleanDir: string | undefined;
  let globalDir: string | undefined;

  beforeAll(() => {
    const build = spawnSync("bun", ["run", "build"], { cwd: PKG_DIR, encoding: "utf8" });
    if (build.status !== 0) {
      throw new Error(`cli package build failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`);
    }
    cleanDir = mkdtempSync(join(tmpdir(), "mailery-cli-pack-"));
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", cleanDir], { cwd: PKG_DIR, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stdout ?? ""}\n${packed.stderr ?? ""}`);
    const tarball = readdirSync(cleanDir).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack did not create a tarball");
    const tarballPath = join(cleanDir, tarball);
    globalDir = join(cleanDir, "global");
    const globalInstall = spawnSync("npm", ["install", "--global", "--prefix", globalDir, "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { encoding: "utf8" });
    if (globalInstall.status !== 0) throw new Error(`clean global install failed:\n${globalInstall.stdout ?? ""}\n${globalInstall.stderr ?? ""}`);
    writeFileSync(join(cleanDir, "package.json"), JSON.stringify({ type: "module", private: true }));
    const localInstall = spawnSync("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", tarballPath], { cwd: cleanDir, encoding: "utf8" });
    if (localInstall.status !== 0) throw new Error(`clean project install failed:\n${localInstall.stdout ?? ""}\n${localInstall.stderr ?? ""}`);
  }, 30_000);

  test("a clean global install exposes the CLI/MCP executable", () => {
    const mailery = join(globalDir!, "bin", "mailery");
    expect(existsSync(mailery)).toBe(true);
    const help = spawnSync(mailery, ["--help"], { encoding: "utf8" });
    expect(`${help.stdout ?? ""}${help.stderr ?? ""}`).toContain("Email identity for agents");
    expect(help.status).toBe(0);
  });

  afterAll(() => {
    if (cleanDir) rmSync(cleanDir, { recursive: true, force: true });
  });

  test("built binary and SDK entrypoints exist", () => {
    expect(existsSync(join(PKG_DIR, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(PKG_DIR, "dist", "sdk.js"))).toBe(true);
    expect(existsSync(join(PKG_DIR, "dist", "sdk.d.ts"))).toBe(true);
    for (const declaration of ["client.d.ts", "endpoints.d.ts", "errors.d.ts", "types.d.ts"]) {
      expect(existsSync(join(PKG_DIR, "dist", declaration))).toBe(true);
    }
  });

  test("a clean TypeScript project can import the packed SDK", () => {
    writeFileSync(join(cleanDir!, "consumer.ts"), [
      'import { MaileryClient, type MaileryMessage } from "@hasna/mailery/sdk";',
      'const client = new MaileryClient({ baseUrl: "https://mailery.co" });',
      'declare const message: MaileryMessage;',
      'void client; void message;',
    ].join("\n"));
    const tsc = spawnSync(join(ROOT_DIR, "node_modules", ".bin", "tsc"), [
      "--noEmit",
      "--strict",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "consumer.ts",
    ], { cwd: cleanDir, encoding: "utf8" });
    expect(`${tsc.stdout ?? ""}${tsc.stderr ?? ""}`).toBe("");
    expect(tsc.status).toBe(0);
  });

  test("plain `node` can import the public SDK subpath", () => {
    const probe = [
      'import * as sdk from "@hasna/mailery/sdk";',
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

  test("public package README, SDK types, and CLI help stay product-level", () => {
    const help = spawnSync("node", [join(PKG_DIR, "dist", "index.js"), "domains", "--help"], {
      cwd: PKG_DIR,
      encoding: "utf8",
    });
    expect(help.status).toBe(0);

    const surfaces = [
      ["README.md", readFileSync(join(PKG_DIR, "README.md"), "utf8")],
      ["dist/sdk.d.ts", readFileSync(join(PKG_DIR, "dist", "sdk.d.ts"), "utf8")],
      ["domains help", `${help.stdout ?? ""}${help.stderr ?? ""}`],
    ] as const;

    for (const [surface, text] of surfaces) {
      for (const token of FORBIDDEN_PUBLIC_PACKAGE_TOKENS) {
        expect(text, `${surface} must not contain ${token}`).not.toContain(token);
      }
    }
  });
});
