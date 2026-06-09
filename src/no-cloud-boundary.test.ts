import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const PRIVATE_CLOUD_PATTERNS = [
  /@hasna\/cloud\b/,
  /@hasna\/wallets\b/,
  /\bopen-cloud\b/,
] as const;

const SOURCE_ROOTS = [
  "AGENTS.md",
  "README.md",
  "docs",
  "sdk",
  "src",
] as const;

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return TEXT_EXTENSIONS.has(extension(path)) ? [path] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    if (entry === "dist" || entry === "node_modules") continue;
    files.push(...collectFiles(join(path, entry)));
  }
  return files;
}

function privateCloudHits(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of PRIVATE_CLOUD_PATTERNS) {
      if (pattern.test(text)) {
        hits.push(relative(root, file));
        break;
      }
    }
  }
  return hits.sort();
}

describe("no private cloud package boundary", () => {
  it("keeps package metadata and lockfiles free of private cloud packages", () => {
    const files = ["package.json", "bun.lock"]
      .map((file) => join(root, file))
      .filter((file) => existsSync(file));

    expect(privateCloudHits(files)).toEqual([]);
  });

  it("keeps runtime source, SDK, and docs off private cloud package names", () => {
    const files = SOURCE_ROOTS.flatMap((entry) => collectFiles(join(root, entry)));

    expect(privateCloudHits(files)).toEqual([]);
  });
});
