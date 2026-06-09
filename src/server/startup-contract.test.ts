import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routeModulesFor } from "./api-routes.js";

const routesDir = join(import.meta.dir, "routes");
const apiRoutesFile = join(import.meta.dir, "api-routes.ts");

const heavyRouteImports = [
  "@aws-sdk/",
  "@hasna/connectors",
  "mailparser",
  "../../lib/triage.js",
  "../../lib/send.js",
  "../../lib/sync.js",
  "../../lib/doctor.js",
  "../../lib/delivery-doctor.js",
  "../../lib/agent-context.js",
  "../../lib/gmail-sync.js",
  "../../lib/gmail-archive.js",
  "../../lib/s3-sync.js",
  "../../lib/aws-inbound.js",
  "../../lib/batch.js",
];

const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

function routeFiles(): string[] {
  return readdirSync(routesDir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file))
    .map((file) => join(routesDir, file));
}

describe("server startup contract", () => {
  it("keeps route modules lazy behind the API dispatcher", () => {
    const source = readFileSync(apiRoutesFile, "utf8");
    const staticRouteImports = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier.startsWith("./routes/"));

    expect(staticRouteImports).toEqual([]);
    expect(source).toContain("routeModulesFor");
    expect(source).toContain('import("./routes/core.js")');
    expect(source).toContain('import("./routes/contacts-groups.js")');
    expect(source).toContain('import("./routes/inbound-sequences.js")');
  });

  it("routes common server paths to the smallest route module set", () => {
    expect(routeModulesFor("/webhook/ses-inbound")).toEqual(["inbound-webhook"]);
    expect(routeModulesFor("/webhook/resend-inbound")).toEqual(["resend-webhook"]);
    expect(routeModulesFor("/api/v1/inbox")).toEqual(["agent-api"]);
    expect(routeModulesFor("/api/providers")).toEqual(["core"]);
    expect(routeModulesFor("/api/providers/abc/auth")).toEqual(["core"]);
    expect(routeModulesFor("/api/templates/welcome")).toEqual(["contacts-groups"]);
    expect(routeModulesFor("/api/sequences/abc/enrollments")).toEqual(["inbound-sequences"]);
    expect(routeModulesFor("/track/open/email-1")).toEqual(["inbound-sequences"]);
    expect(routeModulesFor("/api/unknown")).toEqual([
      "inbound-webhook",
      "resend-webhook",
      "agent-api",
      "core",
      "contacts-groups",
      "inbound-sequences",
    ]);
  });

  it("keeps heavy route dependencies behind route-local dynamic imports", () => {
    const offenders: string[] = [];

    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImport)) {
        const specifier = match[1] ?? "";
        if (heavyRouteImports.some((heavy) => specifier === heavy || specifier.startsWith(heavy))) {
          offenders.push(`${file.replace(`${routesDir}/`, "")}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
