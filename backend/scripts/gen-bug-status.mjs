#!/usr/bin/env node
/**
 * What in the bug ledger is STILL OUTSTANDING — as a command, not as a grep.
 *
 *   node scripts/gen-bug-status.mjs                # the whole ledger
 *   node scripts/gen-bug-status.mjs --open         # only what needs action
 *   node scripts/gen-bug-status.mjs --match autocount   # filter by text
 *   node scripts/gen-bug-status.mjs --check        # fail on an undefined status
 *
 * WHY THIS EXISTS. The owner, 2026-09-08: 「彻底检查之前和这次做的东西 然后 fix
 * 所有的问题 要不然 fix 了很久了 还是一样的问题」— the same problems keep coming
 * back after being fixed. The ledger is the memory that should prevent that, and
 * until today it had no field saying whether an entry was still open. So every
 * session re-derived it from prose, and the derivation was wrong BOTH ways:
 *
 *  · A whole-ledger sweep for "unfixed" returned 138 files and was read as a
 *    backlog. 126 of those use the word ONLY in "fails on the unfixed tree" —
 *    this repo's TDD phrase for proving a test red before the fix, i.e. evidence
 *    the bug WAS fixed. The reported backlog was mostly an artefact of the
 *    instrument.
 *  · Entries whose repair had been applied to production weeks earlier still
 *    opened "planned but not applied", because nothing brought the writer back
 *    to the file after the run. Three of those were found on 2026-09-08 in the
 *    PO line-discount chain alone (0662, 0664, 0665), all three applied.
 *
 * A COUNT HERE IS NOT A CLAIM THAT THE WORK IS DONE. It reports what the entries
 * SAY. An entry saying `fixed` is a person's assertion; this tool's job is to
 * make that assertion explicit, greppable and correctable — not to verify it.
 * The verification is still the run id in the entry body.
 *
 * NO DEPENDENCIES beyond the ledger lib, so it runs in a fresh worktree.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUG_DIR, STATUS_VALUES, readEntries } from "./lib/bug-ledger.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] ?? "" : null;
};

const onlyOpen = has("--open");
const check = has("--check");
const match = valueOf("--match");

const { entries } = readEntries(REPO);
if (entries.length === 0) {
  console.error(`${BUG_DIR} parsed ZERO entries — refusing to report on nothing.`);
  process.exit(2);
}

const filtered = match ? entries.filter((e) => new RegExp(match, "i").test(e.text)) : entries;

const buckets = new Map([...STATUS_VALUES].map((s) => [s, []]));
const untagged = [];
const invalid = [];
for (const e of filtered) {
  if (e.statusInvalid) invalid.push(e);
  else if (e.status) buckets.get(e.status).push(e);
  else untagged.push(e);
}

const denom = filtered.length;
const pct = (n) => (denom === 0 ? "0.0" : ((n / denom) * 100).toFixed(1));

console.log(`BUG LEDGER STATUS — ${denom} entr${denom === 1 ? "y" : "ies"}${match ? ` matching /${match}/i` : ""} of ${entries.length} total`);
console.log("");
for (const s of STATUS_VALUES) {
  const n = buckets.get(s).length;
  console.log(`  ${s.padEnd(15)} ${String(n).padStart(4)}  (${pct(n)}%)`);
}
console.log(`  ${"(no status)".padEnd(15)} ${String(untagged.length).padStart(4)}  (${pct(untagged.length)}%)  <- state UNKNOWN, not "fixed"`);
if (invalid.length) console.log(`  ${"(undefined)".padEnd(15)} ${String(invalid.length).padStart(4)}  <- a status nobody defined`);

/** The two buckets a reader has to DO something about. */
const actionable = [...buckets.get("open"), ...buckets.get("owner-decision")].sort((a, b) => b.ordinal - a.ordinal);

if (actionable.length) {
  console.log("");
  console.log(`═══ STILL OUTSTANDING: ${actionable.length} ═══`);
  for (const e of actionable) {
    console.log(`  ${String(e.ordinal).padStart(4, "0")}  [${e.status}]  ${e.parsed?.title?.slice(0, 78) ?? e.slug}`);
    console.log(`        ${e.file}`);
  }
}

if (invalid.length) {
  console.log("");
  console.log("═══ UNDEFINED STATUS — invisible to every reader that filters ═══");
  for (const e of invalid) console.log(`  ${e.file}: <!-- status: ${e.statusInvalid} -->`);
}

if (!onlyOpen && untagged.length) {
  console.log("");
  console.log(`${untagged.length} entr${untagged.length === 1 ? "y" : "ies"} carry no status tag. That is not a backlog and not a`);
  console.log(`clean bill of health — it is the ledger declining to answer. Tag one when you`);
  console.log(`touch it: add \`<!-- status: fixed -->\` (or open / owner-decision / superseded)`);
  console.log(`under the title, beside \`<!-- area: ... -->\`.`);
}

if (check && invalid.length) {
  console.error("");
  console.error(`BUG-STATUS: ${invalid.length} entr(y/ies) carry a status that is not one of ${[...STATUS_VALUES].join(" / ")}.`);
  process.exit(1);
}
