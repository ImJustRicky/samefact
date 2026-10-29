import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  call,
  chunks,
  connect,
  findUvx,
  ROOT,
  serverVersion,
  textOf,
} from "./mcp";

/** uv's cache directory, as uv itself reports it. */
const uvCacheDir = () =>
  process.env.UV_CACHE_DIR ??
  execFileSync(findUvx()!.replace(/uvx$/, "uv"), ["cache", "dir"], {
    encoding: "utf8",
  }).trim();

// The built-in memory servers. Each starts fresh (its own empty
// storage), stores sentences and searches, returning results best first
// as plain text. Adapters call only the server's own public tools, with
// no titles, tags or ids that would leak an answer, and pass the query
// they're given straight to the server's search tool. Which query is sent
// (the question as asked, or the one an agent wrote) is the harness's
// choice and is reported as its own column. Any other MCP server can be
// tested with no code: see src/generic.ts.

export type Memory = {
  name: string;
  // What its search does, in a few words, for the results table.
  search: string;
  // Stores texts; batched where the server's tool takes several. With
  // `ordered: false` the order among them doesn't matter (adapters may
  // store them concurrently); otherwise store them in the order given.
  store(texts: string[], opts?: { ordered: boolean }): Promise<void>;
  find(query: string): Promise<string[]>;
  close(): Promise<void>;
  // What the server reports about itself on connect.
  version?: string;
  // Notes the server said it couldn't store (when it reports that).
  storeFailures?: () => number;
  // A copy of its storage that `startFrom` can open (slow servers only).
  snapshot?: () => Promise<string>;
};

// "asked": the question exactly as the person wrote it.
// "agent": the search query an assistant wrote for it.
export type QueryStyle = "asked" | "agent";

export type AdapterSpec = {
  id: string;
  // Why it can't run here, if it can't (e.g. no uvx).
  unavailable?: () => string | undefined;
  start: () => Promise<Memory>;
  // Start from a snapshot instead of empty, to skip storing again what an
  // earlier run already stored.
  startFrom?: (snapshot: string) => Promise<Memory>;
};

const TOP = 5;

const STOP = new Set(
  "a an the is are was were be been am i me my mine we our us you your he she it its they them their what which who whom whose when where why how do does did can could should would will shall may might must to of in on at for from by with about as into over under up down out off and or but if then than so just still that this these those there here have has had get got go going any some all each every no not own just very what's who's i'm".split(
    " ",
  ),
);

/** Content words of a query, lowercased, without punctuation. */
export function keywords(question: string) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** A fixed pseudo-random number per text, for neutral tie-breaking. */
const tie = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

const needUvx = () =>
  findUvx() ? undefined : "needs uv (https://docs.astral.sh/uv/)";

/**
 * The reference server from the MCP project: a knowledge graph in a JSON
 * file. search_nodes matches one substring against names, types and
 * observations, so any query longer than a word or two finds nothing.
 * To give it a fair chance, the adapter searches each content word of
 * the query on its own and ranks entities by how many words hit; ties
 * are broken by a fixed hash of the text, not by when it was stored.
 */
export const officialMemory: AdapterSpec = {
  id: "mcp-server-memory",
  async start() {
    const dir = mkdtempSync(join(tmpdir(), "samefact-kg-"));
    const client = await connect(
      "npx",
      ["-y", "@modelcontextprotocol/server-memory"],
      { MEMORY_FILE_PATH: join(dir, "memory.jsonl") },
    );
    let n = 0;
    const search = async (q: string) => {
      const text = textOf(await call(client, "search_nodes", { query: q }));
      const graph = JSON.parse(text) as {
        entities: { name: string; observations: string[] }[];
      };
      return graph.entities.map((e) => ({
        name: e.name,
        text: e.observations.join(" "),
      }));
    };
    return {
      version: serverVersion(client),
      name: "Official MCP memory (knowledge graph)",
      search: "substring match",
      async store(texts) {
        for (const chunk of chunks(texts, 100)) {
          await call(client, "create_entities", {
            entities: chunk.map((text) => ({
              name: `memory-${++n}`,
              entityType: "memory",
              observations: [text],
            })),
          });
        }
      },
      async find(query) {
        const hits = new Map<string, { text: string; score: number }>();
        for (const word of keywords(query)) {
          for (const e of await search(word)) {
            const seen = hits.get(e.name) ?? { text: e.text, score: 0 };
            seen.score += 1;
            hits.set(e.name, seen);
          }
        }
        return [...hits.values()]
          .sort((a, b) => b.score - a.score || tie(a.text) - tie(b.text))
          .map((h) => h.text)
          .slice(0, TOP);
      },
      close: () => client.close(),
    };
  },
};

/**
 * basic-memory: notes in Markdown files with SQLite search, run as its
 * current release through uvx with its own HOME (never the real one).
 * Search uses its default mode: hybrid full-text and vector search
 * (bge-small-en-v1.5), which needs Python 3.12 for its vector extension.
 */
