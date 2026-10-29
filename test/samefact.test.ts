import assert from "node:assert/strict";
import { test } from "node:test";
import { keywords } from "../src/adapters";
import {
  AGENT_QUERIES,
  FACTS,
  NOISE,
  QUESTION_KINDS,
  QUESTIONS,
  queryKey,
} from "../src/facts";
import { containsValue } from "../src/match";
import {
  chanceTopK,
  rankOf,
  scoreQuestion,
  summarize,
  wilson,
} from "../src/score";

const garage = FACTS.find((f) => f.update)!;
const plain = FACTS.find((f) => !f.update && !f.decoy)!;

test("values match whole words only", () => {
  assert.equal(containsValue("Built with Bun.", "Bun"), true);
  assert.equal(containsValue("the bundle size", "Bun"), false);
  assert.equal(containsValue("Standup is at 9:45 AM", "9:45"), true);
  assert.equal(containsValue("at 19:45", "9:45"), false);
  assert.equal(containsValue("color #1F6FEB.", "#1f6feb"), true);
});

test("rank is the first result holding the value", () => {
  assert.equal(rankOf(["a", "code 4417", "4417 again"], "4417"), 2);
  assert.equal(rankOf(["a", "b"], "4417"), null);
});

test("an update counts only when the new value outranks the old", () => {
  const { value: old } = garage;
  const now = garage.update!.value;
  assert.equal(
    scoreQuestion(garage, "direct", [`x ${now}`, `y ${old}`]).top1,
    true,
  );
  assert.equal(
    scoreQuestion(garage, "direct", [`y ${old}`, `x ${now}`]).top3,
    false,
  );
  assert.equal(
    scoreQuestion(garage, "direct", [`a`, `b`, `x ${now}`]).top3,
    true,
  );
  assert.equal(
    scoreQuestion(garage, "direct", [`a`, `b`, `c`, `x ${now}`]).top3,
    false,
  );
});

test("updated facts are summarized apart from the three kinds", () => {
  const s = summarize([
    scoreQuestion(plain, "direct", [plain.stored]),
    scoreQuestion(garage, "direct", [garage.update!.stored]),
  ]);
  assert.deepEqual(s.direct, { n: 1, top1: 1, top3: 1, stale: 0, found: 1 });
  assert.deepEqual(s.update, { n: 1, top1: 1, top3: 1, stale: 0, found: 1 });
});

test("wilson intervals and chance", () => {
  const { lo, hi } = wilson(16, 17);
  assert.ok(lo > 0.7 && lo < 0.75 && hi > 0.98, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
  assert.equal(chanceTopK(300), 0.01);
});

test("keywords drop filler words", () => {
  assert.deepEqual(keywords("What is my gym locker combination?"), [
    "gym",
    "locker",
    "combination",
  ]);
});

test("every answer appears in exactly one stored sentence", () => {
  const stored = FACTS.flatMap((f) => [
    f.stored,
    ...(f.lookalikes ?? []).map((l) => l.stored),
    ...(f.update ? [f.update.stored] : []),
  ]);
  for (const f of FACTS) {
    const pairs = [
      [f.value, f.stored],
      ...(f.lookalikes ?? []).map((l) => [l.value, l.stored]),
      ...(f.update ? [[f.update.value, f.update.stored]] : []),
    ] as [string, string][];
    for (const [value, own] of pairs) {
      assert.ok(
        containsValue(own, value),
        `${f.id}: ${value} not in its sentence`,
      );
      const elsewhere = stored.filter(
        (s) => s !== own && containsValue(s, value),
      );
      assert.deepEqual(elsewhere, [], `${f.id}: ${value} also in ${elsewhere}`);
      assert.ok(
        !NOISE.some((n) => containsValue(n, value)),
        `${f.id}: ${value} in noise`,
      );
    }
  }
});

test("every fact has two sets of three questions, none giving the answer away", () => {
  assert.equal(Object.keys(QUESTIONS).length, FACTS.length);
  for (const f of FACTS) {
    for (const set of ["main", "heldout"] as const) {
      for (const kind of QUESTION_KINDS) {
        const q = QUESTIONS[f.id]?.[set]?.[kind];
        assert.ok(q, `${f.id} has no ${set} ${kind} question`);
        for (const v of [f.value, f.update?.value].filter(Boolean) as string[])
          assert.ok(!containsValue(q, v), `${f.id}/${set}/${kind} contains ${v}`);
      }
    }
  }
});

test("noise is 1,000 distinct notes", () => {
  assert.equal(NOISE.length, 1000);
  assert.equal(new Set(NOISE).size, 1000);
});

test("every question has an agent query that doesn't give the answer away", () => {
  for (const f of FACTS) {
    for (const set of ["main", "heldout"] as const) {
      for (const kind of QUESTION_KINDS) {
        const q = AGENT_QUERIES[queryKey(f.id, set, kind)];
        assert.ok(q, `${f.id}/${set}/${kind} has no agent query`);
        for (const v of [f.value, f.update?.value].filter(Boolean) as string[])
          assert.ok(!containsValue(q, v), `${f.id}/${set}/${kind} query contains ${v}`);
      }
    }
  }
});

import { resultsFrom } from "../src/generic";
import { createMemory } from "../src/memory/server";

test("generic results: JSON arrays, nested lists and plain text", () => {
  assert.deepEqual(resultsFrom('{"results":[{"text":"a 1"},{"text":"b 2"}]}'), [
    "a 1",
    "b 2",
  ]);
  assert.deepEqual(resultsFrom('{"documents":[["x","y"]]}'), ["x", "y"]);
  assert.deepEqual(resultsFrom("1. first\n2. second"), [
    "1. first",
    "2. second",
  ]);
});

// Toy embeddings: a vector per topic word, so similarity is controlled.
const TOPICS = ["garage", "bike", "gym", "bakery"];
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => {
    const v = TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.05));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  });

