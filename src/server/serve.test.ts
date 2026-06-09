import { describe, expect, it } from "bun:test";
import { join, resolve } from "path";
import { resolveDashboardStaticPath } from "./serve.js";

describe("resolveDashboardStaticPath", () => {
  const root = resolve("/tmp/open-emails-dashboard");

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

  it("rejects malformed escape sequences", () => {
    expect(resolveDashboardStaticPath(root, "/%E0%A4%A")).toBeNull();
  });
});
