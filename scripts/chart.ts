// Draws results/chart.svg from the newest results JSON: for each server,
// at its better query style, the share of questions answered (top 3) by
// kind, with the 95% range as a thin line. Usage: npm run chart
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wilson } from "../src/score";

type Cell = { n: number; top3: number };
type Report = {
  adapter: string;
  name: string;
  search: string;
  style: string;
  set?: string;
  updates?: string;
  summary: Record<
    "direct" | "reworded" | "situational" | "update" | "decoy",
    Cell
  >;
};

const file = "latest.json";
const data = JSON.parse(readFileSync(join("results", file), "utf8")) as {
  date: string;
  stored: number;
  reports: Report[];
};

// Every server the same way: agent-written queries, the main question
// set; the update groups come from the explicit and implicit runs.
const pick = (updates: string) =>
  data.reports.filter(
    (r) =>
      r.style === "agent" &&
      (r.set ?? "main") === "main" &&
      (r.updates ?? "explicit") === updates &&
      !r.adapter.startsWith("ablation") &&
      r.adapter !== "samefact-memory",
  );
const servers = pick("explicit");
const implicitOf = new Map(pick("implicit").map((r) => [r.adapter, r]));

type Group = { label: string; cell: (r: Report) => Cell };
const KINDS: Group[] = [
  { label: "Asked plainly", cell: (r) => r.summary.direct },
  { label: "Reworded", cell: (r) => r.summary.reworded },
  { label: "Described the situation", cell: (r) => r.summary.situational },
  { label: "Fact changed (said so)", cell: (r) => r.summary.update },
  {
    label: "Fact changed (just restated)",
    cell: (r) => (implicitOf.get(r.adapter) ?? r).summary.update,
  },
  { label: "Survives a false change", cell: (r) => r.summary.decoy },
];
const COLORS = [
  "#8B949E",
  "#D29922",
  "#2F81F7",
  "#A371F7",
  "#F778BA",
  "#3FB950",
];

const W = 1320;
const H = 470;
const left = 70;
const top = 110;
const plotH = 270;
const groupW = (W - left - 30) / KINDS.length;
const barW = 28;
const y = (p: number) => top + plotH * (1 - p);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const parts: string[] = [];
parts.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif">`,
  `<rect width="${W}" height="${H}" fill="#0D1117"/>`,
  `<text x="${left}" y="40" fill="#E6EDF3" font-size="22" font-weight="600">Does your agent's memory find the fact?</text>`,
  `<text x="${left}" y="66" fill="#8B949E" font-size="14">Right answer in the top 3 of ${data.stored.toLocaleString()} notes · ${(JSON.parse(readFileSync("data/facts.json", "utf8")) as unknown[]).length} facts · queries written by an assistant · ${data.date.slice(0, 10)}</text>`,
);
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  parts.push(
    `<line x1="${left}" x2="${W - 30}" y1="${y(t)}" y2="${y(t)}" stroke="#21262D"/>`,
    `<text x="${left - 10}" y="${y(t) + 4}" fill="#6E7681" font-size="12" text-anchor="end">${t * 100}%</text>`,
  );
}
KINDS.forEach(({ label, cell }, g) => {
  const gx =
    left +
    g * groupW +
    (groupW - servers.length * barW - (servers.length - 1) * 8) / 2;
  servers.forEach((s, i) => {
    const c = cell(s);
    const p = c.n ? c.top3 / c.n : 0;
    const { lo, hi } = wilson(c.top3, c.n);
    const x = gx + i * (barW + 8);
    parts.push(
      `<rect x="${x}" y="${y(p)}" width="${barW}" height="${Math.max(1, plotH * p)}" rx="3" fill="${COLORS[i % COLORS.length]}"/>`,
      `<line x1="${x + barW / 2}" x2="${x + barW / 2}" y1="${y(hi)}" y2="${y(lo)}" stroke="#E6EDF3" stroke-opacity="0.45" stroke-width="1.5"/>`,
      `<text x="${x + barW / 2}" y="${y(Math.max(p, hi)) - 8}" fill="#E6EDF3" font-size="13" font-weight="600" text-anchor="middle">${Math.round(p * 100)}%</text>`,
    );
  });
  parts.push(
    `<text x="${left + g * groupW + groupW / 2}" y="${top + plotH + 24}" fill="#C9D1D9" font-size="13" text-anchor="middle">${esc(label)}</text>`,
  );
});
let lx = left;
servers.forEach((s, i) => {
  const short: Record<string, string> = {
    "mcp-server-memory": "Official MCP memory",
    "basic-memory": "basic-memory",
    "chroma-mcp": "Chroma",
    mempalace: "MemPalace",
    mem0: "Mem0 (local 7B LLM)",
  };
  const label = short[s.adapter] ?? s.name;
  parts.push(
    `<rect x="${lx}" y="${H - 42}" width="12" height="12" rx="2" fill="${COLORS[i % COLORS.length]}"/>`,
    `<text x="${lx + 18}" y="${H - 32}" fill="#C9D1D9" font-size="13">${esc(label)}</text>`,
  );
  lx += 18 + label.length * 7.1 + 24;
});
parts.push("</svg>");
writeFileSync("results/chart.svg", parts.join("\n"));
console.log(`Wrote results/chart.svg from ${file}`);
