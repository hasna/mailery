#!/usr/bin/env node
// mailery bin entry. Hosted mailery.co CLI + MCP server
// (mailery.co). See ./program.ts for the command surface.

import { runCli } from "./program.js";

runCli(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
