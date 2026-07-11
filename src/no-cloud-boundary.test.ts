import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { normalizeEmailsMode } from "./lib/mode.js";
import { hostedControlPlaneFindings } from "../scripts/no-cloud-scan-lib.mjs";

const root = join(import.meta.dir, "..");
const roots = [
  ".github",
  "AGENTS.md",
  "Dockerfile",
  "Package.swift",
  "README.md",
  "Sources",
  "dashboard",
  "docker-compose.yml",
  "docs",
  "hasna.contract.json",
  "package.json",
  "sdk",
  "src",
  "web",
] as const;
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".swift", ".ts", ".tsx", ".yaml", ".yml"]);
const excluded = new Set(["src/no-cloud-boundary.test.ts", "src/no-cloud-artifact-scan.test.ts"]);

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return textExtensions.has(extname(path)) || path.endsWith("Dockerfile") ? [path] : [];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => entry === "node_modules" || entry === "dist" ? [] : files(join(path, entry)));
}

function scannedFiles(): string[] {
  return roots.flatMap((entry) => files(join(root, entry))).filter((path) => !excluded.has(relative(root, path)));
}

function hits(pattern: RegExp): string[] {
  return scannedFiles()
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .sort();
}

function activeHits(pattern: RegExp, allowedFiles: string[] = []): string[] {
  const allowed = new Set(allowedFiles);
  return scannedFiles()
    .filter((path) => !allowed.has(relative(root, path)))
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .sort();
}

describe("no hosted control plane", () => {
  it("ships exactly local and self_hosted modes without aliases", () => {
    expect(normalizeEmailsMode("local")).toBe("local");
    expect(normalizeEmailsMode("self_hosted")).toBe("self_hosted");
    for (const value of ["cloud", "remote", "hybrid", "self-hosted", "selfhosted"]) {
      expect(() => normalizeEmailsMode(value)).toThrow();
    }
  });

  it("has no SaaS client, command, export, package bin, or fleet env loader", () => {
    expect(existsSync(join(root, "src/cli/commands/cloud.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/mailery-cloud-client.ts"))).toBe(false);
    expect(existsSync(join(root, "src/lib/load-cloud-env.ts"))).toBe(false);
    expect(existsSync(join(root, "src/cli/commands/triage.ts"))).toBe(false);
    expect(existsSync(join(root, "src/mcp/tools/triage.ts"))).toBe(false);
    expect((pkg.exports as Record<string, unknown>)["./cloud"]).toBeUndefined();
    expect(Object.keys(pkg.bin)).toEqual(["emails", "emails-mcp", "emails-serve"]);
    expect(Object.keys(pkg.bin).some((name) => name.toLowerCase().includes("mailery"))).toBe(false);
  });

  it("contains no hosted endpoint, account, billing, tenant, credit, or upload contract", () => {
    expect(hits(/https?:\/\/(?:[^/]*\.)?(?:mailery\.co|emails\.hasna\.xyz)/i)).toEqual([]);
    expect(hits(/\/(?:api\/v1\/(?:auth\/(?:login|signup)|signup|billing|checkout|portal|tenants?|credits?)|auth\/(?:login|signup)|signup)\b/i)).toEqual([]);
    expect(hits(/\b(?:cloud_api_url|cloud_session_token|cloud_api_key|stripe_customer_id|tenant_id|credit_balance)\b/i)).toEqual([]);
    expect(hits(/\/api\/triage\b|register_agent|list_triaged|triage_stats|delete_triage/i)).toEqual([]);
    expect(hits(/\bhasna-xyz\b|\/hasna\/deploy\/|789877399345/i)).toEqual([]);
  });

  it("does not encode a removed mode in runtime or deployment configuration", () => {
    expect(hits(/(?:EMAILS|HASNA_EMAILS)_(?:STORAGE_)?MODE\s*[:=]\s*["']?(?:cloud|remote|hybrid)\b/i)).toEqual([]);
  });

  it("does not ship cloud AI provider clients or model-service credentials", () => {
    expect(activeHits(/@ai-sdk\/(?:cerebras|groq)|\b(?:GROQ|CEREBRAS)_API_KEY\b|\b(?:groq|cerebras)_api_key\b|api\.cerebras\.ai|api\.groq\.com/i)).toEqual([]);
  });

  it("contains no active SaaS, fleet, or cloud-prefixed implementation vocabulary", () => {
    const findings = scannedFiles()
      .filter((path) => !/\.test\.[cm]?[jt]sx?$/.test(path))
      .flatMap((path) => hostedControlPlaneFindings(readFileSync(path, "utf8"), relative(root, path))
        .map((reason) => `${relative(root, path)}: ${reason}`));
    expect(findings).toEqual([]);
  });
});
