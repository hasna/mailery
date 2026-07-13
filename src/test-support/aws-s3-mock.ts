// Shared @aws-sdk/client-s3 mock for the test suite.
//
// WHY THIS EXISTS: bun's `mock.module` is PROCESS-GLOBAL and a module namespace is
// cached at its FIRST dynamic import — re-registering a different shape later (even
// in a `beforeEach`) does NOT take effect; the first-resolved namespace wins for
// the whole process. Multiple files exercise code that dynamically imports
// "@aws-sdk/client-s3" (src/lib/aws-inbound.ts via setupInboundEmail, and
// src/lib/aws-inbound-ingest.ts via ensureInboundIngestPipeline). If each test file
// registered its OWN incompatible s3 mock, whichever loaded last won the single
// cached namespace and the other file's source saw the wrong shape (e.g. a missing
// GetBucketNotificationConfigurationCommand → "undefined is not a constructor").
//
// FIX: register ONE superset namespace here whose `S3Client.send` delegates to a
// mutable, per-test handler. Every file that needs the s3 mock imports THIS module
// and sets its own handler in `beforeEach`. The namespace never changes (so the
// cache is never a problem) — only the behavior behind `send` does. No secret is
// ever logged; this is test scaffolding only.

import { mock } from "bun:test";

export interface S3Command {
  /** Command name without the "Command" suffix, e.g. "GetBucketPolicy". */
  __type: string;
  input: Record<string, unknown>;
}

export type S3SendHandler = (cmd: S3Command) => unknown | Promise<unknown>;

const inertHandler: S3SendHandler = async () => ({});
let handler: S3SendHandler = inertHandler;

/** Set the S3 `send` behavior for the current test. Call in `beforeEach`. */
export function setS3SendHandler(next: S3SendHandler): void {
  handler = next;
}

/** Restore the inert default handler (returns `{}` for any command). */
export function resetS3SendHandler(): void {
  handler = inertHandler;
}

// A command class whose instance `.constructor.name` is the given command name
// (for constructor.name dispatch) AND whose `.__type` is the name minus the
// "Command" suffix (for __type dispatch). A computed property name makes the
// anonymous class inherit `name`.
function makeCommand(name: string): new (input?: Record<string, unknown>) => S3Command {
  const type = name.replace(/Command$/, "");
  const holder = {
    [name]: class {
      input: Record<string, unknown>;
      __type = type;
      constructor(input: Record<string, unknown> = {}) {
        this.input = input;
      }
    },
  };
  return holder[name] as unknown as new (input?: Record<string, unknown>) => S3Command;
}

// Superset of every @aws-sdk/client-s3 command any test's source path constructs.
const COMMAND_NAMES = [
  // aws-inbound.ts — bucket setup + S3 sync
  "CreateBucketCommand",
  "PutBucketPolicyCommand",
  "PutPublicAccessBlockCommand",
  "PutBucketVersioningCommand",
  "PutBucketEncryptionCommand",
  "PutObjectCommand",
  "HeadBucketCommand",
  "HeadObjectCommand",
  "ListObjectsV2Command",
  "GetObjectCommand",
  "CopyObjectCommand",
  // aws-inbound-ingest.ts — bucket notifications + policy merge
  "GetBucketNotificationConfigurationCommand",
  "PutBucketNotificationConfigurationCommand",
  "GetBucketPolicyCommand",
] as const;

function buildModule(): Record<string, unknown> {
  const mod: Record<string, unknown> = {
    S3Client: class {
      async send(cmd: S3Command): Promise<unknown> {
        return handler(cmd);
      }
    },
  };
  for (const name of COMMAND_NAMES) mod[name] = makeCommand(name);
  return mod;
}

// Register the shared namespace as soon as this module is imported by any test
// file. Idempotent across importers (same factory, identical shape).
mock.module("@aws-sdk/client-s3", buildModule);
