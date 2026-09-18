#!/usr/bin/env node
/* READ-ONLY. WHICH COLUMN made the dedication planner refuse?
 *
 * WHY THIS EXISTS. lib/po-so-dedication-plan.mjs settles a bucket of
 * same-code, same-seat rows only when every candidate on both sides is
 * INDISTINGUISHABLE — same quantity, same money, same variants, same Desc2,
 * same received quantity. That widening (docs/bugs/0674-two-identical-sofa-
 * compartments-were-refused-a-dedication-so.md) paired 12 lines across 5 sofa
 * builds. It did NOT pair HC-SO-012025, and the refusal it printed was:
 *
 *     "2 purchase line(s) and 2 sales line(s) could pair here, so no pairing
 *      is forced — REFUSED, not guessed"
 *
 * That message is correct and it is useless: it says the bucket was not
 * forced, never WHY the rows are distinguishable. By construction the rows
 * differ on one of the columns the fingerprint compares — but which one is
 * the whole question, because the answer decides what happens next:
 *
 *   a REAL difference (two sofas genuinely ordered in different colours, one
 *   piece already received) means the refusal is right and the build is left
 *   alone; a DATA DEFECT (a colour the importer wrote on one row and not its
 *   twin) is a repair.
 *
 * Guessing between those two is exactly what the planner refuses to do, so
 * this prints the evidence instead.
 *
 * WHAT IT PRINTS, per (sales order, purchase order) pair:
 *   A  the planner's own verdict — moves, keeps and refusals, from
 *      planDedication run over the same rows the writer would read.
 *   B  every bucket the planner could not settle, and for it a COLUMN-BY-
 *      COLUMN table of both sides. A column whose value is the same on every
 *      row of a side is printed once; a column that DIFFERS is marked and its
 *      per-row values are printed. Those marked columns are the answer.
 *   C  the same for buckets that WERE settled, one line each, so a run can be
 *      read as a whole.
 *
 * IT LOOKS AT EXACTLY WHAT THE PLANNER LOOKS AT. The read, the seat
 * derivation and the fingerprint come from lib/po-so-dedication-read.mjs,
 * which repair-po-so-item-dedication.mjs also imports. A probe with its own
 * column list would name a column the planner never compared, or miss the one
 * it did — the point of this script is that it cannot.
 *
 * IT DECIDES NOTHING AND WRITES NOTHING. No UPDATE, no INSERT, no DDL, no
 * transaction. It exits 0 for every legitimate answer, including "nothing was
 * refused"; a non-zero exit means the database could not be read.
 *
 *   DATABASE_URL   required
 *   COMPANY        default 1
 *   PAIRS          "<so>=<po>,<so>=<po>"; defaults to the two builds the
 *                  2026-09-07 widening left refused
 *   DOC / PO       a single pair, the form the repair runbook already uses
 *
 * RE-RUN: idempotent and side-effect free — it reads two documents and prints.
 */
import postgres from "postgres";

import { K, planDedication, seatKey } from "./lib/po-so-dedication-plan.mjs";
import { fingerprintFields, readPair, resolvePo } from "./lib/po-so-dedication-read.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);

/* The two builds run 34139629930 (2026-09-07 23:47 local) left refused after
   the identical-rows widening. HC-SO-012025 is the bucket question this script
   was written for; HC-SO-012277 is here because its purchase lines carry no
   seat at all, and seeing that stated as a COLUMN rather than as a refusal
   message is the same evidence in the same shape. */
const DEFAULT_PAIRS = "HC-SO-012025=HC-PO-009024,HC-SO-012277=HC-PO-010040";

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

function parsePairs() {
  const single = [(process.env.DOC || "").trim(), (process.env.PO || "").trim()];
  if (single[0] && single[1]) return [{ soDoc: single[0], poDoc: single[1] }];
  const raw = (process.env.PAIRS || "").trim() || DEFAULT_PAIRS;
  return raw.split(",").map((c) => c.trim()).filter(Boolean).map((t) => {
    const [so, po] = t.split("=").map((x) => (x || "").trim());
    return { soDoc: so, poDoc: po };
  }).filter((p) => p.soDoc && p.poDoc);
}

/** The planner's bucket key, restated so this script groups the way it does. */
const bucketOf = (row) => `${K(row.item_code)}${seatKey(row.seat) ? ` @${seatKey(row.seat)}"` : " @(no seat)"}`;

/**
 * Column by column across a set of rows: which columns AGREE on every row, and
 * which DIFFER. This is the fingerprint taken apart — same fields, same
 * stringification, so a column named here is a column the planner compared.
 */
function columnDiff(rows) {
  const same = [];
  const differ = [];
  if (!rows.length) return { same, differ };
  const names = fingerprintFields(rows[0]).map(([k]) => k);
  const valuesOf = (r) => new Map(fingerprintFields(r));
  const maps = rows.map(valuesOf);
  for (const name of names) {
    const vals = maps.map((m) => (m.has(name) ? m.get(name) : "(column absent)"));
    if (vals.every((v) => v === vals[0])) same.push([name, vals[0]]);
    else differ.push([name, vals]);
  }
  return { same, differ };
}

