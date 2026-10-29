import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AdapterSpec, Memory } from "./adapters";
import { call, chunks, connect, serverVersion, textOf } from "./mcp";

// Any MCP memory server, with no adapter code: find its store and search
// tools from their names and schemas, or take them from flags, and read
// whatever its search returns as a ranked list of texts.

type Tool = {
  name: string;
  description?: string;
  inputSchema: {
    properties?: Record<string, { type?: string; items?: { type?: string } }>;
    required?: string[];
  };
};

export type GenericOptions = {
  command: string;
  args: string[];
  name?: string;
  // "tool" or "tool.argument"; found automatically when left out.
  store?: string;
  search?: string;
  // Extra arguments merged into every call (JSON objects).
  storeExtra?: Record<string, unknown>;
  searchExtra?: Record<string, unknown>;
  env?: Record<string, string>;
};

const STORE_NAMES = [
  /remember/,
  /add_?memor/,
  /save/,
  /store/,
  /write/,
  /add_?note/,
  /create_?memor/,
  /insert/,
  /add/,
];
const SEARCH_NAMES = [
  /recall/,
  /search_?memor/,
  /search/,
  /query/,
  /retrieve/,
  /find/,
  /lookup/,
];
const TEXT_ARGS =
  /^(notes?|texts?|contents?|memor(y|ies)|facts?|messages?|documents?|data|input|value|observation)s?$/i;
const QUERY_ARGS = /^(query|q|question|text|search|query_?texts?|prompt)$/i;

const isString = (p?: { type?: string }) => p?.type === "string";
const isStrings = (p?: { type?: string; items?: { type?: string } }) =>
  p?.type === "array" && p.items?.type === "string";

function pickTool(
  tools: Tool[],
  patterns: RegExp[],
  fits: (t: Tool) => string | undefined,
) {
  for (const re of patterns)
    for (const t of tools) {
      if (!re.test(t.name.toLowerCase())) continue;
      const arg = fits(t);
      if (arg) return { tool: t.name, arg };
    }
  return undefined;
}

/** The argument a store tool takes text in: prefer an array (batches). */
function storeArg(t: Tool) {
  const props = Object.entries(t.inputSchema.properties ?? {});
  return (
    props.find(([k, p]) => isStrings(p) && TEXT_ARGS.test(k))?.[0] ??
    props.find(([k, p]) => isString(p) && TEXT_ARGS.test(k))?.[0] ??
    props.find(([, p]) => isStrings(p))?.[0] ??
    props.find(([, p]) => isString(p))?.[0]
  );
}

function searchArg(t: Tool) {
  const props = Object.entries(t.inputSchema.properties ?? {});
  return (
    props.find(
      ([k, p]) => (isString(p) || isStrings(p)) && QUERY_ARGS.test(k),
    )?.[0] ?? props.find(([, p]) => isString(p))?.[0]
  );
}

const parseSpec = (spec: string) => {
  const [tool, arg] = spec.split(".");
  return { tool: tool!, arg };
};

/**
 * A search result as a ranked list of texts: the first JSON array of
 * results found (each item's strings joined), else blocks of plain text.
 */
