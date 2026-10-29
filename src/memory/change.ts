// Does a new note replace an earlier one? Two rules, kept side by side so
// samefact can measure each.
//
// "words" (v0.2): the new note uses a change word ("changed", "now",
// "switched"...). Falls for "we talked about switching..." and misses
// "Garage code: 7391."
//
// "values" (default): the new note states a concrete value about the
// same thing. Same subject means the same content words once values are
// set aside ("garage door code" / "garage door code"), and a new value
// means a number, name or code the old note doesn't have. A change word
// also counts as a new value. Talk of a change that didn't happen
// ("thinking about", "should", "nothing changed") never replaces.
// The constants below were set by reasoning about the cases, not fitted
// to samefact's results.

export type Rule = "words" | "values";

export const CHANGE =
  /\b(changed?|changing|now|moved?|switched|switching|new|no longer|instead|updated?|anymore|replaced|migrated|from now on|starting)\b/i;

// How people actually say a value changed, for the "values" rule: verbs of
// change ("upped", "bumped", "rebooked", "renamed", "transferred"), and
// phrases that mark a new state ("as of", "these days", "rather than").
export const CHANGED =
  /\b(chang(e|ed|es|ing)|now|moved?|switch(ed|es|ing)?|new|no longer|instead|updat(e|ed|es|ing)|anymore|replac(e|ed|es|ing)|migrat(e|ed|ing)|from now on|starting|as of|effective|these days|rather than|went (up|down)|goes up|up(ped|ping)|rais(e|ed|ing)|bump(ed|ing)?|increas(e|ed|ing)|decreas(e|ed|ing)|lower(ed|ing)|cut|reduc(e|ed|ing)|push(ed)? (back|to)|pulled forward|resched(ul(e|ed|ing))?|rebook(ed|ing)?|renam(e|ed|ing)|relocat(e|ed|ing)|transfer(red|ring)?|reassign(ed|ing)?|handed (over|off)|took over|shift(ed|ing)?|swapp?(ed|ing)?|upgrad(e|ed|ing)|downgrad(e|ed|ing)|got (a|an) |instead of|used to be|was previously|formerly)\b/i;

// A note this close in meaning (cosine), with a value the old one lacks,
// is taken as a restatement of the same fact. Set above where notes about
// different things (the same shape, another subject) tend to sit.
export const RESTATED = 0.8;

// Irrealis: plans, suggestions, wishes, refusals, negated change.
export const HYPOTHETICAL =
  /\b(talk(ed|ing)? about|thinking (about|of)|think(ing)? we should|consider(ed|ing)?|suggest(ed|s|ing)?|propos(ed|al)|might|maybe|perhaps|should|could|would|plan(s|ned|ning)? to|want(s|ed)? to|hop(e|ing) to|if we|in case|decided (not|against)|leave it|nothing changed|didn't|did not|haven't|hasn't|not yet|someday|eventually|rumou?r)\b/i;

// Content words must overlap at least this much (Jaccard), values aside.
export const SAME_SUBJECT = 0.75;

const STOP = new Set(
  "a an the is are was were be been am i me my mine we our us you your it its they their this that these those to of in on at for from by with as and or but so do does did have has had will can just there here what which who".split(
    " ",
  ),
);

/** Numbers, times, codes and names: what a fact's value usually is. */
export function valueTokens(text: string) {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\w#$]+|[^\w#$%]+$/g, ""));
  const out = new Set<string>();
  words.forEach((w, i) => {
    if (!w) return;
    const sentenceStart =
      i === 0 || /[.!?;:]$/.test(text.split(/\s+/)[i - 1] ?? "");
    if (/\d/.test(w) || /[#_$]/.test(w) || (/^[A-Z]/.test(w) && !sentenceStart))
      out.add(w.toLowerCase());
  });
  return out;
}

/** The words that say what a note is about, values and filler set aside. */
export function contentWords(text: string) {
  const values = valueTokens(text);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9#$_'-]+/)
      .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
      .filter(
        (w) => w.length > 1 && !STOP.has(w) && !values.has(w) && !/\d/.test(w),
      ),
  );
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/**
 * Whether `next` replaces `prev`, given they've already been found to be
 * clearly about the same thing by meaning (the caller's similarity and
 * margin checks). `similarity` is their cosine similarity.
 */
export function replaces(
  next: string,
  prev: string,
  rule: Rule,
  similarity = 0,
) {
  if (rule === "words") return CHANGE.test(next);
  if (HYPOTHETICAL.test(next)) return false;
  const nv = valueTokens(next);
  const pv = valueTokens(prev);
  const newValue = [...nv].some((v) => !pv.has(v));
  if (CHANGED.test(next)) return true;
  if (!newValue) return false;
  return (
    similarity >= RESTATED ||
    jaccard(contentWords(next), contentWords(prev)) >= SAME_SUBJECT
  );
}
