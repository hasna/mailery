#!/usr/bin/env bun
// Regenerates the self_hosted API client from the serve's OpenAPI document.
//   bun run scripts/generate-selfhost-sdk.ts
// The output (src/selfhost.ts, exported as @hasna/emails/selfhost) is
// committed; CI can re-run this to verify it is in sync with openapi.ts.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSdkFromOpenApi } from "@hasna/contracts/sdk";
import { emailsSelfHostedOpenApi } from "../src/server/self-hosted/openapi.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const generated = generateSdkFromOpenApi(emailsSelfHostedOpenApi, {
  className: "EmailsSelfHostClient",
  apiKeyHeader: "x-api-key",
});
let secureClientCode = generated.code.replace(
  '    this.baseUrl = options.baseUrl.replace(/\\\/$/, "");',
  `    const parsedBaseUrl = new URL(options.baseUrl);
    const loopback = parsedBaseUrl.hostname === "localhost"
      || parsedBaseUrl.hostname === "127.0.0.1"
      || parsedBaseUrl.hostname === "[::1]"
      || parsedBaseUrl.hostname === "::1";
    if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && loopback)) {
      throw new Error("EmailsSelfHostClient requires HTTPS except for loopback development URLs.");
    }
    this.baseUrl = options.baseUrl.replace(/\\\/$/, "");`,
);
if (secureClientCode === generated.code) {
  throw new Error("generated SDK constructor shape changed; HTTPS policy was not injected");
}

function replaceRequired(source: string, needle: string, replacement: string, label: string): string {
  const updated = source.replace(needle, replacement);
  if (updated === source) throw new Error(`generated SDK shape changed; ${label} was not injected`);
  return updated;
}

secureClientCode = replaceRequired(
  secureClientCode,
  "  apiKey?: string;\n",
  "  apiKey?: string;\n  /** Opaque emss_ user session (or bearer-compatible API key). */\n  bearerToken?: string;\n",
  "bearer option",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "  private readonly apiKey: string | undefined;\n",
  "  private readonly apiKey: string | undefined;\n  private readonly bearerToken: string | undefined;\n",
  "bearer field",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    this.apiKey = options.apiKey;\n",
  "    this.apiKey = options.apiKey;\n    this.bearerToken = options.bearerToken;\n",
  "bearer assignment",
);
secureClientCode = replaceRequired(
  secureClientCode,
  '    if (this.apiKey) headers["x-api-key"] = this.apiKey;\n',
  '    if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;\n    else if (this.apiKey) headers["x-api-key"] = this.apiKey;\n',
  "bearer header",
);
secureClientCode = replaceRequired(
  secureClientCode,
  "    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload });\n",
  "    const response = await this.fetchImpl(url.toString(), { ...opts.init, method, headers, body: payload, redirect: \"error\" });\n",
  "redirect rejection",
);

const header = `// @generated from src/server/self-hosted/openapi.ts by scripts/generate-selfhost-sdk.ts — DO NOT EDIT.
// Regenerate: bun run scripts/generate-selfhost-sdk.ts
`;
const out = join(root, "src", "selfhost.ts");
writeFileSync(out, header + secureClientCode);
console.log(`wrote ${out}`);
console.log(`operations: ${generated.operations.map((o) => o.functionName).join(", ")}`);
if (generated.warnings.length) console.log(`warnings:\n  ${generated.warnings.join("\n  ")}`);
