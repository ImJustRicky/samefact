#!/usr/bin/env node
// samefact-memory: a small reference MCP memory server that does the two
// things samefact tests, with no language model and no account.
//
// - Finding a fact in other words: notes are searched by meaning, with a
//   small local embedding model (all-MiniLM-L6-v2). Fusing in BM25 word
//   scores is available (SAMEFACT_SEARCH=hybrid) but measured no better.
// - Knowing a fact changed: when a new note is clearly about the same
//   thing as one earlier note and states a new value for it (or says it
//   changed), the earlier note is marked replaced; talk of a change that
//   didn't happen is ignored (rules in change.ts). Replaced notes are kept
//   (history matters) but rank below what replaced them.
//
// samefact's implicit-update and decoy tests measure how well that works.
// Notes live in memory, or in a JSON file with SAMEFACT_MEMORY_PATH.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Bm25 } from "./bm25";
import { replaces, type Rule } from "./change";
import { embedder } from "./embed";

// A new note must be at least this similar (cosine) to the note it
// replaces, and this much more similar to it than to the runner-up, before
// the rule in change.ts is even asked.
export const REPLACE_MIN = 0.5;
export const REPLACE_MARGIN = 0.05;
// How far a replaced note's score drops.
export const REPLACED_WEIGHT = 0.25;
// How many top results the recall-time check looks across.
export const RESOLVE_DEPTH = 10;
const RRF_K = 60;

export type Note = {
  id: number;
  text: string;
  at: number;
  vector: number[];
  replacedBy?: number;
};

const dot = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

export type Options = {
  // "meaning": embeddings only. "hybrid": embeddings fused with BM25.
  search?: "meaning" | "hybrid";
  // Track changed facts (on by default).
  replace?: boolean;
  // How a change is recognized (see change.ts).
  rule?: Rule;
  // Also apply the change rule to the notes a search finds together.
  resolve?: boolean;
};

export function createMemory(
  embed: (texts: string[]) => Promise<number[][]>,
  {
    search = "meaning",
    replace = true,
    rule = "values",
    resolve = true,
  }: Options = {},
) {
  const notes: Note[] = [];
  const bm25 = new Bm25();

  async function remember(texts: string[], at = Date.now()) {
    const vectors = await embed(texts);
    const stored: { id: number; replaced?: number }[] = [];
    texts.forEach((text, i) => {
      const vector = vectors[i]!;
      const note: Note = { id: notes.length + 1, text, at, vector };
      let replaced: number | undefined;
      if (replace) {
        // The live note this one is most clearly about.
        let best: Note | undefined;
        let bestSim = -1;
        let second = -1;
        for (const n of notes) {
          if (n.replacedBy) continue;
          const sim = dot(vector, n.vector);
          if (sim > bestSim) {
            second = bestSim;
            bestSim = sim;
            best = n;
          } else if (sim > second) second = sim;
        }
        if (
          best &&
          bestSim >= REPLACE_MIN &&
          bestSim - second >= REPLACE_MARGIN &&
          replaces(text, best.text, rule, bestSim)
        ) {
          best.replacedBy = note.id;
          replaced = best.id;
        }
      }
      notes.push(note);
      bm25.add(text);
      stored.push({ id: note.id, replaced });
    });
    return stored;
  }

  async function recall(query: string, limit = 5) {
    if (notes.length === 0) return [];
    const [q] = await embed([query]);
    const byMeaning = notes
      .map((n, i) => ({ i, s: dot(q!, n.vector) }))
      .sort((a, b) => b.s - a.s);
    const byWords = bm25
      .scores(query)
      .map((s, i) => ({ i, s }))
      .sort((a, b) => b.s - a.s);
    const fused = new Float64Array(notes.length);
    byMeaning.forEach(({ i }, rank) => (fused[i]! += 1 / (RRF_K + rank + 1)));
    if (search === "hybrid")
      byWords.forEach(({ i, s }, rank) => {
        if (s > 0) fused[i]! += 1 / (RRF_K + rank + 1);
      });
    notes.forEach((n, i) => {
      if (n.replacedBy) fused[i]! *= REPLACED_WEIGHT;
    });
    let ranked = [...fused.keys()].sort((a, b) => fused[b]! - fused[a]!);
    if (replace && resolve) ranked = resolveAtRecall(ranked);
    return ranked.slice(0, limit).map((i) => {
      const n = notes[i]!;
      return {
        id: n.id,
        text: n.text,
        storedAt: new Date(n.at).toISOString(),
        ...(n.replacedBy ? { replacedBy: n.replacedBy } : {}),
      };
    });
  }

  /**
   * The same change rule, applied to what a search actually found: if an
   * older and a newer note both come back for one question, are close in
   * meaning, and the newer one replaces the older by the rule, the older
   * moves to just below the newer. Coming back together for the same
   * question is evidence that the store-time check (one nearest note, with
   * a margin over all the others) can miss among thousands of notes.
   */
  function resolveAtRecall(ranked: number[]) {
    const top = ranked.slice(0, RESOLVE_DEPTH);
    for (let pass = 0; pass < RESOLVE_DEPTH; pass++) {
      let moved = false;
      for (let a = 0; a < top.length && !moved; a++) {
        const older = notes[top[a]!]!;
        for (let b = a + 1; b < top.length; b++) {
          const newer = notes[top[b]!]!;
          if (newer.id <= older.id) continue;
          const sim = dot(older.vector, newer.vector);
          if (sim < REPLACE_MIN || !replaces(newer.text, older.text, rule, sim))
            continue;
          top.splice(b + 1, 0, top[a]!);
          top.splice(a, 1);
          moved = true;
          break;
        }
      }
      if (!moved) break;
    }
    return [...top, ...ranked.slice(RESOLVE_DEPTH)];
  }

  return { notes, remember, recall };
}

async function main() {
  const path = process.env.SAMEFACT_MEMORY_PATH;
  const memory = createMemory(await embedder(), {
    search: process.env.SAMEFACT_SEARCH === "hybrid" ? "hybrid" : "meaning",
    replace: process.env.SAMEFACT_REPLACE !== "0",
    rule: process.env.SAMEFACT_RULE === "words" ? "words" : "values",
    resolve: process.env.SAMEFACT_RESOLVE !== "0",
  });
  if (path && existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Note[];
    for (const n of saved) await memory.remember([n.text], n.at);
  }
  const save = () => {
    if (path)
      writeFileSync(
        path,
        JSON.stringify(memory.notes.map(({ vector: _, ...n }) => n)),
      );
  };

  const server = new McpServer({ name: "samefact-memory", version: "0.3.0" });
  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Save one or more facts, preferences or decisions to long-term memory, each as a short self-contained sentence. When a fact changes, save the new version in words like 'changed to' or 'now'; the old one is kept but marked replaced.",
      inputSchema: { notes: z.array(z.string().min(1)).min(1) },
    },
    async ({ notes }) => {
      const stored = await memory.remember(notes);
      save();
      return { content: [{ type: "text", text: JSON.stringify({ stored }) }] };
    },
  );
  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Search long-term memory by meaning and words. Returns the best matching notes, newest version first when a fact has changed.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: await memory.recall(query, limit ?? 5),
          }),
        },
      ],
    }),
  );
  await server.connect(new StdioServerTransport());
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.env.SAMEFACT_MEMORY_MAIN === "1"
) {
  await main();
}
