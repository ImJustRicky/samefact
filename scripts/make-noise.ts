// Writes data/noise.json: 1,000 everyday notes stored around the facts,
// so they have to be found among near neighbours, not among a few dozen
// sentences. First the human-style notes in data/notes-written.json
// (written by a separate model as the clutter real memories fill up
// with), then seeded templates on the same topics to make up 1,000. None
// contains any fact's answer, so they can only ever be wrong answers.
// Usage: npx tsx scripts/make-noise.ts
import { readFileSync, writeFileSync } from "node:fs";
import { containsValue } from "../src/match";

const COUNT = 1000;
let seed = 20261029;
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const num = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const people = [
  "Sam",
  "Nadia",
  "Chris",
  "Elena",
  "Omar",
  "Grace",
  "Wes",
  "Lina",
  "Jonah",
  "Keiko",
  "Ravi",
  "Beth",
  "Malik",
  "Ines",
  "Tyler",
  "Hana",
  "Diego",
  "Mara",
  "Felix",
  "Zoe",
];
const days = ["Monday", "Wednesday", "Friday", "Saturday", "Sunday"];
const months = [
  "January",
  "February",
  "May",
  "July",
  "August",
  "October",
  "November",
];
const places = [
  "the library",
  "the farmers market",
  "the climbing gym",
  "the hardware store",
  "the pool",
  "the bakery",
  "the bank",
  "the post office",
  "the pharmacy",
  "the barber",
];
const foods = ["sesame", "shellfish", "strawberries", "gluten", "eggs", "soy"];
const drinks = [
  "matcha latte",
  "cold brew",
  "chai",
  "americano",
  "hot chocolate",
  "mocha",
];
const cities = [
  "Boston",
  "Seattle",
  "Portland",
  "Atlanta",
  "Phoenix",
  "Raleigh",
  "Nashville",
  "Chicago",
];
const services = [
  "auth",
  "notifications",
  "search indexing",
  "reporting",
  "billing exports",
  "image resizing",
  "webhooks",
  "admin panel",
  "onboarding emails",
  "mobile API",
];
const tools = [
  "Prettier",
  "ESLint",
  "Docker Compose",
  "Terraform",
  "GitHub Actions",
  "Storybook",
  "Playwright",
  "Turborepo",
  "Renovate",
  "Kafka",
];
const teams = [
  "Platform",
  "Growth",
  "Mobile",
  "Data",
  "Infra",
  "Design Systems",
  "Support Tools",
];

const personal = [
  () => `${pick(places)} closes at ${num(5, 9)} PM on ${pick(days)}s.`,
  () =>
    `My cousin ${pick(people)} is visiting ${pick(cities)} in ${pick(months)}.`,
  () => `The gym gets crowded around ${num(5, 7)} PM on weekdays.`,
  () => `I need to renew my library card before ${pick(months)}.`,
  () => `${pick(people)} said the dentist down the street has weekend hours.`,
  () => `My neighbor ${pick(people)} is allergic to ${pick(foods)}.`,
  () =>
    `The coffee shop on Elm has a ${pick(drinks)} special on ${pick(days)}s.`,
  () =>
    `${pick(people)}'s birthday party is on a ${pick(days)} in ${pick(months)}.`,
  () => `Recycling goes out every other ${pick(days)}.`,
  () =>
    `The kids have swim lessons at ${pick(places)} on ${pick(days)} mornings.`,
  () => `I left my umbrella at ${pick(places)} last week.`,
  () => `${pick(people)} recommended a mechanic near the highway exit.`,
  () => `The lake house needs the gutters cleaned before ${pick(months)}.`,
  () =>
    `My flight to ${pick(cities)} last spring was delayed ${num(2, 5)} hours.`,
  () => `The parking garage downtown charges $${num(12, 30)} a day.`,
  () => `${pick(people)} borrowed my ladder and hasn't returned it.`,
  () => `I want to try the new ramen place in ${pick(cities)}.`,
  () => `The pharmacy texts when a prescription is ready for pickup.`,
  () => `${pick(people)} prefers a window seat on long trips.`,
  () => `The dog park is muddy after rain, so bring old towels.`,
];

const work = [
  () =>
    `The ${pick(services)} service is maintained by the ${pick(teams)} team.`,
  () =>
    `${pick(people)} is reviewing the ${pick(services)} refactor this sprint.`,
  () => `We added ${pick(tools)} to the repo in ${pick(months)}.`,
  () => `The ${pick(services)} job runs nightly at ${num(1, 4)} AM UTC.`,
  () => `Retro is every other ${pick(days)} afternoon.`,
  () => `${pick(people)} owns the ${pick(tools)} configuration.`,
  () =>
    `The ${pick(services)} endpoint has a rate limit of ${num(50, 500)} requests per minute.`,
  () => `Design review for ${pick(services)} is scheduled for ${pick(days)}.`,
  () => `${pick(people)} is out of office until ${pick(months)} ${num(2, 28)}.`,
  () => `The ${pick(teams)} team wants fewer flaky tests in CI.`,
  () => `We are evaluating ${pick(tools)} for the monorepo.`,
  () => `The ${pick(services)} dashboard lives in the ops folder.`,
  () => `${pick(people)} wrote the runbook for ${pick(services)} incidents.`,
  () => `Code freeze for the ${pick(months)} release starts a week before.`,
  () => `The ${pick(services)} migration is blocked on a schema change.`,
  () => `${pick(teams)} demos happen at the end of each sprint.`,
  () => `${pick(people)} asked for more logging in ${pick(services)}.`,
  () => `The intern project this summer is a CLI for ${pick(services)}.`,
  () => `Pull requests need one approval from the ${pick(teams)} team.`,
  () => `The ${pick(services)} load test is planned for ${pick(months)}.`,
];

const facts = JSON.parse(readFileSync("data/facts.json", "utf8")) as {
  value: string;
  lookalikes?: { value: string }[];
  update?: { value: string };
}[];
const values = facts.flatMap((f) => [
  f.value,
  ...(f.lookalikes ?? []).map((l) => l.value),
  ...(f.update ? [f.update.value] : []),
]);

const factText = new Set(
  (
    JSON.parse(readFileSync("data/facts.json", "utf8")) as {
      stored: string;
      lookalikes?: { stored: string }[];
    }[]
  ).flatMap((f) => [f.stored, ...(f.lookalikes ?? []).map((l) => l.stored)]),
);
const clean = (note: string) =>
  !factText.has(note) && !values.some((v) => containsValue(note, v));

const out = new Set<string>();
for (const note of JSON.parse(
  readFileSync("data/notes-written.json", "utf8"),
) as string[])
  if (out.size < COUNT && clean(note)) out.add(note);
let tries = 0;
while (out.size < COUNT && tries < COUNT * 50) {
  tries += 1;
  const note = pick(rand() < 0.5 ? personal : work)();
  if (!clean(note)) continue;
  out.add(note);
}
writeFileSync("data/noise.json", JSON.stringify([...out], null, 1) + "\n");
console.log(`Wrote ${out.size} notes`);
