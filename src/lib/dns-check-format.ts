import { ansi } from "./ansi.js";
import type { DnsRecord } from "../types/index.js";

export interface DnsCheckResult {
  record: DnsRecord;
  expected: string;
  found: string[];
  match: boolean;
}

export function formatDnsCheck(results: DnsCheckResult[]): string {
  if (results.length === 0) return "No DNS records to check.\n";

  const cols = {
    type: Math.max(4, ...results.map((r) => r.record.type.length)),
    name: Math.max(4, ...results.map((r) => r.record.name.length)),
    expected: Math.max(8, ...results.map((r) => Math.min(r.expected.length, 50))),
    found: Math.max(5, ...results.map((r) => Math.min((r.found[0] || "—").length, 50))),
    status: 6,
  };

  const sep = `+${"-".repeat(cols.type + 2)}+${"-".repeat(cols.name + 2)}+${"-".repeat(cols.expected + 2)}+${"-".repeat(cols.found + 2)}+${"-".repeat(cols.status + 2)}+`;
  const header = `| ${"Type".padEnd(cols.type)} | ${"Name".padEnd(cols.name)} | ${"Expected".padEnd(cols.expected)} | ${"Found".padEnd(cols.found)} | ${"Status".padEnd(cols.status)} |`;

  const lines = [sep, header, sep];
  for (const r of results) {
    const expectedTrunc =
      r.expected.length > 50 ? r.expected.slice(0, 47) + "..." : r.expected;
    const foundStr = r.found.length > 0 ? r.found[0]! : "—";
    const foundTrunc =
      foundStr.length > 50 ? foundStr.slice(0, 47) + "..." : foundStr;
    const statusPadded = r.match
      ? "OK".padEnd(cols.status)
      : "MISS".padEnd(cols.status);
    const statusColored = r.match
      ? ansi.green(statusPadded)
      : ansi.red(statusPadded);

    lines.push(
      `| ${r.record.type.padEnd(cols.type)} | ${r.record.name.padEnd(cols.name)} | ${expectedTrunc.padEnd(cols.expected)} | ${foundTrunc.padEnd(cols.found)} | ${statusColored} |`,
    );
  }
  lines.push(sep);

  return lines.join("\n") + "\n";
}