export const basicMemory: AdapterSpec = {
  id: "basic-memory",
  unavailable: needUvx,
  async start() {
    const home = mkdtempSync(join(tmpdir(), "samefact-bm-"));
    const client = await connect(
      findUvx()!,
      ["--python", "3.12", "basic-memory==0.24.1", "mcp"],
      // Its own HOME for its notes and config, but uv's real cache, so
      // uv doesn't reinstall it (on another Python) for every run.
      { HOME: home, UV_CACHE_DIR: uvCacheDir() },
    );
    let n = 0;
    return {
      version: serverVersion(client),
      name: "basic-memory",
      search: "hybrid (full-text + bge-small vectors)",
      async store(texts) {
        // One note at a time: concurrent writes contend on its SQLite
        // file and were three times slower.
        for (const text of texts)
          await call(client, "write_note", {
            title: `memory ${++n}`,
            content: text,
            directory: "memories",
            project: "main",
          });
      },
      async find(query) {
        const text = textOf(
          await call(client, "search_notes", {
            query,
            page_size: TOP,
            project: "main",
            output_format: "json",
          }),
        );
        return parseBasicMemory(text).slice(0, TOP);
      },
      close: () => client.close(),
    };
  },
};

/** basic-memory answers in JSON or Markdown depending on version. */
export function parseBasicMemory(text: string): string[] {
  try {
    const json = JSON.parse(text) as {
      results?: { content?: string; matched_chunk?: string; title?: string }[];
    };
    if (Array.isArray(json.results))
      return json.results.map(
        // The note's text only: titles are ours ("memory 112") and could
        // otherwise match a numeric answer.
        (r) => r.matched_chunk ?? r.content ?? "",
      );
  } catch {
    // Not JSON: fall through to sections.
  }
  if (/no results/i.test(text)) return [];
  return text
    .split(/\n(?=#{1,3} |\d+\. )/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Chroma: a vector database; documents are embedded with its default
 * model (all-MiniLM-L6-v2) and searched by similarity. Run through uvx
 * on Python 3.12 (its pinned MCP library needs pydantic below 2.11).
 */
export const chroma: AdapterSpec = {
  id: "chroma-mcp",
  unavailable: needUvx,
  async start() {
    const client = await connect(findUvx()!, [
      "--python",
      "3.12",
      "--with",
      "pydantic<2.11",
      "chroma-mcp==0.2.6",
      "--client-type",
      "ephemeral",
    ]);
    await call(client, "chroma_create_collection", {
      collection_name: "memories",
    });
    let n = 0;
    return {
      version: serverVersion(client),
      name: "Chroma (vector search)",
      search: "embeddings (MiniLM)",
      async store(texts) {
        for (const chunk of chunks(texts, 200)) {
          await call(client, "chroma_add_documents", {
            collection_name: "memories",
            documents: chunk,
            ids: chunk.map(() => `m${++n}`),
          });
        }
      },
      async find(query) {
        const text = textOf(
          await call(client, "chroma_query_documents", {
            collection_name: "memories",
            query_texts: [query],
            n_results: TOP,
          }),
        );
        const json = JSON.parse(text) as { documents?: (string | null)[][] };
        return (json.documents?.[0] ?? []).filter(
          (d): d is string => typeof d === "string",
        );
      },
      close: () => client.close(),
    };
  },
};

/**
 * samefact-memory: the reference server in src/memory. Meaning search
 * plus replaced-fact tracking; no LLM, no account.
 */
const reference = (
  id: string,
  name: string,
  search: string,
  env: Record<string, string>,
): AdapterSpec => ({
  id,
  async start() {
    // Its own launcher registers tsx, so this works from any folder.
    const client = await connect(
      process.execPath,
      [join(ROOT, "bin/samefact-memory.mjs")],
      env,
    );
    return {
      version: serverVersion(client),
      name,
      search,
      async store(texts) {
        for (const chunk of chunks(texts, 500))
          await call(client, "remember", { notes: chunk });
      },
      async find(query) {
        const json = JSON.parse(
          textOf(await call(client, "recall", { query, limit: TOP })),
        ) as { results: { text: string }[] };
        return json.results.map((r) => r.text);
      },
      close: () => client.close(),
    };
  },
});

export const samefactMemory = reference(
  "samefact-memory",
  "samefact-memory (reference)",
  "embeddings + replaces old facts",
  {},
);

// The reference server with one part changed, to show what each does.
export const ABLATIONS: AdapterSpec[] = [
  reference(
    "ablation-store-time-only",
    "reference, store-time check only (v0.3)",
    "embeddings + store-time replacing",
    { SAMEFACT_RESOLVE: "0" },
  ),
  reference(
    "ablation-words-rule",
    "reference, change-word rule (v0.2)",
    "embeddings + change words",
    { SAMEFACT_RULE: "words" },
  ),
  reference("ablation-no-replace", "reference, replacing off", "embeddings", {
    SAMEFACT_REPLACE: "0",
  }),
  reference(
    "ablation-hybrid",
    "reference, hybrid search",
    "embeddings + BM25 + replaces",
    { SAMEFACT_SEARCH: "hybrid" },
  ),
  reference(
    "ablation-hybrid-no-replace",
    "reference, hybrid, replacing off",
    "embeddings + BM25",
    { SAMEFACT_SEARCH: "hybrid", SAMEFACT_REPLACE: "0" },
  ),
];

/**
 * Mem0's open-source library (adapters/mem0_server.py), with an LLM for
 * its fact extraction and update step: any OpenAI-compatible endpoint in
 * SAMEFACT_LLM_URL / SAMEFACT_LLM_MODEL (and SAMEFACT_LLM_KEY if needed),
 * fastembed embeddings, in-memory Qdrant. Each note is one add() call.
 */
const MEM0_WORKERS = Number(process.env.SAMEFACT_MEM0_WORKERS ?? 4);

export const mem0: AdapterSpec = {
  id: "mem0",
  unavailable: () =>
    needUvx() ??
    (process.env.SAMEFACT_LLM_URL
      ? undefined
      : "needs an LLM: set SAMEFACT_LLM_URL and SAMEFACT_LLM_MODEL (any OpenAI-compatible endpoint)"),
  start: () => startMem0({}),
  startFrom: (snapshot) => startMem0({ SAMEFACT_MEM0_FROM: snapshot }),
};

async function startMem0(env: Record<string, string>): Promise<Memory> {
  {
    const uv = findUvx()!.replace(/uvx$/, "uv");
    const client = await connect(
      uv,
      [
        "run",
        "--no-project",
        "--python",
        "3.12",
        "--with",
        "mem0ai==2.2.1",
        "--with",
        "fastembed",
        "--with",
        "mcp>=1.6,<2",
        "python",
        join(ROOT, "adapters/mem0_server.py"),
      ],
      { UV_CACHE_DIR: uvCacheDir(), ...env },
    );
    let failures = 0;
    return {
      version: `mem0ai 2.2.1 · ${process.env.SAMEFACT_LLM_MODEL ?? "?"}`,
      name: "Mem0 (open source, LLM)",
      search: "LLM fact extraction + vectors",
      async store(texts, opts) {
        if (opts?.ordered === false) {
          // Mem0 sends every note to its LLM; a few at a time keeps a local
          // model server busy without running it out of memory.
          for (const chunk of chunks(texts, 32)) {
            const reply = textOf(
              await call(client, "add_memories", {
                texts: chunk,
                workers: MEM0_WORKERS,
              }),
            );
            failures += Number(/(\d+) errors/.exec(reply)?.[1] ?? 0);
          }
        } else {
          for (const text of texts) {
            const reply = textOf(await call(client, "add_memory", { text }));
            if (reply.startsWith("error")) failures += 1;
          }
        }
      },
      storeFailures: () => failures,
      snapshot: async () => textOf(await call(client, "snapshot", {})).trim(),
      async find(query) {
        const json = JSON.parse(
          textOf(await call(client, "search_memories", { query, limit: TOP })),
        ) as { results: { memory: string }[] };
        return json.results.map((r) => r.memory);
      },
      close: () => client.close(),
    };
  }
}

/**
 * MemPalace: verbatim "drawers" in a local palace (vector search with a
 * BM25 boost), no API key. Each note is filed with mempalace_add_drawer in one wing and
 * room; search is mempalace_search. Run through uvx with its own HOME
 * and palace.
 */
export const memPalace: AdapterSpec = {
  id: "mempalace",
  unavailable: needUvx,
  async start() {
    const home = mkdtempSync(join(tmpdir(), "samefact-mp-"));
    const client = await connect(
      findUvx()!,
      [
        "--python",
        "3.12",
        "--from",
        "mempalace==3.11.0",
        "mempalace-mcp",
        "--palace",
        join(home, "palace"),
      ],
      { HOME: home, UV_CACHE_DIR: uvCacheDir() },
    );
    return {
      version: serverVersion(client),
      name: "MemPalace",
      search: "verbatim drawers + vectors",
      async store(texts) {
        for (const content of texts)
          await call(client, "mempalace_add_drawer", {
            wing: "samefact",
            room: "memories",
            content,
          });
      },
      async find(query) {
        const json = JSON.parse(
          textOf(await call(client, "mempalace_search", { query, limit: TOP })),
        ) as { results?: { text: string }[] };
        // The drawer's text only: ids and dates could match an answer.
        return (json.results ?? []).map((r) => r.text).slice(0, TOP);
      },
      close: () => client.close(),
    };
  },
};

export const ADAPTERS: AdapterSpec[] = [
  officialMemory,
  basicMemory,
  chroma,
  memPalace,
  mem0,
  samefactMemory,
];
