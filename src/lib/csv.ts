export function parseCsv(content: string): Record<string, string>[] {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0]!.split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] || "";
    });
    return row;
  });
}
