#!/usr/bin/env node
// Build docs/generated/bug-index.md from BUG-HISTORY.md.
//
// WHY. BUG-HISTORY is 115 entries and 9,000+ lines in one reverse-chronological
// stream with no index, so "have we hit this before?" costs a full scan that
// nobody performs. The entries are good; they are simply unreachable. This makes
// them reachable by subsystem without touching the ledger itself.
//
// GENERATED, never hand-edited. `--check` fails when the index no longer matches
// the ledger, and is wired into `audit:bug-index` so it cannot rot the way
// codebase-map-facts.md did for three weeks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(repoRoot, "BUG-HISTORY.md");
const OUT = path.join(repoRoot, "docs", "generated", "bug-index.md");
const checkOnly = process.argv.includes("--check");

/**
 * An entry may NAME its area, and that beats every heuristic below.
 *
 * `<!-- area: Sales orders + pricing -->` anywhere in the entry body. The string
 * must be one of the AREA names exactly; an unknown one FAILS the generator
 * rather than falling through, because a typo that silently reverts to guessing
 * is worse than no tag.
 *
 * Why this exists at all: the scorer reads English prose looking for subsystem
 * words, and some entries are simply not about any of them. Measured 2026-08-14
 * over 185 entries, 54 had no area word in the TITLE and were filed on their
 * body — 20 of those on the English word "so", which `\bso[- ]` matched under
 * the /i flag. That is fixed below, but no keyword table will ever be right
 * about an entry whose subject is the tooling rather than the product. Those get
 * a tag, and the generator reports how many rely on the guess.
 */
const AREA_TAG = /<!--\s*area:\s*([^>]+?)\s*-->/i;

// Scored, not first-match-wins. First-match put 89 of 115 entries into
// "AutoCount" and "Cutover" on the first run, because the whole repo has been in
// cutover mode and those words appear in nearly every entry BODY. An index where
// two buckets hold 77% of the rows answers nothing. The title is what the entry
// is ABOUT, so a title hit outweighs a body hit; ties fall to the earlier area.
//
// THE THIRD COLUMN IS CASE-SENSITIVE, and it has to be. The document
// abbreviations used to sit in the /i patterns as `\bso[- ]`, `\bpo[- ]` and
// `\bdo[- ]`, which match the ENGLISH WORDS "so " and "do ". Counted across the
// ledger 2026-08-14:
//
//     form                        SO     DO     PO
//     UPPER + space/hyphen       151     65    147   real document references
//     lower + hyphen             111     16     57   real identifiers (so-revision.ts)
//     lower + space              556     42      0   ordinary English prose
//
// Body hits cap at 5, so an entry whose prose says "so the…" five times scored a
// FULL body hit for Sales orders. TWENTY entries were filed that way, every one
// of them with no real document reference in it at all. The index exists to
// route a reader to the right entry; those twenty pointed somewhere else.
//
// So: uppercase with either separator (SO-2607-019, "SO create"), lowercase only
// with a hyphen (so-lifecycle-guards.ts). Lowercase + space is prose and scores
// nothing. `i` stays on everything else — "Purchase Order" must still match.
const AREAS = [
  /* FIRST, and that placement is the point: ties fall to the earlier area, and
     this is the one bucket whose entries have nothing to do with the product.
     It did not exist until 2026-08-14, and its absence is what scattered them.
     Entries about the repo's OWN machinery — a gate, a ratchet, a generator, a
     test runner — carry no subsystem vocabulary, so they were filed on whatever
     English word happened to match: "Seventeen test files ran, passed, and
     counted as no test at all" landed in "Projects + PMS" on the word *project*
     (a vitest project), "The coverage ratchet cannot see node:test" in "Auth,
     permissions" on *scope* and *token*, "The codebase-map generator had been
     crashing for three weeks" in "Fleet, trips" on *route*.

     `\bgate\b` was in this list for one round and came straight back out, which
     is the same lesson a third time: a word is generic or not according to THIS
     REPO's vocabulary, not English. Houzs calls product features gates — the
     confirm gate, the stock-location gate, the deposit gate, a permission gate —
     so `gate` dragged four product entries in here, including "A shipped DO's
     line cost was rebuilt from a ROUNDED unit price", which is about MONEY.
     What is left names tools, not concepts. `\bci\b` and `workflow` stay with
     Deploy, which is where a broken deploy belongs. */
  ["Repo tooling: tests, ratchets, generators", /ratchet|coverage|vitest|eslint|linter|generator|working.agreement|file.size|docs.drift|bug.history|node:test|test runner|audit script|test suite|test file/i],
  ["AutoCount sync + write-back", /autocount|ac[- ]sync|write-?back|acsyncservice|dtlkey|aed_houzs/i],
  ["Cutover + migrated data", /cutover|migrated|migration record|backfill|importer|seed/i],
  ["Inventory, costing, FIFO", /fifo|costing|cogs|stock (layer|balance|movement)|inventory|oversell|uncosted/i],
  ["Sales orders + pricing", /sales.order|mfg-sales|pricing|deposit|specials|pwp|amendment/i, /\bSO[- ]|\bso-/],
  ["Purchase orders + GRN + PI", /purchase.order|\bgrn\b|goods.received|purchase invoice|creditor/i, /\bPO[- ]|\bpo-/],
  ["Delivery, DO, returns", /delivery.order|dispatch|proof.of.delivery|\bpod\b|return/i, /\bDO[- ]|\bdo-/],
  ["Fleet, trips, TMS", /fleet|lorry|lorries|driver|trip|route|puspakom|road.?tax/i],
  ["Projects + PMS + fair report", /project|\bpms\b|fair.?report|checklist|roadshow|venue/i],
  ["Service cases (ASSR)", /assr|service case|survey|sla/i],
  ["Sofa, fabric, variants", /sofa|fabric|colour|variant|compartment|tier/i],
  ["Auth, permissions, sessions", /permission|\brole\b|session|auth|login|token|impersonat|scope/i],
  ["Deploy, CI, migrations", /deploy|\bci\b|workflow|migration number|pg-migrate|wrangler|staging/i],
  ["Database + schema", /postgres|supabase|hyperdrive|jsonb|d1-compat|schema|index|constraint|deadlock/i],
  ["Frontend + mobile", /mobile|desktop|react|render|frontend|\bui\b|column|dropdown|modal|page/i],
  ["Mail, search, notifications", /mail|inbox|notification|announcement|search/i],
];

