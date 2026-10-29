import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The test set lives in data/, so it can be read and extended without
// touching code. Everything in it was written by separate models that saw
// only what each file needed, never the memory servers, the reference
// memory's rules or the results:
//
// - data/facts.json: 80 facts a person or a software team tells an
//   assistant (40 personal, 40 work). 40 have look-alikes stored next to
//   them (same shape, another answer). 30 change later, said two ways in
//   separate runs: `update.stored` ("Heads up, I'm seeing Dr. Vasquez-Lim
//   these days") and `update.implicit` ("Dentist: Dr. Vasquez-Lim"). 20
//   have a false change (`decoy`): a plan, rumor or rejected idea that
//   must leave the fact alone.
// - data/questions.json: two independent sets of three questions per fact
//   ("main" and "heldout"), written from the facts alone:
//     direct      a plain question about it
//     reworded    the same question in the asker's own words
//     situational the situation they're in, without naming the topic
// - data/agent-queries.json: the search query an assistant would send for
//   each question, written from a shuffled list in which every question
//   stood alone.
// - data/noise.json: 1,000 everyday notes (583 written as a person would,
//   the rest from templates), none containing an answer.
//
// `value` is the string that must come back (a whole word or phrase); it
// appears in exactly one stored sentence.

export type Fact = {
  id: string;
  domain: "personal" | "work";
  stored: string;
  value: string;
  lookalikes?: { stored: string; value: string }[];
  // Sounds like a change but isn't; stored with the updates.
  decoy?: string;
  // `implicit`: the same change stated with no change words.
  update?: { stored: string; value: string; implicit: string };
};

export const QUESTION_KINDS = ["direct", "reworded", "situational"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const SET_NAMES = ["main", "heldout"] as const;
export type SetName = (typeof SET_NAMES)[number];

// The test set's folder: data/ here, or --data DIR (SAMEFACT_DATA).
export const DATA_DIR = process.env.SAMEFACT_DATA
  ? resolve(process.env.SAMEFACT_DATA)
  : fileURLToPath(new URL("../data", import.meta.url));

const read = <T>(path: string) =>
  JSON.parse(
    readFileSync(join(DATA_DIR, path.replace(/^data\//, "")), "utf8"),
  ) as T;

export const FACTS = read<Fact[]>("data/facts.json");
export const QUESTIONS = read<
  Record<string, Record<SetName, Record<QuestionKind, string>>>
>("data/questions.json");
export const NOISE = read<string[]>("data/noise.json");
/** Keyed "<fact id>|<set>|<kind>". */
export const AGENT_QUERIES = read<Record<string, string>>(
  "data/agent-queries.json",
);
export const queryKey = (id: string, set: SetName, kind: QuestionKind) =>
  `${id}|${set}|${kind}`;

export type Asked = { question: string; query: string };
export type QuestionSet = Record<string, Record<QuestionKind, Asked>>;

const setOf = (set: SetName): QuestionSet =>
  Object.fromEntries(
    FACTS.map((f) => [
      f.id,
      Object.fromEntries(
        QUESTION_KINDS.map((k) => [
          k,
          {
            question: QUESTIONS[f.id]![set][k],
            query: AGENT_QUERIES[queryKey(f.id, set, k)]!,
          },
        ]),
      ) as Record<QuestionKind, Asked>,
    ]),
  );

export const SETS: Record<SetName, QuestionSet> = {
  main: setOf("main"),
  heldout: setOf("heldout"),
};

/** The answer a question should get now: the update's when there is one. */
export const answerOf = (f: Fact) => f.update?.value ?? f.value;
