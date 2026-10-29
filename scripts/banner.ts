// Renders assets/banner.png: a terminal window showing a real samefact
// run, built from the newest results file, so the banner never shows a
// number the results don't. Needs Google Chrome for the screenshot.
// Usage: npm run banner
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Cell = { n: number; top3: number; stale: number };
type Report = {
  adapter: string;
  name: string;
  style: string;
  set: string;
  updates: string;
  summary: Record<"reworded" | "situational" | "update", Cell>;
};

const file = "latest.json";
const data = JSON.parse(readFileSync(join("results", file), "utf8")) as {
  stored: number;
  reports: Report[];
};
const SHOW: Record<string, string> = {
  "mcp-server-memory": "mcp-server-memory",
  "basic-memory": "basic-memory",
  "chroma-mcp": "chroma",
  mempalace: "mempalace",
  mem0: "mem0",
};
const rows = data.reports.filter(
  (r) =>
    r.style === "agent" &&
    r.set === "main" &&
    r.updates === "explicit" &&
    SHOW[r.adapter],
);
const pct = (k: number, n: number) =>
  `${Math.round((100 * k) / Math.max(1, n))}%`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

const lines = [
  `<span class="p">$</span> npx github:ImJustRicky/samefact`,
  `<span class="dim">Right answer in the top 3 of ${data.stored.toLocaleString()} notes.</span>`,
  "",
  `<span class="h">${esc(pad("memory", 20))}${pad("reworded", 11)}${pad("fact changed", 15)}stale first</span>`,
  ...rows.map((r) => {
    const u = r.summary.update;
    const stale = u.stale / Math.max(1, u.n);
    return `${esc(pad(SHOW[r.adapter]!, 20))}${pad(pct(r.summary.reworded.top3, r.summary.reworded.n), 11)}${pad(pct(u.top3, u.n), 15)}<span class="${stale >= 0.25 ? "bad" : "ok"}">${pct(u.stale, u.n)}</span>`;
  }),
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;width:1600px;height:640px;background:#0d1117;font-family:Inter,system-ui,sans-serif}
  .wrap{display:flex;align-items:center;height:100%;padding:0 88px;gap:72px;box-sizing:border-box}
  .left{flex:0 0 470px;color:#e6edf3}
  .name{font-size:76px;font-weight:700;letter-spacing:-2px;margin:0}
  .tag{font-size:26px;line-height:1.35;color:#8b949e;margin:18px 0 0;font-weight:600}
  .term{flex:1;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden}
  .bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid #30363d}
  .dot{width:12px;height:12px;border-radius:50%;background:#30363d}
  pre{margin:0;padding:26px 30px 30px;font:400 19px/1.65 "JetBrains Mono",monospace;color:#c9d1d9;white-space:pre}
  .p{color:#3fb950}.dim{color:#6e7681}.h{color:#8b949e;font-weight:600}
  .bad{color:#f85149;font-weight:600}.ok{color:#3fb950;font-weight:600}
</style></head><body><div class="wrap">
  <div class="left"><p class="name">samefact</p>
  <p class="tag">Does your agent's memory find the fact in new words, and the new answer after it changes?</p></div>
  <div class="term"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <pre>${lines.join("\n")}</pre></div>
</div></body></html>`;

mkdirSync("assets", { recursive: true });
writeFileSync("assets/banner.html", html);
execFileSync(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=1600,640",
    "--virtual-time-budget=4000",
    `--screenshot=${join(process.cwd(), "assets/banner.png")}`,
    `file://${join(process.cwd(), "assets/banner.html")}`,
  ],
  { stdio: "ignore" },
);
console.log(`Wrote assets/banner.png from ${file}`);
