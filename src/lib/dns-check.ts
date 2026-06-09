import { resolve } from "dns/promises";
import type { DnsRecord } from "../types/index.js";
import type { DnsCheckResult } from "./dns-check-format.js";

export { formatDnsCheck } from "./dns-check-format.js";
export type { DnsCheckResult } from "./dns-check-format.js";

export async function checkDnsRecords(
  _domain: string,
  expectedRecords: DnsRecord[],
): Promise<DnsCheckResult[]> {
  const results: DnsCheckResult[] = [];
  for (const record of expectedRecords) {
    try {
      const found = await resolve(
        record.name,
        record.type === "CNAME" ? "CNAME" : "TXT",
      );
      const foundFlat = (Array.isArray(found) ? found : [found]).flatMap((item: unknown) =>
        Array.isArray(item) ? item.map(String) : [String(item)]
      );
      const match = foundFlat.some(
        (f: string) => f.includes(record.value) || record.value.includes(f),
      );
      results.push({ record, expected: record.value, found: foundFlat, match });
    } catch {
      results.push({ record, expected: record.value, found: [], match: false });
    }
  }
  return results;
}