export function resultsFrom(text: string): string[] {
  const strings = (x: unknown): string[] =>
    typeof x === "string"
      ? [x]
      : Array.isArray(x)
        ? x.flatMap(strings)
        : x && typeof x === "object"
          ? Object.values(x).flatMap(strings)
          : [];
  try {
    const json = JSON.parse(text) as unknown;
    const queue: unknown[] = [json];
    while (queue.length) {
      const x = queue.shift();
      if (Array.isArray(x) && x.length && Array.isArray(x[0]) && x.length === 1)
        queue.push(x[0]);
      else if (Array.isArray(x) && x.length)
        return x.map((i) => strings(i).join(" "));
      else if (x && typeof x === "object") queue.push(...Object.values(x));
    }
    return [];
  } catch {
    return text
      .split(/\n\s*\n|\n(?=\s*(?:\d+[.)]|[-*•])\s)/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

/** "npx -y @acme/memory-mcp" → "@acme/memory-mcp": the package, not the launcher. */
export function defaultName(command: string, args: string[]) {
  const launchers = /(^|\/)(npx|uvx|pnpx|bunx|uv|npm|node|python3?|deno)$/;
  if (!launchers.test(command)) return command.split("/").at(-1)!;
  const valueFlags = new Set([
    "-p",
    "--package",
    "--from",
    "--with",
    "--python",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith("-") || a === "run" || a === "exec") continue;
    return a
      .split("/")
      .at(-1)!
      .replace(/\.(m?js|ts|py)$/, "");
  }
  return command.split("/").at(-1)!;
}

/** A create_entities(entities[{name, entityType, observations}]) + search_nodes(query) server. */
function knowledgeGraph(tools: Tool[]) {
  const create = tools.find((t) => t.name === "create_entities");
  const search = tools.find((t) => t.name === "search_nodes");
  if (!create?.inputSchema.properties?.entities || !search) return undefined;
  return { create: create.name, search: search.name };
}

// Entity names are letters only, so they can never match a numeric answer.
const letters = (n: number) => {
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

function kgMemory(
  client: Client,
  kg: { create: string; search: string },
  name: string,
): Memory {
  process.stderr.write(
    `[${name}] knowledge graph: ${kg.create}(entities) · ${kg.search}(query)\n`,
  );
  let n = 0;
  return {
    version: serverVersion(client),
    name,
    search: kg.search,
    async store(texts) {
      for (const chunk of chunks(texts, 100))
        await call(client, kg.create, {
          entities: chunk.map((text) => ({
            name: `note-${letters(n++)}`,
            entityType: "note",
            observations: [text],
          })),
        });
    },
    async find(query) {
      const text = textOf(await call(client, kg.search, { query }));
      try {
        const graph = JSON.parse(text) as {
          entities?: { observations?: string[] }[];
        };
        return (graph.entities ?? [])
          .map((e) => (e.observations ?? []).join(" "))
          .slice(0, 5);
      } catch {
        return resultsFrom(text).slice(0, 5);
      }
    },
    close: () => client.close(),
  };
}

export function genericAdapter(o: GenericOptions): AdapterSpec {
  const id = o.name ?? defaultName(o.command, o.args);
  return {
    id,
    async start(): Promise<Memory> {
      const client: Client = await connect(o.command, o.args, o.env);
      const { tools } = (await client.listTools()) as { tools: Tool[] };
      // Knowledge-graph servers (the MCP reference memory and its forks)
      // store entities with observations, not plain text.
      const kg = !o.store && knowledgeGraph(tools);
      if (kg) return kgMemory(client, kg, o.name ?? id);
      const store = o.store
        ? (() => {
            const s = parseSpec(o.store!);
            const t = tools.find((x) => x.name === s.tool);
            return { tool: s.tool, arg: s.arg ?? (t && storeArg(t)) };
          })()
        : pickTool(tools, STORE_NAMES, storeArg);
      const search = o.search
        ? (() => {
            const s = parseSpec(o.search!);
            const t = tools.find((x) => x.name === s.tool);
            return { tool: s.tool, arg: s.arg ?? (t && searchArg(t)) };
          })()
        : pickTool(tools, SEARCH_NAMES, searchArg);
      const names = tools.map((t) => t.name).join(", ");
      if (!store?.arg)
        throw new Error(
          `No store tool found among: ${names}. Pass --store tool.argument.`,
        );
      if (!search?.arg)
        throw new Error(
          `No search tool found among: ${names}. Pass --search tool.argument.`,
        );
      const storeTool = tools.find((t) => t.name === store.tool)!;
      const batch = isStrings(storeTool.inputSchema.properties?.[store.arg!]);
      const searchTool = tools.find((t) => t.name === search.tool)!;
      const listQuery = isStrings(
        searchTool.inputSchema.properties?.[search.arg!],
      );
      process.stderr.write(
        `[${id}] store: ${store.tool}(${store.arg}${batch ? "[]" : ""}) · search: ${search.tool}(${search.arg})\n`,
      );
      return {
        version: serverVersion(client),
        name: o.name ?? id,
        search: `${search.tool}`,
        async store(texts) {
          if (batch) {
            for (const chunk of chunks(texts, 100))
              await call(client, store.tool, {
                ...o.storeExtra,
                [store.arg!]: chunk,
              });
          } else {
            for (const text of texts)
              await call(client, store.tool, {
                ...o.storeExtra,
                [store.arg!]: text,
              });
          }
        },
        async find(query) {
          const text = textOf(
            await call(client, search.tool, {
              ...o.searchExtra,
              [search.arg!]: listQuery ? [query] : query,
            }),
          );
          return resultsFrom(text).slice(0, 5);
        },
        close: () => client.close(),
      };
    },
  };
}
