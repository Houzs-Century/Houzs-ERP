#!/usr/bin/env node
/* compare-tally-verdicts — the SAME six document types, measured twice, printed
 * side by side.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * A reader change moves figures on all six document types, and the only honest
 * way to show what it did is to measure all six BEFORE and AFTER in one run
 * against one book snapshot. Two runs a day apart are two measurements of two
 * different corpora wearing one sentence — the failure lib/so-tally-verdict.mjs
 * was built to end.
 *
 * The caller runs check-ac-erp-reconcile.mjs twice into two VERDICT_DIRs, with
 * nothing changed between them except the READER files under test. This reads
 * the two sets of verdict payloads and prints the difference.
 *
 * ── IT MEASURES NOTHING, AND IT WRITES NOTHING ──────────────────────────────
 * Every number comes out of the reconcile's own verdict files, classified by
 * `tallyVerdict` — the one implementation of "different" this repo allows. It
 * opens no database and no network. There is no MODE=apply because there is
 * nothing to apply: it is a report about two reports.
 *
 * A NUMBER THAT GOES UP IS A LEGITIMATE RESULT and is printed as one. What must
 * never happen quietly is a number going DOWN because a comparison stopped
 * happening, so `compared` and `population` are printed beside `differ` on both
 * sides: a `differ` that fell while `compared` fell with it is not a fix, and
 * this table is what makes that visible instead of arguable.
 *
 * RE-RUN: inert and idempotent. It reads two directories and prints.
 *
 * Usage:
 *   BEFORE_DIR=... AFTER_DIR=... [TYPES=SO,PO,GR,DO,IV,PI] node scripts/compare-tally-verdicts.mjs
 */
import fs from "node:fs";
import path from "node:path";

import { docTypeSpec, tallyVerdict } from "./lib/so-tally-verdict.mjs";

const BEFORE_DIR = String(process.env.BEFORE_DIR || "").trim();
const AFTER_DIR = String(process.env.AFTER_DIR || "").trim();
const TYPES = String(process.env.TYPES || "SO,PO,GR,DO,IV,PI")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const plain = (m) => console.log(m);
const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

if (!BEFORE_DIR || !AFTER_DIR) refuse("BEFORE_DIR and AFTER_DIR must both be set.");
for (const t of TYPES) docTypeSpec(t); // a typo must not silently report on nothing

/** One side's verdict for one type, or a stated reason it has none. */
function read(dir, type) {
  const file = path.join(dir, `${type}-verdict.json`);
  if (!fs.existsSync(file)) return { error: "no verdict file — that side compared no documents of this type" };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `the verdict file is not readable JSON: ${e.message}` };
  }
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return { error: "the verdict file carries zero rows — a broken reconcile, not a clean corpus" };
  }
  return { v: tallyVerdict(payload), payload };
}

const sign = (n) => (n > 0 ? `+${n}` : String(n));
const pad = (s, w) => String(s).padEnd(w);
const rp = (s, w) => String(s).padStart(w);

plain("");
plain("══════════ THE SIX DOCUMENT TYPES, BEFORE AND AFTER, FROM ONE RUN ══════════");
plain("`differ` is work somebody owes. `cannot compare` is not work and is never folded into it.");
plain("`compared` is how many documents were actually put side by side — a `differ` that fell");
plain("while `compared` fell with it is a comparison that stopped happening, not a fix.");
plain("");
plain(
  `${pad("document type", 20)} ${rp("compared", 9)} ${rp("differ", 9)} ${rp("cannot cmp", 11)}   ` +
    `${rp("compared", 9)} ${rp("differ", 9)} ${rp("cannot cmp", 11)}   ${rp("d differ", 9)} ${rp("d cannot", 9)}`,
);
plain(`${pad("", 20)} ${rp("---- BEFORE ----", 31)}   ${rp("---- AFTER -----", 31)}`);

const problems = [];
const rows = [];
for (const type of TYPES) {
  const b = read(BEFORE_DIR, type);
  const a = read(AFTER_DIR, type);
  if (b.error) problems.push(`${type} BEFORE: ${b.error}`);
  if (a.error) problems.push(`${type} AFTER: ${a.error}`);
  if (b.error || a.error) continue;
  const row = {
    type,
    label: docTypeSpec(type).headline,
    before: { compared: b.v.documents.compared, differ: b.v.buckets.work, cannot: b.v.buckets.unanswerable },
    after: { compared: a.v.documents.compared, differ: a.v.buckets.work, cannot: a.v.buckets.unanswerable },
  };
  rows.push(row);
  plain(
    `${pad(row.label, 20)} ${rp(row.before.compared, 9)} ${rp(row.before.differ, 9)} ${rp(row.before.cannot, 11)}   ` +
      `${rp(row.after.compared, 9)} ${rp(row.after.differ, 9)} ${rp(row.after.cannot, 11)}   ` +
      `${rp(sign(row.after.differ - row.before.differ), 9)} ${rp(sign(row.after.cannot - row.before.cannot), 9)}`,
  );
}

plain("");
for (const r of rows) {
  const dd = r.after.differ - r.before.differ;
  const dc = r.after.cannot - r.before.cannot;
  const dcomp = r.after.compared - r.before.compared;
  if (dcomp !== 0) {
    plain(`${r.label}: the number of documents COMPARED moved by ${sign(dcomp)}. Say why before quoting any other number on this row.`);
  }
  if (dd < 0 && dcomp < 0) {
    plain(`${r.label}: differ fell by ${-dd} WHILE ${-dcomp} fewer documents were compared. That is not a fix — prove the difference.`);
  }
  if (dd > 0) plain(`${r.label}: differ ROSE by ${dd}. That is a legitimate result if the reader now reads the book correctly, and it is stated rather than hidden.`);
  if (dd === 0 && dc === 0 && dcomp === 0) plain(`${r.label}: unchanged.`);
}

if (problems.length) {
  plain("");
  for (const p of problems) console.error(`PROBLEM — ${p}`);
  refuse("at least one side could not be read; a comparison over a missing measurement must never read as a result.");
}
plain("");
plain("Both columns come from ONE process run against ONE committed book snapshot, with nothing");
plain("changed between them except the reader files under test.");
