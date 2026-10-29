import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ABLATIONS,
  ADAPTERS,
  type AdapterSpec,
  type QueryStyle,
} from "./adapters";
import { run, type Report, type UpdateStyle } from "./core";
import { DATA_DIR, FACTS, SETS } from "./facts";
import { genericAdapter } from "./generic";
import { ROOT } from "./mcp";
import { chanceTopK, wilson, type Cell, type Summary } from "./score";

const HELP = `samefact: does your AI agent's memory find a fact in new words, and give the new answer after it changes?

Usage
  samefact                         run every built-in memory server (in parallel)
  samefact chroma-mcp basic-memory run some of them
  samefact -- <command> [args...]  test any MCP memory server, no code needed
  samefact --list                  list the built-in servers

Options
  --quick            no distractor notes, agent queries only: a few seconds
  --style S          asked | agent | both (default both)
  --set S            main | heldout | both (default main)
  --data DIR         use your own test set (same files as data/: facts,
                     questions, agent-queries, noise)
  --updates U        explicit | implicit | both (default both): updates said
                     with change words ("we changed it to...") or without
  --name N           name for a server given after --
  --store T[.ARG]    its store tool (and argument); found automatically if left out
  --search T[.ARG]   its search tool (and argument); found automatically if left out
  --store-extra J    JSON merged into every store call, e.g. '{"collection":"m"}'
  --search-extra J   JSON merged into every search call
  --min K=P          fail (exit 1) if kind K scores below P, e.g. --min update=0.8
                     K: direct | reworded | situational | update | decoy | stale (max for stale)
  --failures         print every question a server got wrong, with what came back
  --out DIR          where to write results (default ./samefact-results)
  --json             print the full results as JSON instead of a table
  -h, --help         this help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    quick: { type: "boolean" },
    style: { type: "string" },
    set: { type: "string" },
    updates: { type: "string" },
    data: { type: "string" },
    name: { type: "string" },
    store: { type: "string" },
    search: { type: "string" },
    "store-extra": { type: "string" },
    "search-extra": { type: "string" },
    min: { type: "string", multiple: true },
    failures: { type: "boolean" },
    out: { type: "string" },
    json: { type: "boolean" },
    list: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const ALL = [...ADAPTERS, ...ABLATIONS];
if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.list) {
  for (const a of ALL)
    console.log(`${a.id}${a.unavailable?.() ? `  (${a.unavailable()})` : ""}`);
  process.exit(0);
}

// Everything after "--" is a server command to test.
const dash = process.argv.indexOf("--");
const serverCommand = dash >= 0 ? process.argv.slice(dash + 1) : [];
const named =
  dash >= 0
    ? positionals.slice(0, positionals.length - serverCommand.length)
    : positionals;

let adapters: AdapterSpec[] = [];
if (serverCommand.length) {
  const json = (s?: string) =>
    s ? (JSON.parse(s) as Record<string, unknown>) : undefined;
  adapters.push(
    genericAdapter({
      command: serverCommand[0]!,
      args: serverCommand.slice(1),
      name: values.name,
      store: values.store,
      search: values.search,
      storeExtra: json(values["store-extra"]),
      searchExtra: json(values["search-extra"]),
    }),
  );
}
if (named.length) {
  for (const id of named) {
    const a = ALL.find((x) => x.id === id);
    if (!a) {
      console.error(`Unknown server "${id}". Try --list.`);
      process.exit(2);
    }
    adapters.push(a);
  }
} else if (!serverCommand.length) adapters = [...ADAPTERS];

const skipped = adapters.filter((a) => a.unavailable?.());
for (const a of skipped) console.error(`Skipping ${a.id}: ${a.unavailable!()}`);
adapters = adapters.filter((a) => !a.unavailable?.());

const styles: QueryStyle[] =
  values.style === "asked" || values.style === "agent"
    ? [values.style]
    : values.quick
      ? ["agent"]
      : ["asked", "agent"];
const setNames =
  values.set === "both" ? ["main", "heldout"] : [values.set ?? "main"];
const sets = Object.fromEntries(
  setNames.map((s) => [s, SETS[s as keyof typeof SETS]]),
);
if (setNames.some((s) => !(s in SETS))) {
  console.error(`Unknown --set. Use main, heldout or both.`);
  process.exit(2);
}

const quiet = values.json;
const log = (id: string, msg: string) => {
  if (!quiet) process.stderr.write(`[${id}] ${msg}\n`);
};

const updates: UpdateStyle[] =
  values.updates === "explicit" || values.updates === "implicit"
    ? [values.updates]
    : ["explicit", "implicit"];
// Servers built on the local embedding model share one download; fetch it
// once, in a short-lived child process (keeping the ONNX runtime out of
// this one), so parallel starts don't race to write the same cache.
if (
  adapters.some(
    (a) => a.id === "samefact-memory" || a.id.startsWith("ablation"),
  )
) {
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'await (await import("./src/memory/embed.ts")).embedder()',
      ],
      { cwd: ROOT, stdio: "ignore" },
    );
  } catch {
    // A failed warm-up just means each server downloads on its own.
  }
}

const result = await run(adapters, {
  noise: !values.quick,
  styles,
  sets,
  updates,
  log,
});
const { reports, failed, stored, wallMs } = result;
// A server whose searches mostly error out didn't score 0%: it didn't run.
const MAX_ERROR_SHARE = 0.1;
for (const r of reports) {
  const tries = r.timing.searches + r.timing.errors;
  const dropped = (r.timing.storeFailures ?? 0) / Math.max(1, r.timing.stores);
  if (
    (tries && r.timing.errors / tries > MAX_ERROR_SHARE) ||
    dropped > MAX_ERROR_SHARE
  ) {
    const msg =
      dropped > MAX_ERROR_SHARE
        ? `${r.timing.storeFailures} of ${r.timing.stores} notes couldn't be stored; its scores aren't meaningful`
        : `${r.timing.errors} of ${tries} searches failed; its scores aren't meaningful`;
    if (!failed.some((f) => f.adapter === r.adapter))
      failed.push({ adapter: r.adapter, error: msg });
  }
}
for (const f of failed) console.error(`[${f.adapter}] failed: ${f.error}`);

