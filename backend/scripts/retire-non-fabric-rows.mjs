#!/usr/bin/env node
/* Products sitting in the fabric master. Deactivate them, record why, delete nothing.

   WHAT THE OWNER SAW. A prod probe on 2026-08-13 found two rows in
   scm.fabric_trackings that are not fabrics — "SOFA 5535" described as
   "5535 (3+L)", and "SQUARE PILLOW" described as 'SQUARE PILLOW (16" X 16")'.
   Owner: 「为什么sofa 和square pillow在fabric convert里面？」.

   THE WRITE PATH IS ALREADY FIXED; THIS IS THE OTHER HALF. PR #2104 taught
   POST /fabric-tracking and POST /fabric-tracking/bulk-upsert to refuse a code
   whose head is a product word, so nothing can add a third one. It deliberately
   did not touch the rows already in the table. This does, and only this — it
   adds no rule, it applies the rule that shipped.

   ── NOTHING IS DELETED ────────────────────────────────────────────────────
   Not "nothing is deleted by default": there is no DELETE in this file at all.
   A retired row is set is_active = false and has a stamp APPENDED to its
   description saying which word condemned it and on what day:

     5535 (3+L) [RETIRED 2026-08-13 - non-fabric code head SOFA: a product,
     not a fabric. Deactivated, not deleted.]

   The original description is kept verbatim in front of the stamp, so the
   reversal is mechanical and the script prints the exact SQL for it. is_active
   is what the app already keys on (migration 0167): an inactive fabric drops
   out of every NEW-entry picker, existing documents keep displaying the code,
   and the Fabric Converter table still lists the row — now marked Inactive,
   with the stamp saying why. That last part matters and is not a bug: the
   owner asked why these are in the converter, and after this run they still
   are, greyed out and explained. Removing them from that table is a UI
   decision nobody has made, and is NOT this script's to make.

   ── IT REFUSES ANYTHING STILL REFERENCED ──────────────────────────────────
   A product code that reached a real order is a different problem from a stray
   catalogue row, and must not be quietly deactivated underneath a live
   document. So before each row is touched, the FULL census runs against it —
   the same carrier list and the same per-kind SQL that census-fabric-colour.mjs
   uses, imported from lib/colour-carriers.mjs, not re-typed here. Any live
   carrier that names the code REFUSES the row; it is reported with its counts
   and left exactly as it was.

   THE ONE EXCLUSION is scm.fabric_trackings.fabric_code itself — the row being
   retired. Counting it would make every row refuse itself. It is
   `isSelfCarrier` in lib/colour-carriers.mjs, defined next to the list so the
   exclusion cannot drift from it, and its count is printed rather than hidden
   (anything other than 1 means duplicate master rows, which is worth seeing).

   Everything else live blocks, including scm.fabric_colours.colour_id — the
   POS selling mirror. That is the likeliest blocker and it is deliberate: if
   the mirror exists, the code is still offerable on POS, and retiring only the
   cost row would leave the same half-done job this directory keeps paying for.
   Retiring the mirror is the colour tooling's job, not this script's. History
   carriers (revisions, audit logs, scan samples) never block and are never
   written — rewriting them would forge the record.

   A carrier that ERRORS is fatal here, unlike in the census. The census is a
   report and can print an error and move on; a writer that could not read a
   carrier has not proved the code is unreferenced, so it must not write.

   ── HOW TO RUN IT ─────────────────────────────────────────────────────────
     MODE=plan  (default)  writes nothing, and opens the session read-only so
                           it cannot even by accident.
     MODE=apply            needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", runs one
                           transaction per row, re-runs that row's census INSIDE
                           the transaction (the plan may be minutes stale), reads
                           the stored row back from RETURNING rather than
                           trusting a command tag, and then verifies everything
                           again on a SECOND, FRESH connection.

     DATABASE_URL=... node scripts/retire-non-fabric-rows.mjs
     COMPANY=1  CODES="SOFA 5535|SQUARE PILLOW"   to narrow it

   Scope is the CLASS, not the two rows: every row whose code head is a product
   word is a candidate, so a third one that predates the guard is caught by the
   same run. CODES narrows that; it can never widen it.

   RE-RUN: inert. A row already carrying the stamp is reported as done and
   skipped, so a second apply writes nothing. A row that is already inactive but
   UNSTAMPED still gets its stamp — that is the "record why and when" half, and
   without it a row someone deactivated by hand stays unexplained. */
