import { ansi } from "./ansi.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export function formatDiagnostics(checks: DoctorCheck[]): string {
  const icons = { pass: ansi.green("\u2713"), warn: ansi.yellow("\u26A0"), fail: ansi.red("\u2717") };
  let output = ansi.bold("\n  Email System Diagnostics\n\n");
  for (const check of checks) {
    output += `  ${icons[check.status]} ${check.name}: ${check.message}\n`;
  }
  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  output += `\n  ${ansi.bold("Summary:")} ${ansi.green(passed + " passed")}`;
  if (warned) output += ` ${ansi.yellow(warned + " warnings")}`;
  if (failed) output += ` ${ansi.red(failed + " failed")}`;
  output += "\n";
  return output;
}
