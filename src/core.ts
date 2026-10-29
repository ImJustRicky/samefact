import type { AdapterSpec, QueryStyle } from "./adapters";
import { FACTS, NOISE, QUESTION_KINDS, type QuestionSet } from "./facts";
import { scoreQuestion, summarize, type Outcome, type Summary } from "./score";

// One run: for each server and each way of stating updates, in parallel,
// start it empty, store the distractor notes with the facts and
// look-alikes scattered among them, then the updates (later, as in life),
// then ask every question.
//
// Updates are stated two ways, each in a fresh server:
//   explicit  "We changed the garage door code to 7391."
//   implicit  "Garage door code: 7391."  (no word says it changed)

export type UpdateStyle = "explicit" | "implicit";

export type Timing = {
  startMs: number;
  storeMs: number;
  stores: number;
  searchMs: number;
  searches: number;
  // Searches that errored (counted as misses).
  errors: number;
  // Notes the server said it couldn't store.
  storeFailures: number;
};

export type Report = {
  adapter: string;
  name: string;
  search: string;
  style: QueryStyle;
  set: string;
  updates: UpdateStyle;
  version?: string;
  summary: Summary;
  timing: Timing;
  outcomes: (Outcome & {
    question: string;
    query: string;
    results: string[];
  })[];
};

export type RunOptions = {
  noise: boolean;
  styles: QueryStyle[];
  sets: Record<string, QuestionSet>;
  updates: UpdateStyle[];
  log: (id: string, msg: string) => void;
};

/** The same order for every server: a seeded shuffle of notes and facts. */
export function storedOrder(noise: boolean, updates: UpdateStyle = "explicit") {
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const items = [
    ...(noise ? NOISE : []),
    ...FACTS.flatMap((f) => [
      f.stored,
      ...(f.lookalikes ?? []).map((l) => l.stored),
    ]),
  ];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  const later = FACTS.flatMap((f) =>
    f.update
      ? [updates === "implicit" ? f.update.implicit : f.update.stored]
      : f.decoy
        ? [f.decoy]
        : [],
  );
  return { base: items, later, all: [...items, ...later] };
}

// The shared notes, already stored once and snapshotted (see run()).
type Prepared = { snapshot: string; storeMs: number; failures: number };

export async function benchOne(
  spec: AdapterSpec,
  updates: UpdateStyle,
  o: RunOptions,
  from?: Prepared,
): Promise<Report[]> {
  const { base, later, all } = storedOrder(o.noise, updates);
  const label = o.updates.length > 1 ? `${spec.id} · ${updates}` : spec.id;
  const now = () => performance.now();
  const t0 = now();
  const memory = from
    ? await spec.startFrom!(from.snapshot)
    : await spec.start();
  const timing: Timing = {
    startMs: now() - t0,
    storeMs: 0,
    stores: 0,
    searchMs: 0,
    searches: 0,
    errors: 0,
    storeFailures: 0,
  };
  const reports: Report[] = [];
  try {
    const ts = now();
    // Everything said first (order among it doesn't matter), then the
    // changes and false changes, in order, after it.
    if (!from) await memory.store(base, { ordered: false });
    await memory.store(later, { ordered: true });
    timing.storeMs = now() - ts + (from?.storeMs ?? 0);
    timing.stores = all.length;
    timing.storeFailures =
      (memory.storeFailures?.() ?? 0) + (from?.failures ?? 0);
    o.log(
      label,
      `stored ${all.length} notes in ${(timing.storeMs / 1000).toFixed(1)} s`,
    );
    for (const [setName, set] of Object.entries(o.sets)) {
      for (const style of o.styles) {
        const outcomes: Report["outcomes"] = [];
        for (const fact of FACTS) {
          for (const kind of QUESTION_KINDS) {
            const asked = set[fact.id]![kind];
            const query = style === "asked" ? asked.question : asked.query;
            let results: string[] = [];
            const t = now();
            try {
              results = await memory.find(query);
              timing.searchMs += now() - t;
              timing.searches += 1;
            } catch (error) {
              timing.errors += 1;
              o.log(label, `${fact.id}/${kind}: ${(error as Error).message}`);
            }
            outcomes.push({
              ...scoreQuestion(fact, kind, results),
              question: asked.question,
              query,
              results,
            });
          }
        }
        reports.push({
          adapter: spec.id,
          name: memory.name,
          search: memory.search,
          style,
          set: setName,
          updates,
          version: memory.version,
          summary: summarize(outcomes),
          timing: { ...timing },
          outcomes,
        });
      }
    }
  } finally {
    await memory.close();
  }
  return reports;
}

/**
 * For a server that can snapshot its storage: store the notes every update
 * style shares once, then let each style start from a copy. Same notes,
 * same order, half the work for slow servers.
 */
async function prepare(spec: AdapterSpec, o: RunOptions): Promise<Prepared> {
  const { base } = storedOrder(o.noise);
  const t = performance.now();
  const memory = await spec.start();
  try {
    await memory.store(base, { ordered: false });
    const snapshot = await memory.snapshot!();
    o.log(
      spec.id,
      `stored ${base.length} shared notes once in ${((performance.now() - t) / 1000).toFixed(1)} s`,
    );
    return {
      snapshot,
      storeMs: performance.now() - t,
      failures: memory.storeFailures?.() ?? 0,
    };
  } finally {
    await memory.close();
  }
}

async function benchAll(spec: AdapterSpec, o: RunOptions) {
  const shareable = Boolean(spec.startFrom) && o.updates.length > 1;
  const from = shareable ? await prepare(spec, o) : undefined;
  return Promise.allSettled(o.updates.map((u) => benchOne(spec, u, o, from)));
}

export async function run(adapters: AdapterSpec[], o: RunOptions) {
  const jobs = adapters.flatMap((a) => o.updates.map((u) => ({ a, u })));
  const started = performance.now();
  const perAdapter = await Promise.allSettled(
    adapters.map((a) => benchAll(a, o)),
  );
  const settled: PromiseSettledResult<Report[]>[] = perAdapter.flatMap(
    (p, i) =>
      p.status === "fulfilled"
        ? p.value
        : o.updates.map(() => ({
            status: "rejected" as const,
            reason: p.reason,
          })),
  );
  const reports: Report[] = [];
  const failed: { adapter: string; error: string }[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") reports.push(...s.value);
    else
      failed.push({
        adapter: `${jobs[i]!.a.id} (${jobs[i]!.u})`,
        error: String(s.reason?.message ?? s.reason),
      });
  });
  return {
    reports,
    failed,
    stored: storedOrder(o.noise).all.length,
    wallMs: performance.now() - started,
  };
}
