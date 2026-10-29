// Merges several results files into one, for runs done separately (a
// slow LLM-backed server run on its own, say). Later files win for the
// same server, query style, question set and update style.
// Usage: npx tsx scripts/merge-results.ts out.json in1.json in2.json ...
import { readFileSync, writeFileSync } from "node:fs";
import { wilson } from "../src/score";

type Cell = { n: number; top3: number; stale: number };
type Outcome = { top3: boolean; results?: string[] };
type Report = {
  adapter: string;
  style: string;
  set: string;
  updates: string;
  summary: Record<string, Cell>;
  outcomes?: Outcome[];
  [k: string]: unknown;
};
type Results = {
  samefact: string;
  data: string;
  stored: number;
  date: string;
  reports: Report[];
  failed: unknown[];
  [k: string]: unknown;
};

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error("Usage: merge-results.ts out.json in1.json in2.json ...");
  process.exit(2);
}
const files = inputs.map((f) => JSON.parse(readFileSync(f, "utf8")) as Results);
const datas = new Set(files.map((f) => f.data));
if (datas.size > 1)
  throw new Error(`Different test data across files: ${[...datas].join(", ")}`);
const key = (r: Report) => [r.adapter, r.style, r.set, r.updates].join("|");
const merged = new Map<string, Report>();
for (const f of files) for (const r of f.reports) merged.set(key(r), r);
const base = files.at(-1)!;

// Keeps what came back only for misses (the part worth reading), and
// stores each top-3 share with its 95% range.
const pct = (k: number, n: number) => Math.round((1000 * k) / n) / 10;
function slim(r: Report) {
  const range = (k: number, n: number) => {
    const w = wilson(k, n);
    return { share: pct(k, n), low: pct(w.lo * n, n), high: pct(w.hi * n, n) };
  };
  return {
    ...r,
    ranges: Object.fromEntries(
      Object.entries(r.summary).map(([kind, c]) => [
        kind,
        {
          top3: range(c.top3, c.n),
          ...(kind === "update" ? { stale: range(c.stale, c.n) } : {}),
        },
      ]),
    ),
    outcomes: r.outcomes?.map((o) =>
      o.top3 ? { ...o, results: undefined } : o,
    ),
  };
}
writeFileSync(
  out,
  JSON.stringify({
    ...base,
    date: files
      .map((f) => f.date)
      .sort()
      .at(-1),
    mergedFrom: inputs,
    failed: files.flatMap((f) => f.failed ?? []),
    reports: [...merged.values()].map(slim),
  }),
);
console.log(
  `Merged ${merged.size} reports from ${inputs.length} files into ${out}`,
);
