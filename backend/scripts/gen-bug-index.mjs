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
import { execFileSync } from "node:child_process";
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
  ["Accounting + GL", /journal|ledger|\bgl\b|chart of accounts|account.code|trial balance|debit|credit|posting engine|payment voucher|reversal/i],
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
/** Entries whose `<!-- area: -->` names nothing. Collected, not thrown on —
 *  WHO introduced the tag decides whether it fails the run. See chargeBadAreaTags. */
const badAreaTags = [];

function areaOf(title, body) {
  const tag = AREA_TAG.exec(body)?.[1];
  if (tag) {
    if (!AREA_NAMES.has(tag)) {
      /* This used to `process.exit(1)` right here, unconditionally, and that
         turned one bad merge into a repo-wide CI blackout.

         `audit:bug-index` runs inside `backend-typecheck`, which IS a required
         status check, and this file is the ONE file the working agreement makes
         every code PR append to. So an unparseable tag reaching `main` fails
         every open PR AND makes the generator unrunnable, so nobody can even
         regenerate their way out. Measured 2026-08-17: commit 6c9f8cbd landed a
         `<!-- area: PMS My Pending lanes -->` at 04:00:21Z; between then and the
         repair (#2351, merged 04:59:53Z) five of five PR-branch CI runs were
         red, and three of those four branches had no connection to it at all.

         The file already encodes the right rule for content DRIFT a few hundred
         lines down — "a gate that every author trips for something the previous
         author did is a deadlock, not a check" — and this validation simply
         predated it. Same rule now applies here, and it is the same rule
         check-file-size.mjs uses for an inherited ceiling violation: REPORT in
         full, always; CHARGE only the change that introduced it. */
      badAreaTags.push({ title, tag });
      // Fall through to the keyword guess. The objection recorded here was to a
      // typo reverting to guessing SILENTLY — it is not silent: every run prints
      // the entry and the bad tag until somebody fixes it.
    } else {
      return { area: tag, tagged: true };
    }
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

/** Split a ledger into entries. Shared with the merge-base copy, so "was this
 *  entry already there?" is asked of the SAME shape it is asked of here. */
function parseEntries(text) {
  const out = [];
  let cur = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^##\s+(.*?)\s*(?:\[(\w+)\])?\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[1], severity: m[2] ?? "unspecified", line: i + 1, body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  });
  if (cur) out.push(cur);
  return out;
}

const src = fs.readFileSync(SRC, "utf8");
const lines = src.split(/\r?\n/);
const entries = parseEntries(src);

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

/**
 * BUG-HISTORY.md as it stands at the merge base, or null when that cannot be
 * resolved (shallow clone, no origin/main). Null means "cannot tell whose fault
 * it is", and the caller then charges everything — the same choice
 * check-file-size.mjs makes, for the same reason.
 */
function ledgerAtMergeBase() {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    git(["rev-parse", "--verify", "--quiet", "origin/main"]);
    const base = git(["merge-base", "HEAD", "origin/main"]).trim();
    if (!base) return null;
    return git(["show", `${base}:BUG-HISTORY.md`]);
  } catch {
    return null;
  }
}

/**
 * Report every unparseable area tag; fail only on the ones THIS change added.
 *
 * Matched by ENTRY (title + the exact tag it carries), not by counting tag
 * strings. Counting gets the verdict right but names the wrong entry whenever
 * one broken tag appears twice — and a gate whose whole purpose is to blame the
 * right person must not misidentify who that is.
 */
function chargeBadAreaTags() {
  if (badAreaTags.length === 0) return;

  const base = ledgerAtMergeBase();
  /** `title\u0000tag` for every entry that ALREADY carried this bad tag at the base. */
  const atBase = new Set();
  if (base !== null) {
    for (const e of parseEntries(base)) {
      const tag = AREA_TAG.exec(e.body)?.[1];
      if (tag && !AREA_NAMES.has(tag)) atBase.add(`${e.title}\u0000${tag}`);
    }
  }

  const mine = [];
  const inherited = [];
  for (const bad of badAreaTags) {
    if (base !== null && atBase.has(`${bad.title}\u0000${bad.tag}`)) inherited.push(bad);
    else mine.push(bad);
  }

  const show = (b) => `  "${b.title.slice(0, 60)}" carries <!-- area: ${b.tag} -->`;

  if (inherited.length) {
    console.warn(
      `\nBUG-INDEX: ${inherited.length} entr(y/ies) carry an area tag that names nothing, ` +
        `and came from an earlier merge — reported, NOT charged to this change:\n` +
        inherited.map(show).join("\n") +
        `\nThese fall back to the keyword guess, so the index still builds. ` +
        `They should be fixed, but not by whoever is holding this branch.`,
    );
  }

  if (mine.length) {
    console.error(
      `\nBUG-INDEX: this change adds ${mine.length} entr(y/ies) whose area tag is not an area:\n` +
        mine.map(show).join("\n") +
        `\n\nValid areas:\n${[...AREA_NAMES].map((n) => `  ${n}`).join("\n")}\n\n` +
        (base === null
          ? "The merge base could not be resolved, so every bad tag is charged here — a gate\n" +
            "that cannot tell whose fault it is must not let anything through.\n"
          : "") +
        "Refusing rather than falling back to the keyword guess: a typo that silently\n" +
        "reverts to guessing is the failure this tag exists to remove.",
    );
    process.exit(1);
  }
}

chargeBadAreaTags();

if (checkOnly) {
  /* THE INDEX IS NO LONGER TRACKED, so there is nothing to compare against and
     CONTENT DRIFT no longer exists as a concept here. That is the point.

     What used to live here was a drift comparison against the committed copy.
     It never gated anything — it warned, because the working agreement REQUIRES
     every code PR to append to BUG-HISTORY.md and main-protection makes merges
     strictly serial, so the committed index went stale on every open PR the
     moment any other PR merged, through no act of theirs. Measured 2026-08-14:
     five PRs tripped it at once, were regenerated, and were stale again one
     merge later.

     Softening it to a warning removed the deadlock but kept the real cost: a
     GENERATED file in git that every single PR rewrites. All 50 of the last 50
     commits on main touched it, so any two concurrent PRs conflicted on it —
     by construction, not by carelessness. Four conflicts on one small PR on
     2026-08-18 is what finally bought this change.

     Nothing read the committed copy: the only references to it in the tree were
     this generator and this gate. So it was a file that existed to be checked
     against itself, at the price of a guaranteed conflict per PR.

     WHAT IS GIVEN UP, stated rather than hidden: the index is no longer
     browsable on GitHub. That is a real loss and a small one — it was routinely
     wrong anyway, since drift was tolerated by design. Anyone who wants it runs
     `npm --prefix backend run gen:bug-index` and reads it locally.

     WHAT IS KEPT is the failure this gate was built for: the GENERATOR DYING.
     docs/staging-bench-rot-coe.md records audit:map crashing unnoticed for
     three weeks. A parse failure or a missing BUG-HISTORY.md throws before this
     point, an unresolvable area tag exits 1 in chargeBadAreaTags() above, and an
     empty entry list is refused below. None of those ever needed a copy in git. */
  console.log(`Bug index generates cleanly (${entries.length} entries parsed from BUG-HISTORY.md).`);

  /* The generator producing NOTHING is the failure this gate exists for.
     A scan that finds no entries is broken, not clean — the same rule the
     file-size gate encodes for an empty file list. */
  if (entries.length === 0) {
    console.error("BUG INDEX: parsed ZERO entries from BUG-HISTORY.md — that is a broken generator, not an empty history.");
    process.exit(2);
  }
  /* A verdict computed over a suspiciously small corpus is worth naming too:
     the ledger only grows, so a sudden collapse is a parser regression rather
     than a tidy-up. Reported, not gated — the floor would need maintaining, and
     an unmaintained floor is the next stale number. */
  if (entries.length < 100) {
    console.warn(`BUG INDEX: only ${entries.length} entries parsed. This ledger has held 300+ since 2026-08; check the parser before trusting that.`);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, "utf8");
  console.log(`Wrote docs/generated/bug-index.md (${entries.length} entries).`);
}
