export type TuiThemeMode = "auto" | "light" | "dark";
export type ResolvedTuiThemeName = "light" | "dark";

export interface TuiTheme {
  name: ResolvedTuiThemeName;
  background: string;
  panel: string;
  panelAlt: string;
  headerBg: string;
  sidebarBg: string;
  sidebarFg: string;
  sidebarMuted: string;
  metricBg: string;
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
  background: "#ffffff",
  panel: "#fafafa",
  panelAlt: "#f5f5f5",
  headerBg: "#fafafa",
  sidebarBg: "#fafafa",
  sidebarFg: "#1a1a1a",
  sidebarMuted: "#8a8a8a",
  metricBg: "#f5f5f5",
  border: "#d4d4d4",
  primary: "#1a1a1a",
  secondary: "#8a8a8a",
  muted: "#8a8a8a",
  accent: "#7b5bb6",
  accentStrong: "#3b7dd8",
  ok: "#3d9a57",
  warning: "#d68c27",
  error: "#d1383d",
  activeFg: "#ffffff",
  activeBg: "#3b7dd8",
  sourceFg: "#ffffff",
  sourceBg: "#3b7dd8",
  selectedFg: "#ffffff",
  selectedBg: "#3b7dd8",
  unread: "#3b7dd8",
  star: "#d68c27",
  dimRead: "#8a8a8a",
};

const DARK: TuiTheme = {
  name: "dark",
  background: "#0a0a0a",
  panel: "#141414",
  panelAlt: "#1e1e1e",
  headerBg: "#141414",
  sidebarBg: "#141414",
  sidebarFg: "#eeeeee",
  sidebarMuted: "#808080",
  metricBg: "#1e1e1e",
  border: "#3c3c3c",
  primary: "#eeeeee",
  secondary: "#808080",
  muted: "#808080",
  accent: "#5c9cf5",
  accentStrong: "#fab283",
  ok: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
  activeFg: "#0a0a0a",
  activeBg: "#fab283",
  sourceFg: "#0a0a0a",
  sourceBg: "#fab283",
  selectedFg: "#0a0a0a",
  selectedBg: "#fab283",
  unread: "#5c9cf5",
  star: "#f5a742",
  dimRead: "#808080",
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

export function resolveThemeName(
  mode: TuiThemeMode = "auto",
  env: Record<string, string | undefined> = process.env,
  detected?: ResolvedTuiThemeName | null,
): ResolvedTuiThemeName {
  return mode === "auto" ? detected ?? detectSystemTheme(env) : mode;
}

export function resolveTheme(
  mode: TuiThemeMode = "auto",
  env: Record<string, string | undefined> = process.env,
  detected?: ResolvedTuiThemeName | null,
): TuiTheme {
  return resolveThemeName(mode, env, detected) === "dark" ? DARK : LIGHT;
}

export function nextThemeMode(mode: TuiThemeMode): TuiThemeMode {
  if (mode === "auto") return "light";
  if (mode === "light") return "dark";
  return "auto";
}
