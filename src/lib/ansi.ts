function colorsEnabled(): boolean {
  if ("NO_COLOR" in process.env || process.env["FORCE_COLOR"] === "0") return false;
  if (process.env["FORCE_COLOR"] && process.env["FORCE_COLOR"] !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

function color(open: string, close = "\x1b[0m"): (text: string) => string {
  return (text: string) => colorsEnabled() ? `${open}${text}${close}` : text;
}

export const ansi = {
  blue: color("\x1b[34m"),
  bold: color("\x1b[1m", "\x1b[22m"),
  cyan: color("\x1b[36m"),
  cyanBright: color("\x1b[96m"),
  dim: color("\x1b[2m", "\x1b[22m"),
  gray: color("\x1b[90m"),
  green: color("\x1b[32m"),
  magenta: color("\x1b[35m"),
  magentaBright: color("\x1b[95m"),
  red: color("\x1b[31m"),
  redBright: color("\x1b[91m"),
  white: color("\x1b[37m"),
  yellow: color("\x1b[33m"),
};
