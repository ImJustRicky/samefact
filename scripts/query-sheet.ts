// Prepares the blind query-writing step: every question from
// data/questions.json under an opaque id, shuffled, so whoever writes the
// search queries sees each question alone (not its fact, its kind, or the
// other questions about the same fact). Writes a sheet and a private key;
// `--apply answers.json` turns the answered sheet into
// data/agent-queries.json.
// Usage: npx tsx scripts/query-sheet.ts OUT_DIR
//        npx tsx scripts/query-sheet.ts OUT_DIR --apply OUT_DIR/answers.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2]!;
const questions = JSON.parse(
  readFileSync("data/questions.json", "utf8"),
) as Record<string, Record<string, Record<string, string>>>;

if (process.argv.includes("--apply")) {
  const key = JSON.parse(readFileSync(join(dir, "key.json"), "utf8")) as Record<
    string,
    string
  >;
  const answers = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--apply") + 1]!, "utf8"),
  ) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [qid, k] of Object.entries(key)) {
    const a = answers[qid]?.trim();
    if (!a) throw new Error(`No query for ${qid}`);
    out[k] = a;
  }
  writeFileSync("data/agent-queries.json", JSON.stringify(out, null, 1) + "\n");
  console.log(`Wrote ${Object.keys(out).length} agent queries`);
} else {
  const items: { key: string; question: string }[] = [];
  for (const [id, sets] of Object.entries(questions))
    for (const [set, kinds] of Object.entries(sets))
      for (const [kind, question] of Object.entries(kinds))
        items.push({ key: `${id}|${set}|${kind}`, question });
  let seed = 4242;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  const sheet: Record<string, string> = {};
  const key: Record<string, string> = {};
  items.forEach((it, i) => {
    const qid = `q${String(i + 1).padStart(3, "0")}`;
    sheet[qid] = it.question;
    key[qid] = it.key;
  });
  writeFileSync(join(dir, "sheet.json"), JSON.stringify(sheet, null, 1));
  writeFileSync(join(dir, "key.json"), JSON.stringify(key));
  console.log(
    `Wrote ${items.length} shuffled questions to ${join(dir, "sheet.json")}`,
  );
}
