import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* WHY THIS TEST READS SOURCE. What is being pinned is that a guard is APPLIED
   AT THE WRITE SITE, and a call site is exactly what a unit test cannot see —
   the same reason sofaCorrectionsCarryToInvoices.test.mjs is written this way.
   The DECISION (which pieces a document is missing, and when to refuse rather
   than delete) is behavioural and lives in
   scripts/lib/sofa-downstream-parity.test.mjs, which proves it against inputs.

   WHAT THE WRITE SITE IS. A corrections entry may now name the receipt, the
   delivery note and the invoices beside the order, and the applier brings each
   of them to the build's own shape by INSERTING the pieces they have no row
   for. Inserting into scm.grn_items / scm.delivery_order_items /
   scm.sales_invoice_items / scm.purchase_invoice_items is the first time this
   script has added a row to a document that says goods moved, so the guards
   below are the whole licence for it and none of them may quietly disappear. */

const SRC = readFileSync(join(__dirname, '..', 'scripts', 'apply-sofa-compartment-corrections.mjs'), 'utf8');
/** Just the downstream writer, so a guard elsewhere in the file cannot satisfy these. */
const FN = SRC.slice(SRC.indexOf('async function applyDownstreamDoc'), SRC.indexOf('/** The next free `line_no`'));

describe('a compartment row added to a receipt, delivery note or invoice is guarded at the write site', () => {
  it('the downstream writer exists and is reached from the per-document loop', () => {
    expect(SRC).toMatch(/async function applyDownstreamDoc/);
    expect(SRC).toMatch(/if \(DOWNSTREAM\[kind\]\) \{[\s\S]{0,200}applyDownstreamDoc\(/);
    expect(FN.length).toBeGreaterThan(500);
  });

  it('REFUSES a document that is not migrated paperwork', () => {
    expect(FN).toMatch(/head\.migrated !== true/);
    expect(FN).toMatch(/NOT migrated paperwork/);
  });

  it('REFUSES a document any inventory movement names — 「库存先不看」 measured, not assumed', () => {
    expect(FN).toMatch(/FROM scm\.inventory_movements WHERE company_id = \$\{CO\} AND source_doc_no = \$\{doc\}/);
    expect(FN).toMatch(/inventory movement\(s\) name/);
  });

  it('re-reads pg_trigger on EVERY run and refuses a trigger it has not been shown', () => {
    expect(FN).toMatch(/unknownDownstreamTriggers\(\)/);
    expect(SRC).toMatch(/FROM pg_trigger/);
    expect(SRC).toMatch(/NOT t\.tgisinternal/);
    /* The allowlist is the fact that was read from production, so it has to be
       in the file rather than in somebody's memory of the run. */
    expect(SRC).toMatch(/KNOWN_TRIGGERS/);
    expect(SRC).toMatch(/trg_do_line_integrity_lock/);
  });

  it('zeroes EVERY money column of the table on an added piece, rather than two named ones', () => {
    expect(FN).toMatch(/for \(const m of money\) over\[m\] = 0;/);
    expect(SRC).toMatch(/async function moneyColumns/);
    expect(SRC).toMatch(/column_name LIKE '%\\\\_sen'/);
  });

  it('asserts the money did not move, on the columns the table actually has, and EXITS if it did', () => {
    expect(FN).toMatch(/const moved = money\.filter\(/);
    expect(FN).toMatch(/MONEY MOVED/);
    expect(FN).toMatch(/process\.exit\(1\)/);
  });

  it('clones the row rather than enumerating columns, so a column nobody here knows about survives', () => {
    expect(SRC).toMatch(/async function cloneRow/);
    expect(SRC).toMatch(/FROM information_schema\.columns/);
    /* The jsonb cast is load-bearing: without ::text::jsonb the row lands as a
       jsonb STRING that reads as empty everywhere (docs/jsonb-double-encoding-coe.md). */
    expect(SRC).toMatch(/::text::jsonb/);
  });

  it('resolves the parent link or leaves it NULL — never guesses which line a piece was received against', () => {
    expect(FN).toMatch(/hits\.length === 1/);
    expect(FN).toMatch(/left unset rather than guessed/);
  });

  it('never deletes downstream: the plan module refuses instead, and the writer has no DELETE', () => {
    expect(FN).not.toMatch(/DELETE FROM/);
    const PLAN = readFileSync(join(__dirname, '..', 'scripts', 'lib', 'sofa-downstream-parity.mjs'), 'utf8');
    expect(PLAN).not.toMatch(/DELETE FROM/);
    expect(PLAN).toMatch(/nothing here removes a/);
  });

  it('every downstream document it touched is re-read on a FRESH connection and asserted', () => {
    const V = SRC.slice(SRC.indexOf('async function verifyOnFreshConnection'));
    expect(V).toMatch(/DOWNSTREAM\[it\.kind\]\.rows\(it\.headId, v\)/);
    expect(V).toMatch(/it\.moneyCols/);
  });

  /* ── THE TRANSACTION HOLDS THE ONLY CONNECTION ────────────────────────────
     `newSql()` builds the pool with `max: 1`. Anything inside `sql.begin` that
     reaches for the module-level `sql` waits for a connection the block itself
     is holding, and the process HANGS — no error, no rollback, a stopped job
     that looks exactly like a slow query. It cost prod apply run 34320397321,
     which had to be cancelled. docs/bugs/0749. */
  it('the downstream transaction touches only `tx` — a bare `sql` inside it deadlocks the pool', () => {
    const open = FN.indexOf('await sql.begin(async (tx) => {');
    expect(open).toBeGreaterThan(-1);
    /* Brace-match from the arrow body so the slice is the block itself. */
    let i = FN.indexOf('{', open + 'await sql.begin(async (tx) => '.length);
    let depth = 0, end = -1;
    for (let n = i; n < FN.length; n++) {
      if (FN[n] === '{') depth++;
      else if (FN[n] === '}') { depth--; if (depth === 0) { end = n; break; } }
    }
    expect(end).toBeGreaterThan(i);
    const body = FN.slice(i, end);
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/[^.\w]sql[`.(]/);
    /* And the reads it needs really are hoisted above it. */
    const before = FN.slice(0, open);
    expect(before).toMatch(/const label = await labelColumnName\(/);
    expect(before).toMatch(/spec\.parentOf\(/);
  });

  it('the run says how many downstream rows it added, so a run that added none is visible', () => {
    expect(SRC).toMatch(/nDsAdd/);
    expect(SRC).toMatch(/row\(s\) added/);
  });
});