import postgres from 'postgres';
import { resolveCarriers, countCarrier, isSelfCarrier } from './lib/colour-carriers.mjs';
import { nonFabricCodeWord, RETIRE_STAMP_RE, stampDescription } from './lib/non-fabric-code.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
/* Blank = every row whose code head is a product word. A '|' separated list
   narrows it — '|' and not ',' because a fabric code may legally contain a
   comma, and CODES="SOFA 5535" must not split into two codes. */
const ONLY = (process.env.CODES || '').split('|').map((s) => s.trim()).filter(Boolean);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
/* UTC, and read ONCE, so every row in a run carries the same date even if the
   run crosses midnight. STAMP_DATE overrides it only to make a rerun of a
   failed apply reproduce the first run's wording. */
const TODAY = process.env.STAMP_DATE || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) {
  bad(`STAMP_DATE must be YYYY-MM-DD (got ${JSON.stringify(TODAY)})`);
  process.exit(2);
}

/** Every carrier that names `code`, counted. Throws on the first carrier that
 *  cannot be read: a writer that could not ask a question has not got an
 *  answer, and must not proceed as though it had. */
async function censusOf(db, carriers, code) {
  const hits = [];
  for (const c of carriers) {
    let n = 0;
    try { [{ n }] = await countCarrier(db, c, code, CO); }
    catch (e) { throw new Error(`census could not read ${c.table}.${c.col}: ${e.message}`); }
    if (n > 0) hits.push({ ...c, n });
  }
  return hits;
}

/** The census split into the three things a caller actually decides on. */
const classify = (hits) => ({
  self: hits.filter((h) => h.live && isSelfCarrier(h)),
  blocking: hits.filter((h) => h.live && !isSelfCarrier(h)),
  history: hits.filter((h) => !h.live),
});

const total = (arr) => arr.reduce((a, h) => a + h.n, 0);

/** A Postgres STRING literal — single-quoted, with embedded quotes doubled.
 *  JSON.stringify is not this: it emits double quotes, which Postgres reads as
 *  an IDENTIFIER, so a pasted reversal would fail with `column "5535 (3+L)"
 *  does not exist` — or worse, succeed against something unintended. The two
 *  rows this script was written for both contain quote characters
 *  ('SQUARE PILLOW (16" X 16")'), so this is exercised on the first run. */
const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const carrierLine = (h) => `${String(h.n).padStart(7)}  ${String(h.table).padEnd(42)} ${h.col}   [${h.kind}]`;

