import { describe, expect, it } from "bun:test";
import { detectSystemTheme, nextThemeMode, normalizeThemeMode, resolveTheme, resolveThemeName } from "./theme.js";

describe("tui theme", () => {
  it("defaults to light when no system signal is available", () => {
    expect(detectSystemTheme({})).toBe("light");
    expect(resolveThemeName("auto", {})).toBe("light");
    expect(resolveTheme("auto", {}).name).toBe("light");
  });

  it("detects dark and light terminal backgrounds from COLORFGBG", () => {
    expect(detectSystemTheme({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectSystemTheme({ COLORFGBG: "0;15" })).toBe("light");
  });

  it("allows explicit environment theme overrides", () => {
    expect(resolveThemeName("auto", { EMAILS_TUI_THEME: "dark" })).toBe("dark");
    expect(resolveThemeName("auto", { TUI_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
  });

  it("normalizes and cycles persisted theme modes", () => {
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("weird")).toBe("auto");
    expect(nextThemeMode("auto")).toBe("light");
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("auto");
  });
});
