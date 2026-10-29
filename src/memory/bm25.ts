// BM25 word scoring over the notes, kept up to date as notes are added.
const STOP = new Set(
  "a an the is are was were be been am i me my we our you your it its they them what which who when where why how do does did can to of in on at for from by with as and or but if so that this these those there have has had not".split(
    " ",
  ),
);

export const tokens = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9#:$.,'-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.,'-]+|[.,'-]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));

export class Bm25 {
  private docs: Map<string, number>[] = [];
  private lengths: number[] = [];
  private df = new Map<string, number>();
  private total = 0;

  constructor(
    private k1 = 1.2,
    private b = 0.75,
  ) {}

  add(text: string) {
    const counts = new Map<string, number>();
    const words = tokens(text);
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const w of counts.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.docs.push(counts);
    this.lengths.push(words.length);
    this.total += words.length;
  }

  /** A score per note, in insertion order. */
  scores(query: string) {
    const n = this.docs.length;
    const avg = this.total / Math.max(1, n);
    const terms = [...new Set(tokens(query))];
    return this.docs.map((counts, i) => {
      let s = 0;
      for (const t of terms) {
        const f = counts.get(t);
        if (!f) continue;
        const df = this.df.get(t)!;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s +=
          (idf * f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + (this.b * this.lengths[i]!) / avg));
      }
      return s;
    });
  }
}
