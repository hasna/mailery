/** Parse a JSON array column, defaulting to [] on null or malformed content. */
export function parseJsonArray<T = unknown>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

/** Parse a JSON object column, defaulting to {} on null or malformed content. */
export function parseJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  json: string | null | undefined,
): T {
  if (!json) return {} as T;
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
  } catch {
    return {} as T;
  }
}
