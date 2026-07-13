#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: emails-serve [command] [options]

Runs the Emails self-hosted HTTP service (or a background worker).

Commands:
  (default)          Run the self-hosted HTTP service: the operator-owned
                     Postgres API (GET /health, /ready, /version and the
                     API-key authenticated /v1 surface), binding 0.0.0.0.
                     Requires EMAILS_DATABASE_URL + EMAILS_API_SIGNING_KEY.
  ingest-worker      Run the SES-inbound ingestion worker: long-poll the SQS
                     queue (EMAILS_INGEST_QUEUE_URL), fetch each archived raw
                     message from S3, and write it to self-hosted Postgres.
  ingest-s3-backfill One-shot repair/backfill: list EMAILS_INGEST_S3_BUCKET /
                     EMAILS_INGEST_S3_PREFIX and ingest existing raw objects.

Options:
  --host <host>      Host to bind to (default: 0.0.0.0)
  --port <port>      Port to listen on (default: 8080)
  -V, --version      output the version number
  -h, --help         display help`);
  process.exit(0);
}

if (args[0] === "ingest-worker") {
  const { runIngestWorker } = await import("./self-hosted/ingest-worker.js");
  await runIngestWorker();
} else if (args[0] === "ingest-s3-backfill") {
  const { runIngestS3Backfill } = await import("./self-hosted/ingest-worker.js");
  await runIngestS3Backfill();
} else {
  const { startSelfHostedServer } = await import("./self-hosted/serve.js");
  const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 8080;
  const host = process.env["HOST"] ?? "0.0.0.0";
  await startSelfHostedServer(pkg.version, port, host);
}
