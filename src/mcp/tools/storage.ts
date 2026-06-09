import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true as const,
  };
}

export function registerEmailStorageTools(server: McpServer): void {
  server.registerTool(
    "storage_status",
    {
      title: "Storage Status",
      description: "Show emails remote storage sync configuration and local sync history.",
      inputSchema: {},
    },
    async () => {
      const { getStorageStatus } = await import("../../db/storage-sync.js");
      return json(getStorageStatus());
    }
  );

  server.registerTool(
    "storage_push",
    {
      title: "Storage Push",
      description: "Push local emails data to remote PostgreSQL storage.",
      inputSchema: {
        tables: z.array(z.string()).optional(),
        batch_size: z.number().int().positive().max(5000).optional().describe("Rows to read per table batch"),
      },
    },
    async (args) => {
      try {
        const { storagePush } = await import("../../db/storage-sync.js");
        return json(await storagePush({ tables: args.tables, batchSize: args.batch_size }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "storage_pull",
    {
      title: "Storage Pull",
      description: "Pull emails data from remote PostgreSQL storage to local SQLite.",
      inputSchema: {
        tables: z.array(z.string()).optional(),
        batch_size: z.number().int().positive().max(5000).optional().describe("Rows to read per table batch"),
      },
    },
    async (args) => {
      try {
        const { storagePull } = await import("../../db/storage-sync.js");
        return json(await storagePull({ tables: args.tables, batchSize: args.batch_size }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "storage_sync",
    {
      title: "Storage Sync",
      description: "Bidirectional emails storage sync: pull then push.",
      inputSchema: {
        tables: z.array(z.string()).optional(),
        batch_size: z.number().int().positive().max(5000).optional().describe("Rows to read per table batch"),
      },
    },
    async (args) => {
      try {
        const { storageSync } = await import("../../db/storage-sync.js");
        return json(await storageSync({ tables: args.tables, batchSize: args.batch_size }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