async function main() {
  note(`=== retire non-fabric rows — MODE=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} ===`);
  /* Plan mode makes the whole session read-only, so a mistake in this file
     cannot write. apply must not set it, or every UPDATE below fails. */
  if (!APPLY) await sql.unsafe('SET default_transaction_read_only = on');
  note(ONLY.length ? `limited to: ${ONLY.join(' | ')}` : 'scope: every row whose code head is a product word');

  const { usable, skipped } = await resolveCarriers(sql);
  const live = usable.filter((c) => c.live);
  note(`\n=== CARRIERS ===`);
  note(`  usable:  ${usable.length}   (live ${live.length}, history ${usable.length - live.length})`);
  note(`  skipped: ${skipped.length}`);
  for (const s of skipped) note(`     SKIP ${String(s.table).padEnd(42)} ${s.col.padEnd(22)} — ${s.why}`);
  const noCo = usable.filter((c) => !c.hasCompany);
  if (noCo.length) {
    note(`  NOT company-scoped (counted across ALL companies — said out loud, not pretended away):`);
    for (const c of noCo) note(`     ${String(c.table).padEnd(42)} ${c.col}`);
  }
  if (!usable.some(isSelfCarrier)) {
    throw new Error('scm.fabric_trackings.fabric_code is not a usable carrier — refusing to run blind');
  }

  const rows = await sql`SELECT id, fabric_code, fabric_description, is_active
                           FROM scm.fabric_trackings
                          WHERE company_id = ${CO}
                          ORDER BY fabric_code`;
  const before = rows.length;
  note(`\nfabric_trackings rows (company ${CO}): ${before}`);

  /* Case-insensitive, because the codes are quoted back at whoever runs this
     from a report and 'SOFA 5535' vs 'Sofa 5535' should not silently mean "do
     nothing". */
  const wanted = new Set(ONLY.map((c) => c.toUpperCase()));
  const matched = new Set();
  const candidates = [];
  for (const r of rows) {
    const word = nonFabricCodeWord(r.fabric_code);
    if (!word) continue;
    const code = String(r.fabric_code).trim();
    if (wanted.size) {
      if (!wanted.has(code.toUpperCase())) continue;
      matched.add(code.toUpperCase());
    }
    candidates.push({ ...r, word });
  }
  note(`rows whose code head is a product word: ${candidates.length}`);
  /* A typo in CODES otherwise looks exactly like "there was nothing to do". */
  const unmatched = [...wanted].filter((c) => !matched.has(c));
  if (unmatched.length) {
    bad(`CODES named ${unmatched.length} code(s) that are not a product-headed row in this company: ${unmatched.join(', ')}`);
    bad(`  (either the code does not exist, belongs to company != ${CO}, or does not open with a product word)`);
  }
  if (!candidates.length) {
    note('\nNothing to consider. The master holds no product-headed code for this company.');
    await sql.end({ timeout: 5 });
    return;
  }

  const work = [], refused = [], already = [];
  for (const r of candidates) {
    note(`\n--- "${r.fabric_code}"   ${JSON.stringify(r.fabric_description)}   is_active=${r.is_active}`);
    note(`      condemned by head word: ${r.word}`);
    const { self, blocking, history } = classify(await censusOf(sql, usable, r.fabric_code));
    const selfN = total(self);
    note(`      the master row itself:  ${selfN}${selfN === 1 ? '' : '  <-- not 1: duplicate master rows, look at this'}`);
    if (history.length) {
      note(`      HISTORY (never blocks, never rewritten):`);
      for (const h of history.sort((a, b) => b.n - a.n)) note(`  ${carrierLine(h)}`);
    }
    if (blocking.length) {
      note(`      REFUSED — ${total(blocking)} live row(s) elsewhere name this code:`);
      for (const h of blocking.sort((a, b) => b.n - a.n)) note(`  ${carrierLine(h)}`);
      refused.push({ ...r, blocking });
      continue;
    }
    note(`      clean — no live carrier outside the master names it`);
    if (RETIRE_STAMP_RE.test(String(r.fabric_description ?? '')) && r.is_active === false) {
      note(`      already retired and stamped — nothing to do`);
      already.push(r);
      continue;
    }
    work.push({ ...r, next: RETIRE_STAMP_RE.test(String(r.fabric_description ?? ''))
      ? String(r.fabric_description)
      : stampDescription(r.fabric_description, r.word, TODAY) });
  }

  note(`\n=== PLAN ===`);
  note(`  to retire:      ${work.length}`);
  note(`  refused:        ${refused.length}   (something live still names them)`);
  note(`  already done:   ${already.length}`);
  for (const w of work) {
    note(`\n  RETIRE  ${w.fabric_code}   id=${w.id}`);
    note(`     is_active           ${w.is_active}  ->  false`);
    note(`     fabric_description  ${JSON.stringify(w.fabric_description)}`);
    note(`                      -> ${JSON.stringify(w.next)}`);
    note(`     reverse with: UPDATE scm.fabric_trackings SET is_active = ${w.is_active === false ? 'false' : 'true'},`);
    note(`                     fabric_description = ${lit(w.fabric_description)}`);
    note(`                     WHERE id = ${lit(w.id)} AND company_id = ${CO};`);
  }
  for (const r of refused) note(`  LEFT ALONE  ${r.fabric_code} — ${total(r.blocking)} live reference(s)`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing was written, and the session was read-only throughout.`);
    note(`${work.length} row(s) would be DEACTIVATED and stamped. Nothing would be deleted — this script has no DELETE.`);
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
    await sql.end({ timeout: 5 });
    return;
  }

  if (!work.length) {
    note(`\nNothing to write.`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== APPLYING ${work.length} ROW(S) ===`);
  const done = [], failed = [];
  for (const w of work) {
    try {
      /* The row is recorded as done only after begin() RESOLVES — i.e. after
         the COMMIT. Pushing inside the callback would count a transaction that
         still had a commit left to fail. */
      const stored = await sql.begin(async (tx) => {
        /* The plan above may be minutes old. Re-ask, inside the transaction, so
           a document written in between cannot be retired out from under. */
        const { blocking } = classify(await censusOf(tx, usable, w.fabric_code));
        if (blocking.length) {
          throw new Error(`${total(blocking)} live reference(s) appeared since the plan — refusing`);
        }
        const [updated] = await tx`UPDATE scm.fabric_trackings
                                      SET is_active = false, fabric_description = ${w.next}
                                    WHERE id = ${w.id} AND company_id = ${CO}
                                RETURNING id, fabric_code, fabric_description, is_active`;
        /* RETURNING, never a row count: a command tag of 1 says a row matched,
           not that it now holds the value intended. */
        if (!updated) throw new Error('no row matched that id for this company — nothing written');
        if (updated.is_active !== false) throw new Error(`is_active is ${updated.is_active}, not false`);
        if (!RETIRE_STAMP_RE.test(String(updated.fabric_description))) {
          throw new Error(`stored description carries no stamp: ${JSON.stringify(updated.fabric_description)}`);
        }
        return updated;
      });
      done.push({ ...w, stored });
      note(`  OK  ${w.fabric_code}  is_active=false  ${JSON.stringify(stored.fabric_description)}`);
    } catch (e) {
      failed.push({ ...w, why: e.message });
      bad(`FAILED ${w.fabric_code}: ${e.message} (rolled back; the others stand)`);
    }
  }

  await sql.end({ timeout: 5 });

  /* ── VERIFY ON A FRESH CONNECTION ────────────────────────────────────────
     The connection that just wrote is the last one that should be believed. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let unproven = false;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    note(`  retired: ${done.length}   failed: ${failed.length}   refused: ${refused.length}   already done: ${already.length}`);

    const [{ n: after }] = await check`SELECT count(*)::int AS n
                                         FROM scm.fabric_trackings WHERE company_id = ${CO}`;
    /* Only a SHRINK is this script's business. Someone else adding a fabric
       mid-run is not a fault, and failing on it would cry wolf; a row that has
       gone missing is the one thing this file must never be able to cause. */
    let vanished = 0;
    if (after < before) { bad(`  row count ${before} -> ${after}: ${before - after} ROW(S) DISAPPEARED — this script has no DELETE`); vanished = before - after; }
    else if (after === before) note(`  row count ${before} -> ${after}: nothing was deleted`);
    else note(`  row count ${before} -> ${after}: nothing was deleted (${after - before} row(s) added by someone else mid-run)`);

    let dirty = 0;
    for (const d of done) {
      const [row] = await check`SELECT id, fabric_code, fabric_description, is_active
                                  FROM scm.fabric_trackings
                                 WHERE id = ${d.id} AND company_id = ${CO}`;
      if (!row) { bad(`  ${d.fabric_code}: THE ROW IS GONE — it should only have been deactivated`); dirty++; continue; }
      if (row.is_active !== false) { bad(`  ${d.fabric_code}: is_active is ${row.is_active}, not false`); dirty++; continue; }
      if (!RETIRE_STAMP_RE.test(String(row.fabric_description))) {
        bad(`  ${d.fabric_code}: description carries no stamp: ${JSON.stringify(row.fabric_description)}`); dirty++; continue;
      }
      const original = String(d.fabric_description ?? '').trim();
      if (original && !String(row.fabric_description).startsWith(original)) {
        bad(`  ${d.fabric_code}: the original description was not preserved in front of the stamp`); dirty++; continue;
      }
      note(`  ${String(row.fabric_code).padEnd(20)} inactive, stamped, present: ${JSON.stringify(row.fabric_description)}`);
    }
    if (dirty) bad(`  ${dirty} row(s) are not in the state this script claims — DO NOT trust the run above`);
    else if (done.length) note(`  every retired row is still present, inactive, and carries its reason`);

    /* The rows must still be unreferenced afterwards too — a retire that raced
       a document would show up here rather than in a support ticket. */
    const { usable: freshCarriers } = await resolveCarriers(check);
    let named = 0;
    for (const d of done) {
      const { blocking } = classify(await censusOf(check, freshCarriers, d.fabric_code));
      for (const h of blocking) { bad(`  ${d.fabric_code} is now named by ${carrierLine(h)}`); named += h.n; }
    }
    if (!named && done.length) note(`  no retired code is named by any live carrier outside the master`);

    if (failed.length) {
      note(`\n  FAILED, unchanged, safe to re-run:`);
      for (const f of failed) note(`    ${f.fabric_code} — ${f.why}`);
    }
    if (refused.length) {
      note(`\n  LEFT ALONE because something live names them — these are a different problem:`);
      for (const r of refused) {
        note(`    ${r.fabric_code}`);
        for (const h of r.blocking.sort((a, b) => b.n - a.n)) note(`  ${carrierLine(h)}`);
      }
    }
    unproven = dirty > 0 || named > 0 || vanished > 0 || failed.length > 0;
  } finally {
    await check.end({ timeout: 5 });
  }
  /* Exit non-zero AFTER the connection is closed, so CI fails on a run whose
     own read-back did not agree with it. */
  if (unproven) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
