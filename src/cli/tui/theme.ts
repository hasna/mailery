export type TuiThemeMode = "auto" | "light" | "dark";
export type ResolvedTuiThemeName = "light" | "dark";

export interface TuiTheme {
  name: ResolvedTuiThemeName;
  border: string;
  primary: string;
  secondary: string;
  muted: string;
  accent: string;
  accentStrong: string;
  ok: string;
  warning: string;
  error: string;
  activeFg: string;
  activeBg: string;
  sourceFg: string;
  sourceBg: string;
  selectedFg: string;
  selectedBg: string;
  unread: string;
  star: string;
  dimRead: string;
}

const LIGHT: TuiTheme = {
  name: "light",
  border: "blue",
  primary: "black",
  secondary: "gray",
  muted: "gray",
  accent: "blue",
  accentStrong: "blueBright",
  ok: "green",
  warning: "yellow",
  error: "red",
  activeFg: "white",
  activeBg: "blue",
  sourceFg: "white",
  sourceBg: "magenta",
  selectedFg: "white",
  selectedBg: "blue",
  unread: "blue",
  star: "yellow",
  dimRead: "gray",
};

const DARK: TuiTheme = {
  name: "dark",
  border: "cyan",
  primary: "white",
  secondary: "whiteBright",
  muted: "gray",
  accent: "cyan",
  accentStrong: "cyanBright",
  ok: "greenBright",
  warning: "yellowBright",
  error: "redBright",
  activeFg: "black",
  activeBg: "cyanBright",
  sourceFg: "black",
  sourceBg: "magentaBright",
  selectedFg: "whiteBright",
  selectedBg: "blue",
  unread: "cyanBright",
  star: "yellowBright",
  dimRead: "gray",
};

export function normalizeThemeMode(value: unknown): TuiThemeMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  return "auto";
}

function themeFromColorFgBg(value: string | undefined): ResolvedTuiThemeName | null {
  if (!value) return null;
  const parts = value.split(";").map((p) => Number.parseInt(p, 10)).filter((n) => Number.isFinite(n));
  const bg = parts.at(-1);
  if (bg === undefined) return null;
  if (bg === 7 || bg === 15) return "light";
  if ((bg >= 0 && bg <= 6) || bg === 8) return "dark";
  return null;
}

export function detectSystemTheme(env: Record<string, string | undefined> = process.env): ResolvedTuiThemeName {
  const forced = normalizeThemeMode(env["EMAILS_TUI_THEME"] ?? env["TUI_THEME"] ?? env["TERMINAL_THEME"]);
  if (forced === "light" || forced === "dark") return forced;

  const colorFgBg = themeFromColorFgBg(env["COLORFGBG"]);
  if (colorFgBg) return colorFgBg;

  const joined = [
    env["APPLE_INTERFACE_STYLE"],
    env["OS_APPEARANCE"],
    env["TERM_BACKGROUND"],
    env["GTK_THEME"],
    env["KDE_COLOR_SCHEME"],
    env["ITERM_PROFILE"],
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\b(dark|night|black)\b/.test(joined)) return "dark";
  if (/\b(light|day|white)\b/.test(joined)) return "light";
  return "light";
}

export function resolveThemeName(mode: TuiThemeMode = "auto", env: Record<string, string | undefined> = process.env): ResolvedTuiThemeName {
  return mode === "auto" ? detectSystemTheme(env) : mode;
}

export function resolveTheme(mode: TuiThemeMode = "auto", env: Record<string, string | undefined> = process.env): TuiTheme {
  return resolveThemeName(mode, env) === "dark" ? DARK : LIGHT;
}

export function nextThemeMode(mode: TuiThemeMode): TuiThemeMode {
  if (mode === "auto") return "light";
  if (mode === "light") return "dark";
  return "auto";
}
