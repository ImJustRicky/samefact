#!/usr/bin/env node
// The reference memory server over stdio, for any MCP client.
import { register } from "tsx/esm/api";
register();
process.env.SAMEFACT_MEMORY_MAIN = "1";
await import("../src/memory/server.ts");
