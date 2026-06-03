#!/usr/bin/env bun
import { startServer } from "./serve.js";

const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3900;
const host = process.env["HOST"] ?? "127.0.0.1";
await startServer(port, host);
