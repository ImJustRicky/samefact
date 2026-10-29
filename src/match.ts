// Whether a text contains an answer, as a whole word or phrase
// (case-insensitive): "Bun" must not match "bundle", "9:45" must not
// match "19:45".
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function containsValue(text: string, value: string) {
  const re = new RegExp(
    `(^|[^A-Za-z0-9])${escape(value)}($|[^A-Za-z0-9])`,
    "i",
  );
  return re.test(text);
}
