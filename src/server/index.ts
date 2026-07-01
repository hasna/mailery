#!/usr/bin/env bun
import { assertRemoteRuntimeSupported } from "../lib/remote-runtime-guard.js";
import pkg from "../../package.json" with { type: "json" };

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: mailery-serve [options]

Options:
  --host <host>      Host to bind to (default: 127.0.0.1)
  --port <port>      Port to listen on (default: 3900)
  -V, --version      output the version number
  -h, --help         display help`);
  process.exit(0);
}

assertRemoteRuntimeSupported("mailery-serve");
const { installSelfHostedRuntimeShutdownHooks, startSelfHostedRuntimeCache } = await import("../lib/self-hosted-runtime.js");
await startSelfHostedRuntimeCache({ source: "mailery-serve" });
installSelfHostedRuntimeShutdownHooks({ source: "mailery-serve", cleanupCache: true });
const { startServer } = await import("./serve.js");
const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3900;
const host = process.env["HOST"] ?? "127.0.0.1";
await startServer(port, host);
