import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

type SyncResult = { table: string; errors?: string[] };

function assertNoSyncErrors(results: SyncResult[]): void {
  const failures = results.filter((result) => (result.errors?.length ?? 0) > 0);
  if (failures.length === 0) return;
  throw new Error(`Storage sync failed for ${failures.map((result) => `${result.table}: ${(result.errors ?? []).join("; ")}`).join(" | ")}`);
}

function assertNoBidirectionalSyncErrors(result: { pull: SyncResult[]; push: SyncResult[] }): void {
  assertNoSyncErrors(result.pull);
  assertNoSyncErrors(result.push);
}

export function registerEmailStorageTools(server: McpServer): void {
  server.tool(
    "storage_status",
    "Show Mailery self-hosted storage sync configuration and local sync history.",
    {
    },
    async () => {
      const { getStorageStatus } = await import("../../db/storage-sync.js");
      return json(getStorageStatus());
    }
  );

  server.tool(
    "storage_push",
    "Push local Mailery data to self-hosted PostgreSQL storage.",
    {
      tables: z.array(z.string()).optional(),
      batch_size: z.number().int().positive().max(5000).optional().describe("Rows to read per table batch"),
    },
    async (args) => {
      const { storagePush } = await import("../../db/storage-sync.js");
      const results = await storagePush({ tables: args.tables, batchSize: args.batch_size });
      assertNoSyncErrors(results);
      return json(results);
    }
  );

  server.tool(
    "storage_pull",
    "Pull Mailery data from self-hosted PostgreSQL storage to local SQLite.",
    {
      tables: z.array(z.string()).optional(),
      batch_size: z.number().int().positive().max(5000).optional().describe("Rows to read per table batch"),
    },
    async (args) => {
      const { storagePull } = await import("../../db/storage-sync.js");
      const results = await storagePull({ tables: args.tables, batchSize: args.batch_size });
      assertNoSyncErrors(results);
      return json(results);
    }
  );

  server.tool(
    "storage_sync",
    "Force bidirectional Mailery storage sync: pull then push.",
    {
      tables: z.array(z.string()).optional(),
      batch_size: z.number().int().positive().max(5000).optional().describe("Rows to read per table batch"),
      force: z.boolean().describe("Must be true because sync pulls before pushing and can overwrite local rows"),
    },
    async (args) => {
      const { storageSync } = await import("../../db/storage-sync.js");
      const result = await storageSync({ tables: args.tables, batchSize: args.batch_size, force: args.force });
      assertNoBidirectionalSyncErrors(result);
      return json(result);
    }
  );
}
