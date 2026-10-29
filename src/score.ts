import type { Fact, QuestionKind } from "./facts";
import { containsValue } from "./match";

// How one answer scores. Rank is the first result containing the right
// value. A fact that was updated is right only when the new value comes
// back ahead of the old one.

export type Outcome = {
  fact: string;
  kind: QuestionKind;
  updated: boolean;
  // A fact that had a change-sounding note stored after it.
  decoyed: boolean;
  rank: number | null;
  staleRank?: number | null;
  top1: boolean;
  top3: boolean;
};

export function rankOf(results: string[], value: string) {
  const i = results.findIndex((r) => containsValue(r, value));
  return i === -1 ? null : i + 1;
}

export function scoreQuestion(
  fact: Fact,
  kind: QuestionKind,
  results: string[],
): Outcome {
  if (fact.update) {
    const rank = rankOf(results, fact.update.value);
    const staleRank = rankOf(results, fact.value);
    const ahead = rank !== null && (staleRank === null || rank < staleRank);
    return {
      fact: fact.id,
      kind,
      updated: true,
      decoyed: false,
      rank,
      staleRank,
      top1: ahead && rank === 1,
      top3: ahead && rank <= 3,
    };
  }
  const rank = rankOf(results, fact.value);
  return {
    fact: fact.id,
    kind,
    updated: false,
    decoyed: Boolean(fact.decoy),
    rank,
    top1: rank === 1,
    top3: rank !== null && rank <= 3,
  };
}

// stale: the old value of an updated fact came back ranked above the new.
// found: the new value is in the top 3 at all, whatever came above it.
export type Cell = {
  n: number;
  top1: number;
  top3: number;
  stale: number;
  found: number;
};
// Updated facts are scored only under "update", and facts with a decoy
// only under "decoy", so the three question kinds compare the same facts.
export type Summary = Record<QuestionKind | "update" | "decoy", Cell>;

export function summarize(outcomes: Outcome[]): Summary {
  const empty = (): Cell => ({ n: 0, top1: 0, top3: 0, stale: 0, found: 0 });
  const s: Summary = {
    direct: empty(),
    reworded: empty(),
    situational: empty(),
    update: empty(),
    decoy: empty(),
  };
  for (const o of outcomes) {
    const cell = o.updated ? s.update : o.decoyed ? s.decoy : s[o.kind];
    cell.n += 1;
    if (o.top1) cell.top1 += 1;
    if (o.top3) cell.top3 += 1;
    if (o.rank !== null && o.rank <= 3) cell.found += 1;
    if (
      o.updated &&
      o.staleRank != null &&
      (o.rank === null || o.staleRank < o.rank)
    )
      cell.stale += 1;
  }
  return s;
}

/** The 95% Wilson interval for k of n, as fractions. */
export function wilson(k: number, n: number, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lo: Math.max(0, (centre - margin) / d),
    hi: Math.min(1, (centre + margin) / d),
  };
}

/** Chance that k random picks out of `pool` include one given item. */
export const chanceTopK = (pool: number, k = 3) => Math.min(1, k / pool);
