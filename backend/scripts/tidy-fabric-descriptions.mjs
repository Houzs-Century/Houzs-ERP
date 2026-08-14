#!/usr/bin/env node
// Fabric DESCRIPTIONS only — bring them to the one shape the owner approved,
// and drop the asterisk he ruled meaningless.
//
// WHAT THIS DOES NOT TOUCH: the CODE. Not one character of fabric_code /
// colour_id changes here, so no document is re-pointed, no price tier moves,
// and nothing that joins on the code can break. The 2026-08-11 work already
// normalised the codes on both sides (owner-fabric-catalogue.md 2C); what it
// never did was normalise the text beside them, which is why the Converter
// still reads:
//
//     BO315-04   BO315-04 SAND          <- the approved shape
//     BO315-11   METAL                  <- colour only, no code
//     BO315-24   FABRIC                 <- not even a colour
//     FG66151-02 PICCO FG66151-02 (FABRIC)   <- brand + parens
//     BO315-26   BO315-26 YELLOW*       <- the asterisk
//
// THE SHAPE (backend/scripts/lib/fabric-code.mjs, owner-approved 2026-08-11):
//
//     label = <CODE> <COLOUR NAME>        e.g. "BO315-11 METAL"
//     label = <CODE>                      when no name is known
//
// THE ASTERISK. The owner's own 2026-08-11 catalogue listed BO315 -21..-32 as
// "the same twelve colours with an asterisk", and the seeder copied `PEARL*`
// through verbatim. Asked what it means, the owner ruled 2026-08-12: it means
// nothing, remove it. So a trailing `*` is stripped from the NAME. Note the
// consequence and check the report: once stripped, BO315-26 reads "YELLOW",
// the same text as BO315-06. That is fine - the CODE is the identity and the
// two are different fabrics - but the report lists every such pair so the
// owner sees them rather than discovering them later.
//
// THE NAME IS COPIED, NEVER INVENTED. A colour name comes from the row's own
// existing text or from the code itself, in that order. If neither yields one,
// the row is REPORTED AND LEFT ALONE - never given a manufactured name, never
// blanked. That is the owner's standing rule (a migration copies the source's
// own value and skips what is ambiguous). It is also why UNMATCHED-* rows and
// supersede tombstones are excluded outright: a tombstone's text is a RECORD of
// what absorbed it and must survive verbatim.
//
// plan (default) writes nothing. apply needs CONFIRM=I HAVE REVIEWED THE DRY-RUN.
//
// RE-RUN: inert. A description already in the approved shape produces no change; the CODE is never touched.

