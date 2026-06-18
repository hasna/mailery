import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { resolveDashboardStaticPath } from "./serve.js";

describe("resolveDashboardStaticPath", () => {
  const root = resolve("/tmp/open-emails-dashboard");
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("maps dashboard routes inside the dashboard root", () => {
    expect(resolveDashboardStaticPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveDashboardStaticPath(root, "/index.html")).toBe(join(root, "index.html"));
    expect(resolveDashboardStaticPath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolveDashboardStaticPath(root, "/assets/../index.html")).toBe(join(root, "index.html"));
  });

  it("rejects decoded and encoded path traversal", () => {
    expect(resolveDashboardStaticPath(root, "/../secret.txt")).toBeNull();
    expect(resolveDashboardStaticPath(root, "/%2e%2e/secret.txt")).toBeNull();
    expect(resolveDashboardStaticPath(root, "/assets/%2e%2e/%2e%2e/secret.txt")).toBeNull();
  });

  it("maps clean page routes to matching html files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailery-dashboard-"));
    tempRoots.push(dir);
    writeFileSync(join(dir, "open-source.html"), "ok");
    expect(resolveDashboardStaticPath(dir, "/open-source")).toBe(join(dir, "open-source.html"));
  });

  it("rejects malformed escape sequences", () => {
    expect(resolveDashboardStaticPath(root, "/%E0%A4%A")).toBeNull();
  });

  it("ships Mailery dashboard branding and inbound controls", () => {
    const dashboardPath = resolve(import.meta.dir, "../../dashboard/index.html");
    const openSourcePath = resolve(import.meta.dir, "../../dashboard/open-source.html");
    const dashboard = readFileSync(dashboardPath, "utf8");
    expect(dashboard).toContain("<title>Mailery Dashboard</title>");
    expect(dashboard).toContain("openInboundFilter()");
    expect(dashboard).toContain("openInboundGroup()");
    expect(dashboard).toContain("openInboundDigest()");
    expect(dashboard).toContain("inbound-filter-summary");
    expect(dashboard).toContain("modal-inbound-digest");
    expect(dashboard).toContain("message-group-heading");
    expect(dashboard).toContain("Summary:");
    expect(existsSync(openSourcePath)).toBe(true);
    expect(dirname(openSourcePath)).toBe(dirname(dashboardPath));
  });
});
