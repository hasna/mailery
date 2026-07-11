import { describe, expect, it } from "bun:test";
import { json, optionalQueryInteger, parseInteger, queryInteger, queryPage } from "./helpers.js";

describe("route integer parsing", () => {
  it("uses defaults for missing, empty, and invalid values", () => {
    expect(parseInteger(undefined, 20)).toBe(20);
    expect(parseInteger("", 20)).toBe(20);
    expect(parseInteger("nope", 20)).toBe(20);
  });

  it("truncates, clamps, and caps parsed values", () => {
    expect(parseInteger("12.9", 20)).toBe(12);
    expect(parseInteger("-10", 20, { min: 1 })).toBe(1);
    expect(parseInteger("10000", 20, { max: 1000 })).toBe(1000);
  });

  it("reads query integers consistently", () => {
    const url = new URL("http://127.0.0.1/api/emails?limit=0&offset=bad");
    expect(queryInteger(url, "limit", 50, { min: 1, max: 1000 })).toBe(1);
    expect(queryInteger(url, "missing", 50, { min: 1, max: 1000 })).toBe(50);
    expect(optionalQueryInteger(url, "offset", { min: 0 })).toBeUndefined();
    expect(optionalQueryInteger(url, "missing", { min: 0 })).toBeUndefined();
    expect(optionalQueryInteger(new URL("http://127.0.0.1/api/messages?priority=-2"), "priority", { min: 1 })).toBe(1);
  });

  it("builds bounded collection pages with defaults", () => {
    expect(queryPage(new URL("http://127.0.0.1/api/providers"), 50)).toEqual({ limit: 50, offset: 0 });
    expect(queryPage(new URL("http://127.0.0.1/api/providers?limit=0&offset=bad"), 50)).toEqual({ limit: 1, offset: 0 });
    expect(queryPage(new URL("http://127.0.0.1/api/providers?limit=5000&offset=2"), 50, 1000)).toEqual({ limit: 1000, offset: 2 });
  });
});

describe("route JSON responses", () => {
  it("does not emit wildcard CORS headers", async () => {
    const response = json({ ok: true });

    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });
});
