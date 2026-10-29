#!/usr/bin/env node
// Runs the TypeScript sources directly through tsx, so `npx` needs no build step.
import { resolve } from "node:path";
import { register } from "tsx/esm/api";
// --data DIR: test with your own facts (same layout as data/). Read here,
// before anything loads the test set.
const i = process.argv.indexOf("--data");
if (i > 0 && process.argv[i + 1])
  process.env.SAMEFACT_DATA = resolve(process.argv[i + 1]);
register();
await import("../src/cli.ts");
