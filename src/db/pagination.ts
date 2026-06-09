export function safeLimit(value: number | null | undefined, fallback = 50): number {
  if (value === undefined || value === null) return fallback;
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

export function safeOptionalLimit(value: number | null | undefined, fallback = 50): number | null {
  if (value === undefined || value === null) return null;
  return safeLimit(value, fallback);
}

export function safeOffset(value: number | null | undefined): number {
  if (value === undefined || value === null) return 0;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function cappedLimit(value: number | null | undefined, fallback: number, max: number): number {
  return Math.min(max, safeLimit(value, fallback));
}
