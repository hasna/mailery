import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg, { type Pool } from "pg";

import { closeSelfHostedPool, getSelfHostedPool } from "../server/self-hosted/env.js";
import { createPgPool, createSelfHostedPoolFromEnv } from "./pool.js";

interface EffectiveConnectionParameters {
  ssl: unknown;
  sslnegotiation?: string;
  application_name?: string;
}

const pools: Pool[] = [];
const temporaryDirectories: string[] = [];

function caFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "emails-pool-ca-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "bundle.pem");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function effectiveConnectionParameters(pool: Pool): EffectiveConnectionParameters {
  const client = new pg.Client(pool.options) as pg.Client & {
    connectionParameters: EffectiveConnectionParameters;
  };
  return client.connectionParameters;
}

afterEach(async () => {
  await closeSelfHostedPool();
  for (const pool of pools.splice(0)) await pool.end();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("effective pg TLS configuration", () => {
  test("an explicit sslmode=disable remains effective after URL sanitization", () => {
    const pool = createPgPool({
      connectionString: "postgresql://emails:password@db.example/emails?sslmode=disable",
    });
    pools.push(pool);

    expect(effectiveConnectionParameters(pool).ssl).toBe(false);
  });

  test("sslmode=require cannot overwrite the explicit verified CA object", () => {
    const pool = createPgPool({
      connectionString:
        "postgresql://emails:password@db.example/emails?sslmode=require&application_name=operator",
      ca: "RDS CA",
    });
    pools.push(pool);

    expect(pool.options.connectionString).toBe(
      "postgresql://emails:password@db.example/emails?application_name=operator",
    );
    expect(effectiveConnectionParameters(pool).ssl).toEqual({
      rejectUnauthorized: true,
      ca: "RDS CA",
    });
  });

  test("verify-full and direct negotiation retain the explicit CA in pg.Client", () => {
    const pool = createPgPool({
      connectionString:
        "postgresql://emails:password@db.example/emails?sslmode=verify-full&sslnegotiation=direct",
      ca: "RDS CA",
    });
    pools.push(pool);

    const effective = effectiveConnectionParameters(pool);
    expect(effective.ssl).toEqual({ rejectUnauthorized: true, ca: "RDS CA" });
    expect(effective.sslnegotiation).toBe("direct");
  });

  test("the reusable self-hosted pool factory has the same effective TLS contract", () => {
    const result = createSelfHostedPoolFromEnv("emails", {
      env: {
        EMAILS_MODE: "self_hosted",
        EMAILS_DATABASE_URL: "postgresql://emails:password@db.example/emails?sslmode=verify-full",
      },
      ca: "RDS CA",
    });
    pools.push(result.client.pool);

    expect(effectiveConnectionParameters(result.client.pool).ssl).toEqual({
      rejectUnauthorized: true,
      ca: "RDS CA",
    });
  });

  test("the shared migration and runtime pool keeps the verified CA effective", () => {
    const result = getSelfHostedPool({
      EMAILS_MODE: "self_hosted",
      EMAILS_DATABASE_URL: "postgresql://emails:password@db.example/emails?sslmode=require",
      EMAILS_DATABASE_CA_FILE: caFile("RDS CA"),
      EMAILS_API_SIGNING_KEY: "a-signing-key-that-is-at-least-32-characters",
    });

    const effective = effectiveConnectionParameters(result.client.pool);
    expect(effective.ssl).toEqual({ rejectUnauthorized: true, ca: "RDS CA" });
    expect(effective.application_name).toBe("emails-serve");
  });
});
