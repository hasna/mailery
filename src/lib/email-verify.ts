import { resolve } from "dns/promises";
import { createConnection } from "net";
import type { VerifyResult } from "./email-verify-format.js";

export { formatVerifyResult } from "./email-verify-format.js";
export type { VerifyResult } from "./email-verify-format.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function verifyEmailAddress(
  email: string,
  opts: { smtpProbe?: boolean; timeoutMs?: number } = {},
): Promise<VerifyResult> {
  const { smtpProbe = false, timeoutMs = 5000 } = opts;

  // 1. Format check
  if (!EMAIL_REGEX.test(email)) {
    return { email, valid: false, reason: "Invalid email format", checks: { format: false, mx: false } };
  }

  const domain = email.split("@")[1]!;

  // 2. MX record check
  let mxRecords: string[] = [];
  try {
    const records = await Promise.race([
      resolve(domain, "MX"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), timeoutMs)),
    ]) as { exchange: string; priority: number }[];
    mxRecords = records.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
  } catch {
    return { email, valid: false, reason: `No MX records for domain ${domain}`, checks: { format: true, mx: false } };
  }

  if (mxRecords.length === 0) {
    return { email, valid: false, reason: `No MX records for domain ${domain}`, checks: { format: true, mx: false } };
  }

  if (!smtpProbe) {
    return { email, valid: true, reason: `MX records found for ${domain}`, checks: { format: true, mx: true } };
  }

  // 3. SMTP probe (RCPT TO without sending)
  const smtpHost = mxRecords[0]!;
  try {
    const smtpResult = await smtpProbeCheck(email, smtpHost, timeoutMs);
    return {
      email,
      valid: smtpResult.valid,
      reason: smtpResult.reason,
      checks: { format: true, mx: true, smtp: smtpResult.valid },
    };
  } catch {
    // SMTP probe failed — still valid based on MX
    return { email, valid: true, reason: `MX valid, SMTP probe skipped`, checks: { format: true, mx: true, smtp: undefined } };
  }
}

async function smtpProbeCheck(
  email: string,
  host: string,
  timeoutMs: number,
): Promise<{ valid: boolean; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMTP timeout")), timeoutMs);

    const socket = createConnection({ host, port: 25 });
    let state = "connect";
    let buffer = "";

    const send = (line: string) => socket.write(line + "\r\n");

    socket.on("connect", () => {});
    socket.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const code = parseInt(line.slice(0, 3));
        if (state === "connect" && code === 220) {
          state = "ehlo";
          send(`EHLO open-emails-verify`);
        } else if (state === "ehlo" && (code === 250)) {
          state = "mail";
          send(`MAIL FROM:<verify@open-emails.local>`);
        } else if (state === "mail" && code === 250) {
          state = "rcpt";
          send(`RCPT TO:<${email}>`);
        } else if (state === "rcpt") {
          clearTimeout(timer);
          send("QUIT");
          socket.destroy();
          if (code >= 200 && code < 400) {
            resolve({ valid: true, reason: `SMTP accepted RCPT TO (${code})` });
          } else {
            resolve({ valid: false, reason: `SMTP rejected RCPT TO: ${line}` });
          }
          return;
        } else if (code >= 500) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ valid: false, reason: `SMTP error: ${line}` });
          return;
        }
      }
    });

    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
