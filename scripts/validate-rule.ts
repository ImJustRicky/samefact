// Checks the reference memory's replace rule on cases written by a
// separate model. For each case: store the base fact among a few hundred
// distractors, then one later note, and see whether the base was marked
// replaced. Explicit and implicit changes should replace it; decoys and
// look-alikes should not.
// Usage: npx tsx scripts/validate-rule.ts [--file data/test-replace.json] [words|values] [--misses]
// data/validation.json was used to develop the rule; data/test-replace.json
// was written afterwards and is the one to report.
import { readFileSync } from "node:fs";
import type { Rule } from "../src/memory/change";
import { embedder } from "../src/memory/embed";
import { createMemory } from "../src/memory/server";

type Case = {
  id: string;
  base: string;
  explicit: string;
  implicit: string;
  decoy: string;
  lookalike: string;
};
const fileArg = process.argv.indexOf("--file");
const file =
  fileArg > 0 ? process.argv[fileArg + 1]! : "data/test-replace.json";
const cases = JSON.parse(readFileSync(file, "utf8")) as Case[];
const noise = (
  JSON.parse(readFileSync("data/noise.json", "utf8")) as string[]
).slice(0, 300);
const embed = await embedder();
const named = process.argv.find((a) => a === "words" || a === "values");
const rules: Rule[] = named ? [named as Rule] : ["words", "values"];

for (const rule of rules) {
  const tally = { explicit: 0, implicit: 0, decoy: 0, lookalike: 0 };
  const misses: string[] = [];
  for (const c of cases) {
    for (const kind of [
      "explicit",
      "implicit",
      "decoy",
      "lookalike",
    ] as const) {
      const m = createMemory(embed, { rule });
      await m.remember([...noise.slice(0, 150), c.base, ...noise.slice(150)]);
      const baseId = 151;
      await m.remember([c[kind]]);
      const replaced = m.notes[baseId - 1]!.replacedBy !== undefined;
      const right =
        kind === "explicit" || kind === "implicit" ? replaced : !replaced;
      if (right) tally[kind] += 1;
      else misses.push(`${c.id}/${kind}: ${c[kind]}`);
    }
  }
  const n = cases.length;
  console.log(
    `${rule.padEnd(6)}  changes caught: explicit ${tally.explicit}/${n}, implicit ${tally.implicit}/${n}  ·  left alone: decoy ${tally.decoy}/${n}, look-alike ${tally.lookalike}/${n}`,
  );
  if (process.argv.includes("--misses"))
    for (const x of misses) console.log("   ✗ " + x);
}