test("a change note replaces the one note it's clearly about", async () => {
  const m = createMemory(fakeEmbed);
  await m.remember(["The garage door code is 2580.", "My bike lock is 9032."]);
  const [r] = await m.remember(["We changed the garage door code to 7391."]);
  assert.equal(r!.replaced, 1);
  const top = await m.recall("garage code", 2);
  assert.equal(top[0]!.text, "We changed the garage door code to 7391.");
  // The old note is kept, marked replaced by the new one.
  assert.equal(m.notes[0]!.replacedBy, 3);
  assert.ok(!top.some((n) => n.text.includes("2580") && !n.replacedBy));
});

test("a note without change words replaces nothing", async () => {
  const m = createMemory(fakeEmbed);
  await m.remember(["The garage door code is 2580."]);
  const [r] = await m.remember(["The garage door is white."]);
  assert.equal(r!.replaced, undefined);
});

test("replacing can be turned off", async () => {
  const m = createMemory(fakeEmbed, { replace: false });
  await m.remember(["The garage door code is 2580."]);
  const [r] = await m.remember(["We changed the garage door code to 7391."]);
  assert.equal(r!.replaced, undefined);
});

test("implicit updates and decoys are well formed", () => {
  const CHANGE =
    /\b(changed?|changing|now|moved?|switched|switching|new|no longer|instead|updated?|anymore|replaced|migrated|from now on|starting)\b/i;
  for (const f of FACTS) {
    if (f.update) {
      assert.ok(
        !CHANGE.test(f.update.implicit),
        `${f.id}: implicit has a change word`,
      );
      assert.ok(containsValue(f.update.implicit, f.update.value));
      assert.ok(!containsValue(f.update.implicit, f.value));
    }
    if (f.decoy) {
      assert.ok(
        !containsValue(f.decoy, f.value),
        `${f.id}: decoy contains the answer`,
      );
    }
  }
});

import { contentWords, replaces, valueTokens } from "../src/memory/change";

test("value tokens: numbers, codes and names, not the first word", () => {
  assert.deepEqual([...valueTokens("Garage door code: 7391.")], ["7391"]);
  assert.deepEqual([...valueTokens("Marcus Bell is my manager.")], ["bell"]);
  assert.deepEqual(
    [...valueTokens("The flag is checkout_v2 on Tuesday.")],
    ["checkout_v2", "tuesday"],
  );
});

test("content words set values aside", () => {
  assert.deepEqual(
    [...contentWords("The garage door code is 2580.")],
    ["garage", "door", "code"],
  );
});

test("the values rule: new value about the same thing, or a stated change", () => {
  const old = "The garage door code is 2580.";
  assert.equal(replaces("Garage door code: 7391.", old, "values"), true);
  assert.equal(
    replaces("We changed the garage door code to 7391.", old, "values"),
    true,
  );
  assert.equal(
    replaces("We talked about changing the garage door code.", old, "values"),
    false,
  );
  assert.equal(
    replaces("The garage door is painted white.", old, "values"),
    false,
  );
  assert.equal(
    replaces(
      "My bike lock combination is 9032.",
      "My gym locker combination is 4417.",
      "values",
    ),
    false,
  );
});

test("the words rule only looks for change words", () => {
  assert.equal(replaces("We talked about changing it.", "x", "words"), true);
  assert.equal(replaces("Garage door code: 7391.", "x", "words"), false);
});
