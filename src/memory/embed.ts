// Local sentence embeddings with all-MiniLM-L6-v2 (quantized, about
// 23 MB, downloaded once and cached by transformers.js).
import { pipeline } from "@huggingface/transformers";

export const MODEL = "Xenova/all-MiniLM-L6-v2";

export async function embedder() {
  const extract = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  return async (texts: string[]) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 256) {
      const t = await extract(texts.slice(i, i + 256), {
        pooling: "mean",
        normalize: true,
      });
      out.push(...(t.tolist() as number[][]));
    }
    return out;
  };
}
