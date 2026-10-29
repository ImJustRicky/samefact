import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Talking to MCP servers over stdio, shared by every adapter.

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * This process's environment without npm's own settings: run under npx,
 * those (npm_config_package and friends) would make a server started
 * with npx run samefact again instead of itself.
 */
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !/^npm_/i.test(k),
    ),
  ) as Record<string, string>;
}

export async function connect(
  command: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...cleanEnv(), ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "samefact", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

/** The text of a tool result, joined. */
export function textOf(result: unknown) {
  const content =
    (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
}

export const CALL_TIMEOUT_MS = 10 * 60_000;

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  // Some memories do slow work per call (Mem0 runs an LLM on every note),
  // so allow up to 10 minutes instead of the SDK's 60-second default.
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  if ((result as { isError?: boolean }).isError)
    throw new Error(`${name} failed: ${textOf(result).slice(0, 300)}`);
  return result;
}

export const chunks = <T>(xs: T[], size: number) =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) =>
    xs.slice(i * size, i * size + size),
  );

/** uvx, for Python servers: on PATH, or in a local .venv. */
export function findUvx() {
  try {
    execFileSync("uvx", ["--version"], { stdio: "ignore" });
    return "uvx";
  } catch {
    const local = join(ROOT, ".venv/bin/uvx");
    return existsSync(local) ? local : undefined;
  }
}

/** "name 1.2.3" as the server introduced itself. */
export function serverVersion(client: Client) {
  const v = client.getServerVersion();
  return v ? `${v.name} ${v.version}` : undefined;
}