import postgres from "postgres";
import { parse, canonId } from "./lib/fabric-code.mjs";
import { normColour } from "./lib/fabric-colour-match.mjs";
import { isCatalogueSeries } from "./lib/catalogue-series.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const CO = Number(process.env.COMPANY_ID || 1);
const SERIES_FILTER = (process.env.SERIES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

if (MODE === "apply" && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("MODE=apply requires CONFIRM='I HAVE REVIEWED THE DRY-RUN'");
  process.exit(2);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (s = "") => console.log(s);

// A tombstone records which code absorbed this row and when. It is evidence,
// not a description, and rewriting it would destroy the audit trail the
// supersede rule exists to keep.
const isTombstone = (s) => /\[\s*merged into /i.test(s || "");
const isJunk = (s) => /^UNMATCHED/i.test(normColour(s || ""));

/* The colour NAME for a row, copied from what already exists. Order matters:
   the row's own text first (it is the most specific record), then the code.
   Returns null when nothing yields a name - the caller then leaves the row
   alone rather than inventing one. */
function nameFor(code, description) {
  const desc = (description || "").trim();
  const codeNorm = normColour(code);

  // "BO315-04 SAND" / "BO315-04-SAND" -> SAND. Anchored on the code so a
  // description that merely mentions the code elsewhere is not mined.
  const n = normColour(desc);
  if (n.startsWith(codeNorm)) {
    const tail = desc.slice(desc.length - (n.length - codeNorm.length)).replace(/^[\s\-#]+/, "").trim();
    if (tail) return tail;
    // The description IS the code and nothing else - the code may still carry
    // a name of its own (rare, but "SF-AT 01 IVORY" style codes exist).
    const p = parse(code);
    return p?.name || null;
  }

  // A bare colour name: "METAL", "DEEP GREY". Refused when it carries digits,
  // because a digit in a loose description is usually a code fragment and
  // mining it would mint a colour called "02".
  if (desc && !/\d/.test(desc) && !/[()]/.test(desc)) return desc;

  // The code's own trailing name, when it has one.
  const p = parse(code);
  if (p?.name) return p.name;

  return null;
}

// The owner's 2026-08-12 ruling. Only a TRAILING marker is removed - an
// asterisk inside a name would be part of the name, and nothing here may
// decide that it is not.
const stripStar = (s) => (s || "").replace(/\s*\*+\s*$/, "").trim();

async function tidy(table, codeCol, descCol, label) {
  out(`\n${"=".repeat(72)}`);
  out(`=== ${label}  (scm.${table}.${descCol}) ===`);

  const hasCompany = (await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='scm' AND table_name=${table} AND column_name='company_id'`).length > 0;
  const hasActive = (await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='scm' AND table_name=${table} AND column_name IN ('is_active','active')`).length > 0;

  const rows = await sql.unsafe(`
    SELECT "${codeCol}"::text AS code, coalesce("${descCol}",'')::text AS descr
      FROM scm."${table}"
     ${hasCompany ? `WHERE company_id = ${CO}` : ""}
     ORDER BY 1`);
  out(`${rows.length} row(s) read${hasActive ? "" : " (no active flag on this table)"}`);

  const change = [], skipTomb = [], skipJunk = [], skipNoName = [], skipCatalogue = [], already = [];
  for (const r of rows) {
    if (isTombstone(r.descr)) { skipTomb.push(r); continue; }
    if (isJunk(r.code))       { skipJunk.push(r); continue; }

    const p = parse(r.code);
    // A code the ONE parser cannot read is reported, never guessed at.
    if (!p) { skipNoName.push({ ...r, why: "code does not parse" }); continue; }
    /* The owner dictated twelve series by hand, spelling included. This script
       derives; it must not derive over a decision. Without this it reported 249
       of his own rows (78 here, 171 in the selling library) as
       `code is not canonical (would be DE-01) — fix the CODE first`, measured
       on the 2026-08-14 production plan. It changed nothing — every one of them
       failed the canonicality guard below and fell into the same bucket as real
       problems, which is how a real problem stops being read. */
    if (isCatalogueSeries(p.series)) { skipCatalogue.push(r); continue; }
    const canon = canonId(p);
    if (SERIES_FILTER.length && !SERIES_FILTER.includes(p.series)) continue;

    /* Only tidy a row whose CODE is already canonical. `HIRRING GD8371-02# BEIGE`
       parses to GD8371-02, so without this the description would be rewritten to
       "GD8371-02 BEIGE" while the code column still read "HIRRING GD8371-02#
       BEIGE" - a description naming a code the row does not have, which is a NEW
       inconsistency, not a tidied one. Those rows need their CODE fixed first,
       and that is the 2026-08-11 catalogue job, not this one. Report and leave. */
    if (normColour(r.code) !== normColour(canon)) {
      skipNoName.push({ ...r, why: `code is not canonical (would be ${canon}) - fix the CODE first` });
      continue;
    }

    const rawName = nameFor(r.code, r.descr);
    const name = stripStar(rawName);
    /* No name is a LEGITIMATE end state, not a defect: the owner's own catalogue
       gives ORION / TR / DE / HR805 codes and no colour names at all. So a row
       whose text is already just the canonical code is CORRECT, and only a row
       that still reads something else is worth a human's attention. Counting the
       former as a problem is how a report ends up crying wolf 440 times. */
    if (!name) {
      if (r.descr.trim() === canon) already.push(r);
      else skipNoName.push({ ...r, why: `no colour name available (text is ${JSON.stringify(r.descr)})` });
      continue;
    }

    const want = `${canon} ${name}`;
    if (r.descr.trim() === want) { already.push(r); continue; }
    change.push({ code: r.code, from: r.descr, to: want, starred: rawName !== name });
  }

  out(`\n-- already correct: ${already.length}`);
  out(`-- tombstones left verbatim: ${skipTomb.length}`);
  out(`-- UNMATCHED junk bucket left alone: ${skipJunk.length}`);
  out(`-- the owner\u0027s own 12 catalogue series, left exactly as he dictated: ${skipCatalogue.length}`);
  out(`-- reported, NOT changed (no name / unparseable code): ${skipNoName.length}`);
  for (const s of skipNoName.slice(0, 40)) out(`     ${s.code.padEnd(22)} ${JSON.stringify(s.descr).padEnd(40)} ${s.why}`);
  if (skipNoName.length > 40) out(`     ... and ${skipNoName.length - 40} more`);

  out(`\n-- WOULD REWRITE: ${change.length}`);
  for (const c of change.slice(0, 80)) out(`     ${c.code.padEnd(22)} ${JSON.stringify(c.from).padEnd(42)} -> ${JSON.stringify(c.to)}${c.starred ? "   [asterisk dropped]" : ""}`);
  if (change.length > 80) out(`     ... and ${change.length - 80} more`);

  // Collisions the asterisk was hiding. Reported, never resolved here.
  const byText = new Map();
  for (const c of change) {
    const k = c.to.replace(/^\S+\s*/, "").toUpperCase();
    if (!k) continue;
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(c.code);
  }
  const dup = [...byText.entries()].filter(([, v]) => v.length > 1);
  if (dup.length) {
    out(`\n-- same colour NAME on more than one code after tidying (${dup.length} name(s)).`);
    out(`   Expected, and NOT a defect: the CODE is the identity. Listed so it is seen, not discovered.`);
    for (const [n, codes] of dup.slice(0, 30)) out(`     ${n}: ${codes.join(", ")}`);
  }

  if (MODE !== "apply" || !change.length) return change.length;

  let done = 0;
  for (const c of change) {
    await sql.unsafe(
      `UPDATE scm."${table}" SET "${descCol}" = $1 WHERE "${codeCol}" = $2 ${hasCompany ? `AND company_id = ${CO}` : ""}`,
      [c.to, c.code],
    );
    done++;
  }
  out(`\nAPPLIED ${done} row(s).`);
  return change.length;
}

async function main() {
  if (MODE !== "apply") await sql.unsafe("SET default_transaction_read_only = on");
  out(`=== fabric description tidy — MODE=${MODE} company=${CO}${SERIES_FILTER.length ? ` series=${SERIES_FILTER.join(",")}` : ""} ===`);
  out(`CODES ARE NOT TOUCHED. Only ${MODE === "apply" ? "the description text is rewritten" : "the description text would be rewritten"}.`);

  let total = 0;
  // The Converter is the master (fabric-tracking.ts:74-82) and the library is
  // mirrored from it, so the Converter is tidied first and the library second -
  // the same order the 2026-08-11 alignment used.
  total += await tidy("fabric_trackings", "fabric_code", "fabric_description", "Fabric Converter");
  total += await tidy("fabric_colours",   "colour_id",   "label",              "Selling library (colours)");

  out(`\n${"=".repeat(72)}`);
  out(MODE === "apply" ? `DONE.` : `PLAN ONLY — nothing was written. ${total} row(s) would change.`);
  out(`Re-run with MODE=apply CONFIRM='I HAVE REVIEWED THE DRY-RUN' to write.`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