// What was tested, so a result can be reproduced.
const dataHash = createHash("sha256")
  .update(
    ["facts", "questions", "agent-queries", "noise"]
      .map((f) => readFileSync(join(DATA_DIR, `${f}.json`), "utf8"))
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 12);
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};
const stamp = new Date().toISOString();
const out = values.out ?? "samefact-results";
mkdirSync(out, { recursive: true });
const file = join(out, `${stamp.slice(0, 19).replace(/[:T]/g, "-")}.json`);
const full = {
  samefact: pkg.version,
  data: dataHash,
  date: stamp,
  stored,
  chanceTop3: chanceTopK(stored),
  wallMs,
  failed,
  reports,
};
writeFileSync(file, JSON.stringify(full, null, 2));

if (values.json) {
  console.log(JSON.stringify(full, null, 2));
} else {
  console.log("\n" + table(reports, stored) + "\n");
  console.log(
    `Run took ${(wallMs / 1000).toFixed(1)} s. Full results: ${file}`,
  );
}

if (values.failures) printFailures(reports);

// CI thresholds: every report must meet every --min.
let failing = failed.length > 0;
for (const rule of values.min ?? []) {
  const [kind, raw] = rule.split("=");
  const p = Number(raw);
  for (const r of reports) {
    const c =
      kind === "stale" ? r.summary.update : r.summary[kind as keyof Summary];
    if (!c || Number.isNaN(p)) {
      console.error(`Bad --min ${rule}`);
      process.exit(2);
    }
    const share =
      kind === "stale" ? c.stale / Math.max(1, c.n) : c.top3 / Math.max(1, c.n);
    const ok = kind === "stale" ? share <= p : share >= p;
    if (!ok) {
      failing = true;
      console.error(
        `✗ ${r.name} (${r.style}, ${r.set}): ${kind} ${pct(share)} ${kind === "stale" ? ">" : "<"} ${pct(p)}`,
      );
    }
  }
}
process.exit(failing ? 1 : 0);

function pct(p: number) {
  return `${Math.round(p * 100)}%`;
}

function cell(c: Cell) {
  const { lo, hi } = wilson(c.top3, c.n);
  return `${pct(c.top3 / Math.max(1, c.n))} (${Math.round(lo * 100)}–${Math.round(hi * 100)})`;
}

function table(reports: Report[], stored: number) {
  const share = (k: number, n: number) => pct(k / Math.max(1, n));
  const rows = reports.map((r) => {
    const u = r.summary.update;
    return [
      r.name,
      r.style + (r.set === "main" ? "" : ` · ${r.set}`),
      r.updates,
      cell(r.summary.direct),
      cell(r.summary.reworded),
      cell(r.summary.situational),
      cell(u),
      share(u.found, u.n),
      share(u.stale, u.n),
      cell(r.summary.decoy),
      `${Math.round(r.timing.storeMs / 1000)} s / ${(r.timing.searchMs / Math.max(1, r.timing.searches)).toFixed(0)} ms`,
    ];
  });
  const head = [
    "Memory",
    "Query",
    "Updates",
    "Direct",
    "Reworded",
    "Situational",
    "Update: new first",
    "New in top 3",
    "Stale first",
    "Survives decoy",
    "Store / search",
  ];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [
    `Right answer in the top 3 of ${stored} notes (95% range in brackets). Random would get ${pct(chanceTopK(stored))}.`,
    stored < 500
      ? "Quick mode: no distractors, so scores run higher than a full run."
      : "",
    "",
    line(head),
    line(widths.map((w) => "─".repeat(w))),
    ...rows.map(line),
  ]
    .filter((l, i) => i !== 1 || l)
    .join("\n");
}

function printFailures(reports: Report[]) {
  for (const r of reports) {
    const misses = r.outcomes.filter((o) => !o.top3);
    if (!misses.length) continue;
    console.log(
      `\n${r.name} · ${r.style} · ${r.set} · ${r.updates} updates: ${misses.length} missed`,
    );
    for (const m of misses) {
      const fact = FACTS.find((f) => f.id === m.fact)!;
      const want = fact.update
        ? `wanted "${fact.update.value}" above old "${fact.value}"`
        : `wanted "${fact.value}"`;
      console.log(`  ✗ ${m.fact}/${m.kind}: ${m.query}  (${want})`);
      m.results
        .slice(0, 3)
        .forEach((t, i) => console.log(`      ${i + 1}. ${t.slice(0, 110)}`));
      if (!m.results.length) console.log("      (nothing came back)");
    }
  }
}
