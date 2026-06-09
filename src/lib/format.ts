import { ansi } from "./ansi.js";

export function colorStatus(status: string): string {
  switch (status) {
    case "delivered": return ansi.green(status);
    case "bounced": case "complained": case "failed": return ansi.red(status);
    case "sent": return ansi.blue(status);
    case "pending": return ansi.yellow(status);
    default: return ansi.gray(status);
  }
}

export function colorDnsStatus(status: string): string {
  switch (status) {
    case "verified": return ansi.green("\u2713 " + status);
    case "pending": return ansi.yellow("\u25CB " + status);
    case "failed": return ansi.red("\u2717 " + status);
    default: return ansi.gray(status);
  }
}

export function colorProvider(active: boolean, text: string): string {
  return active ? ansi.green(text) : ansi.gray(text);
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + "\u2026";
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function padRight(str: string, len: number): string {
  // Account for ANSI escape codes in length
  const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
  return str + " ".repeat(Math.max(0, len - visibleLen));
}

export function tableRow(...cols: [string, number][]): string {
  return cols.map(([val, width]) => padRight(val, width)).join("  ");
}