const short = (v, n = 96) => {
  if (v === null) return "(null)";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}...` : s;
};

function printSide(label, rows) {
  note(`    ${label}: ${rows.length} row(s)`);
  const { same, differ } = columnDiff(rows);
  if (rows.length < 2) {
    for (const [k, v] of same) note(`      ${k.padEnd(16)} ${short(v)}`);
    return differ;
  }
  note(`      SAME on every row: ${same.map(([k]) => k).join(", ") || "(nothing)"}`);
  if (!differ.length) {
    note("      DIFFERS: nothing — these rows are indistinguishable");
    return differ;
  }
  for (const [k, vals] of differ) {
    note(`      DIFFERS  ${k}`);
    vals.forEach((v, i) => note(`        row ${i + 1}: ${short(v)}`));
  }
  return differ;
}

async function runPair(sql, soDoc, poDoc) {
  note(`\n===== ${soDoc} <-> ${poDoc} =====`);
  const { po, why } = await resolvePo(sql, CO, poDoc);
  if (!po) { note(`  ${why} — nothing to read`); return; }
  if (po.po_number !== poDoc) note(`  ${poDoc}: found as ${po.po_number} via its AutoCount link`);

  const { soRows, poRows } = await readPair(sql, CO, po.id, soDoc);
  if (!soRows.length) { note(`  ${soDoc}: no lines on company ${CO} — is that the right sales order?`); return; }

  const plan = planDedication({ poRows, soRows });
  note(`\n  A. the planner's verdict: ${plan.moves.length} move(s), ${plan.keeps.length} keep(s), ${plan.refusals.length} refusal(s), belongs=${plan.belongs}`);
  for (const r of plan.refusals) note(`     REFUSED  ${r}`);
  for (const m of plan.moves) note(`     move     ${m.poCode}${m.seat ? ` @${m.seat}"` : ""} -> ${m.to}`);

  /* Which buckets the planner could not settle: the needy purchase lines
     (no dedication, or one that disagrees with their own code+seat) grouped
     the way planDedication groups them, against the unclaimed sales lines. */
  const soById = new Map(soRows.map((r) => [r.id, r]));
  const kept = new Set(plan.keeps.map((k) => k.to));
  const moved = new Set(plan.moves.map((m) => m.poItemId));
  const needy = poRows.filter((p) => {
    const t = p.so_item_id ? soById.get(p.so_item_id) : null;
    if (t && bucketOf(t) === bucketOf(p) && !t.cancelled) return false;
    return true;
  });
  const unsettled = needy.filter((p) => !moved.has(p.id));

  const byBucket = new Map();
  for (const p of unsettled) {
    const b = bucketOf(p);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(p);
  }

  note(`\n  B. buckets the planner could NOT settle: ${byBucket.size}`);
  if (!byBucket.size) note("     none — every purchase line is dedicated or planned");
  for (const [b, group] of byBucket) {
    const cands = soRows.filter((s) => !s.cancelled && !kept.has(s.id) && bucketOf(s) === b);
    note(`\n  --- bucket ${b}:  ${group.length} purchase line(s) vs ${cands.length} unclaimed sales line(s)`);
    const poDiff = printSide("PURCHASE", group);
    const soDiff = printSide("SALES", cands);
    if (group.length === cands.length && group.length > 1) {
      const names = [...new Set([...poDiff.map(([k]) => k), ...soDiff.map(([k]) => k)])];
      note(names.length
        ? `    ==> the widening did not fire because these column(s) differ: ${names.join(", ")}`
        : "    ==> both sides are indistinguishable; if this bucket is still refused the cause is NOT the fingerprint");
    } else if (cands.length === 0) {
      note("    ==> no unclaimed sales line carries that code at that seat — this is a PIECE/SEAT mismatch, not a fingerprint question");
    } else {
      note(`    ==> the bucket is uneven (${group.length} vs ${cands.length}), so no bijection exists — not a fingerprint question`);
    }
  }

  const settled = new Map();
  for (const m of plan.moves) {
    const p = poRows.find((r) => r.id === m.poItemId);
    if (!p) continue;
    const b = bucketOf(p);
    settled.set(b, (settled.get(b) ?? 0) + 1);
  }
  note(`\n  C. buckets the planner settled: ${settled.size}`);
  for (const [b, n] of settled) note(`     ${b}: ${n} move(s)`);
}

async function main() {
  const pairs = parsePairs();
  note(`READ-ONLY. company=${CO}  pairs=${pairs.map((p) => `${p.soDoc}=${p.poDoc}`).join(", ")}`);
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    for (const p of pairs) await runPair(sql, p.soDoc, p.poDoc);
    note("\ndone — nothing was written");
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
