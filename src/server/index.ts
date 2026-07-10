#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { resolveEmailsMode } from "../lib/mode.js";
import { resolveServerBindOptions } from "./bind-options.js";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: emails-serve [command] [options]

Runs the Emails HTTP service (or a background worker).

Commands:
  (default)          Run the HTTP service:
                       - self_hosted mode (EMAILS_MODE=self_hosted +
                         EMAILS_DATABASE_URL + EMAILS_API_SIGNING_KEY):
                         the operator-owned Postgres API
                         (GET /health, /ready, /version and the API-key
                         authenticated /v1 surface), binding 0.0.0.0.
                       - local mode (default): the SQLite dashboard on 127.0.0.1.
  ingest-worker      Run the SES-inbound ingestion worker: long-poll the SQS
                     queue (EMAILS_INGEST_QUEUE_URL), fetch each archived raw
                     message from S3, and write it to self-hosted Postgres.

Options:
  --host <host>      Host to bind to
  --port <port>      Port to listen on (default: self_hosted 8080 / local 3900)
  -V, --version      output the version number
  -h, --help         display help`);
  process.exit(0);
}

const mode = resolveEmailsMode().mode;

if (args[0] === "ingest-worker") {
  const { runIngestWorker } = await import("./self-hosted/ingest-worker.js");
  await runIngestWorker();
} else if (mode === "self_hosted") {
  const { startSelfHostedServer } = await import("./self-hosted/serve.js");
  const { port, host } = resolveServerBindOptions(args, process.env, mode);
  await startSelfHostedServer(pkg.version, port, host);
} else {
  const { startServer } = await import("./serve.js");
  const { port, host } = resolveServerBindOptions(args, process.env, mode);
  await startServer(port, host);
}