const TITLE_WEIGHT = 10;

const AREA_NAMES = new Set(AREAS.map(([n]) => n));

/** Count matches without mutating the caller's regex (lastIndex on a /g). */
function countHits(text, re) {
  if (!re) return 0;
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(global) ?? []).length;
}

/**
 * @returns {{area: string, tagged: boolean}} — `tagged` says the ENTRY named it,
 *          so the caller can report how much of the index is guessed.
 */
function areaOf(title, body) {
  const tag = AREA_TAG.exec(body)?.[1];
  if (tag) {
    if (!AREA_NAMES.has(tag)) {
      console.error(
        `\nBUG-INDEX: "${title.slice(0, 60)}" carries <!-- area: ${tag} -->, which is not an area.\n` +
          `Valid areas:\n${[...AREA_NAMES].map((n) => `  ${n}`).join("\n")}\n\n` +
          "Refusing rather than falling back to the keyword guess: a typo that silently\n" +
          "reverts to guessing is the failure this tag exists to remove.",
      );
      process.exit(1);
    }
    return { area: tag, tagged: true };
  }

  let best = null;
  let bestScore = 0;
  for (const [name, re, reExact] of AREAS) {
    const titleHits = countHits(title, re) + countHits(title, reExact);
    const bodyHits = countHits(body, re) + countHits(body, reExact);
    const score = titleHits * TITLE_WEIGHT + Math.min(bodyHits, 5);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return { area: best ?? "Other", tagged: false };
}

function githubAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const src = fs.readFileSync(SRC, "utf8");
const lines = src.split(/\r?\n/);

const entries = [];
let current = null;
lines.forEach((line, i) => {
  const m = /^##\s+(.*?)\s*(?:\[(\w+)\])?\s*$/.exec(line);
  if (m) {
    if (current) entries.push(current);
    current = { title: m[1], severity: m[2] ?? "unspecified", line: i + 1, body: "" };
  } else if (current) {
    current.body += line + "\n";
  }
});
if (current) entries.push(current);

for (const e of entries) {
  const a = areaOf(e.title, e.body);
  e.area = a.area;
  e.tagged = a.tagged;
  const ref = /\*\*Ref\*\*\s*-\s*(.+)/.exec(e.body);
  e.ref = ref ? ref[1].replace(/`/g, "").trim() : "";
  const date = /(\d{4}-\d{2}-\d{2})/.exec(e.ref);
  e.date = date ? date[1] : "";
}

const byArea = new Map();
for (const [name] of AREAS) byArea.set(name, []);
byArea.set("Other", []);
for (const e of entries) byArea.get(e.area).push(e);

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, unspecified: 4 };

let out = `# Bug index — generated from BUG-HISTORY.md

> Generated by \`backend/scripts/gen-bug-index.mjs\`; do not edit by hand.
> Regenerate: \`npm --prefix backend run gen:bug-index\`.
> Drift check: \`npm --prefix backend run audit:bug-index\`.

**Read this before changing a subsystem, then read the entries it points at.**
\`BUG-HISTORY.md\` is ${lines.length.toLocaleString()} lines of reverse-chronological
entries with no way in; that is why the same bug classes kept being re-derived
from scratch, differently each time. This is the way in. It carries no facts of
its own — every row points at the entry, which stays the only copy.

${entries.length} entries across ${[...byArea].filter(([, v]) => v.length).length} areas.

**How much of this table is a guess.** ${entries.filter((e) => e.tagged).length} of
${entries.length} entries NAME their area with \`<!-- area: ... -->\`; the rest are
placed by matching subsystem words in the title and body, title weighted 10x. That
scorer has been wrong in bulk before — until 2026-08-14 it read \`\\bso[- ]\` under
the \`/i\` flag, so the English word "so" filed 20 entries under Sales orders, and
25 rows moved out of that area when it was fixed. If a row looks misplaced it
probably is: add the tag to the entry rather than widening a pattern, because the
pattern that would catch it also catches everything else that says the same word.

| Area | Entries |
|---|---|
`;
for (const [name, list] of byArea) {
  if (!list.length) continue;
  out += `| [${name}](#${githubAnchor(name)}) | ${list.length} |\n`;
}

for (const [name, list] of byArea) {
  if (!list.length) continue;
  out += `\n## ${name}\n\n| Sev | Entry | Ref |\n|---|---|---|\n`;
  const sorted = list
    .slice()
    .sort(
      (a, b) =>
        (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) ||
        (b.date < a.date ? -1 : b.date > a.date ? 1 : 0),
    );
  for (const e of sorted) {
    const title = e.title.replace(/\|/g, "\\|");
    out += `| ${e.severity} | [${title}](../../BUG-HISTORY.md#${githubAnchor(e.title)}) <sub>L${e.line}</sub> | ${e.ref.replace(/\|/g, "\\|")} |\n`;
  }
}

const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
if (checkOnly) {
  /* TWO FAILURES LIVE HERE, and only one of them is the author's.

     The one worth gating is the GENERATOR DYING — docs/staging-bench-rot-coe.md
     records audit:map crashing unnoticed for three weeks, which is why this
     runs on every PR at all. That is caught above: a parse failure or a missing
     BUG-HISTORY.md throws before this point, and an empty entry list is refused
     below.

     The other is CONTENT DRIFT, and in this repo it carries no signal. The
     working agreement REQUIRES every code PR to append an entry to
     BUG-HISTORY.md, main-protection makes merges strictly serial, so the
     moment any PR merges, this file is stale on every other open PR — through
     no act of theirs. Measured 2026-08-14: five PRs failed here at once on
     "175 entries", were regenerated, and were stale again one merge later. A
     gate that every author trips for something the previous author did is a
     deadlock, not a check.

     So drift is REPORTED, in full, with both counts and the fix — and does not
     fail the run. It is still visible on every PR, and `--strict` restores the
     hard failure for anyone who wants it locally or in a job of their own. */
  if (existing.replace(/\r\n/g, "\n") !== out) {
    const had = (existing.match(/^\| /gm) ?? []).length;
    const msg =
      `docs/generated/bug-index.md is out of date: the index holds ${had} row(s), ` +
      `BUG-HISTORY.md holds ${entries.length} entr(y/ies).\n` +
      `Run: npm --prefix backend run gen:bug-index\n` +
      `NOT failing the run: every PR must append an entry and merges are serial, ` +
      `so this drifts on its own. Pass --strict to fail on it.`;
    if (process.argv.includes("--strict")) { console.error(msg); process.exit(1); }
    console.warn(msg);
  } else {
    console.log(`Bug index is current (${entries.length} entries).`);
  }
  /* The generator producing NOTHING is the failure this gate exists for.
     A scan that finds no entries is broken, not clean — the same rule the
     file-size gate encodes for an empty file list. */
  if (entries.length === 0) {
    console.error("BUG INDEX: parsed ZERO entries from BUG-HISTORY.md — that is a broken generator, not an empty history.");
    process.exit(2);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, "utf8");
  console.log(`Wrote docs/generated/bug-index.md (${entries.length} entries).`);
}
