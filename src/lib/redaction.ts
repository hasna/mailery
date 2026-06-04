const REDACTED = "***";

const SENSITIVE_KEY_PARTS = [
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "secret_key",
  "secretkey",
  "secret",
  "password",
  "token",
  "refresh_token",
  "access_token",
  "client_secret",
  "private_key",
  "credential",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]/g, "_")
    .toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function shouldRedactValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) && shouldRedactValue(nested)
      ? REDACTED
      : redactSecrets(nested);
  }
  return out as T;
}

