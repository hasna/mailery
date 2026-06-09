export interface VerifyResult {
  email: string;
  valid: boolean;
  reason: string;
  checks: {
    format: boolean;
    mx: boolean;
    smtp?: boolean;
  };
}

export function formatVerifyResult(result: VerifyResult): string {
  const icon = result.valid ? "✓" : "✗";
  const lines = [
    `${icon} ${result.email}: ${result.valid ? "valid" : "invalid"}`,
    `  Reason: ${result.reason}`,
    `  Format: ${result.checks.format ? "✓" : "✗"}  MX: ${result.checks.mx ? "✓" : "✗"}${result.checks.smtp !== undefined ? `  SMTP: ${result.checks.smtp ? "✓" : "✗"}` : ""}`,
  ];
  return lines.join("\n");
}
