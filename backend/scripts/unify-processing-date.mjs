#!/usr/bin/env node
/* Move the Processing Date into the ONE column the ERP actually reads.

   THE OWNER'S RULE, stated more than three times and finally pinned on
   2026-08-13:

     "我不要又 proceeded_at 又 processing_date 又 internal_expected_dd。我要统一,
      就是因为这样太多 bugs 了。全部跟着 processing date 就是 UI 看到的那个。"
     "只要有 Processing Date，就代表他 Proceed 了。Proceed 的日期是他填入
      Processing Date 的日期。"
     "没有 processing date 就代表没有 proceed。"

   So: Proceed is not an ACTION with its own timestamp. It is a STATE, and the
   state is "this order has a Processing Date". The date itself says WHEN the
   order goes into production. There is no separate "when was the button
   pressed" fact worth storing, and pretending there was is what produced two
   columns, two gates and two answers.

   WHAT PROD LOOKS LIKE TODAY (company 1, read 2026-08-13):
     2723 sales orders
        0 carry internal_expected_dd  — the column the UI writes and the ONLY
                                        column soProcessingLocked reads
      519 carry proceeded_at

   So every rule keyed on the Processing Date is dead right now: nothing is
   edit-locked, nothing is spec-gated, MRP reads a column that is empty on
   every row (mrp.ts:1002 `processingDate: r.so?.internal_expected_dd ?? null`).

   HOW THE 519 GOT THERE — TWO DIFFERENT KINDS OF VALUE IN ONE COLUMN:

     a) THE IMPORT wrote a business DATE.
        backfill-so-dates.mjs maps AutoCount's UDF_PDate — the header
        PROCESSING date — onto proceeded_at:
          UPDATE ... SET proceeded_at = ${u.p}::date
        A ::date cast into a timestamptz column lands at midnight, so these
        rows carry no time-of-day. This value IS the Processing Date; it is
        simply in the wrong column, and it is what this script moves.

     b) THE BUTTON wrote a CLICK TIMESTAMP.
          patch.proceeded_at = new Date().toISOString()   (mfg-sales-orders.ts)
        and the same at create for POS auto-proceed. Note what is NOT there:
        no line sets internal_expected_dd. The system can therefore put an
        order INTO PRODUCTION with no start date at all — a state the owner's
        rule says cannot exist. A click time is not a Processing Date and is
        NOT converted into one here: "没有 processing date 就代表没有 proceed",
        so those orders are reported as NOT PROCEEDED, and a human decides.

   TWO INDEPENDENT DISCRIMINATORS, CROSS-CHECKED, NEVER ONE ALONE.
     · provenance — linked_ac_docno IS NOT NULL marks an imported order; it is
       the same key backfill-so-dates.mjs joined on.
     · shape — an imported value is exactly midnight UTC; a click carries a
       time of day.
   A row is migrated only when BOTH agree. Where they disagree the row is
   REFUSED and listed, because a row I cannot classify is a row I must not
   rewrite. (Cross-checking matters: the button stamps only when proceeded_at
   is still null, but the backfill had no such guard, so a button press that
   preceded the backfill would have been overwritten by it.)

   WHAT THIS SCRIPT DOES NOT DO. It does not touch proceeded_at, and it does
   not drop it. Retiring a column is: stop writing it, stop reading it, then
   drop it — in that order, in separate changes. Moving the data first is the
   only step that is fully reversible on its own (revert = null out
   internal_expected_dd on exactly the doc_nos listed here, which the dry-run
   prints in full).

   WHAT THE OWNER MUST SEE BEFORE APPLY. The moment internal_expected_dd stops
   being null, every rule keyed on it wakes up at once. The dry-run therefore
   also reports, for the rows it would migrate:
     · how many become EDIT-LOCKED immediately (processing date already past)
     · how many would FAIL the proceed gate on their next save (missing
       address, postcode, delivery date, or deposit below the company's
       threshold)
   Those are not reasons to refuse — they are the true state of the data,
   which the empty column has been hiding.

   MODE=dry-run (default) runs every write inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN" and verifies on a
   second, fresh connection afterwards. */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const APPLY = (process.env.MODE || "dry-run").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const CO = Number(process.env.COMPANY || 1);
/* Houzs 30%, 2990 50% — processingDateThresholdFor(companyCode). Passed in so
   this script never re-invents a threshold the app already owns. */
const DEPOSIT_THRESHOLD = Number(process.env.DEPOSIT_THRESHOLD || (CO === 2 ? 0.5 : 0.3));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

async function main() {
  note(`mode=${APPLY ? "APPLY" : "DRY-RUN (everything rolls back)"} company=${CO} deposit_threshold=${DEPOSIT_THRESHOLD}`);

  // ── 1. CENSUS ────────────────────────────────────────────────────────────
  const [census] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE internal_expected_dd IS NOT NULL)::int AS has_ied,
           count(*) FILTER (WHERE proceeded_at IS NOT NULL)::int AS has_proc,
           count(*) FILTER (WHERE proceeded_at IS NOT NULL AND internal_expected_dd IS NULL)::int AS proc_no_ied,
           count(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int AS imported
      FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;
  note(`\n=== CENSUS (company ${CO}) ===`);
  note(`  sales orders:                                  ${census.total}`);
  note(`  imported from AutoCount (linked_ac_docno):     ${census.imported}`);
  note(`  carry internal_expected_dd (the UI's date):    ${census.has_ied}`);
  note(`  carry proceeded_at:                            ${census.has_proc}`);
  note(`  proceeded_at set but NO processing date:        ${census.proc_no_ied}`);

  /* ── 2. CLASSIFY, WITH BOTH DISCRIMINATORS ────────────────────────────────
     `shape` is midnight-vs-timed. AT TIME ZONE 'UTC' because the ::date cast
     that wrote these landed at UTC midnight; reading them back in any other
     zone would shift the date by a day. */
  const rows = await sql`
    SELECT doc_no, status::text AS status, linked_ac_docno,
           to_char(proceeded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS proc_date,
           to_char(proceeded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS proc_time,
           to_char(customer_delivery_date, 'YYYY-MM-DD') AS deliv,
           debtor_name, address1, postcode,
           paid_centi, local_total_centi
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND proceeded_at IS NOT NULL AND internal_expected_dd IS NULL
     ORDER BY doc_no`;

  const migrate = [], notProceeded = [], refused = [];
  for (const r of rows) {
    const byProvenance = r.linked_ac_docno != null && String(r.linked_ac_docno).trim() !== "";
    const byShape = r.proc_time === "00:00:00";
    if (byProvenance && byShape) migrate.push(r);
    else if (!byProvenance && !byShape) notProceeded.push(r);
    else refused.push({ ...r, why: byProvenance ? "imported but carries a time-of-day" : "not imported but sits at midnight" });
  }

  note(`\n=== CLASSIFICATION ===`);
  note(`  MIGRATE       ${String(migrate.length).padStart(5)}  imported AND midnight — an AutoCount processing date in the wrong column`);
  note(`  NOT PROCEEDED ${String(notProceeded.length).padStart(5)}  a click timestamp only — no processing date, so by the owner's rule not proceeded`);
  note(`  REFUSED       ${String(refused.length).padStart(5)}  the two discriminators disagree — not classified, not touched`);

  if (refused.length) {
    note(`\n  --- REFUSED, needs a human ---`);
    for (const r of refused.slice(0, 25)) {
      note(`    ${String(r.doc_no).padEnd(18)} ${String(r.status).padEnd(14)} ${r.proc_date} ${r.proc_time}  ac=${r.linked_ac_docno ?? "-"}  (${r.why})`);
    }
    if (refused.length > 25) note(`    … and ${refused.length - 25} more`);
  }

  /* The contradiction the owner's rule exposes: an order sitting at
     IN_PRODUCTION or beyond with no processing date is, by that rule, not
     proceeded — yet the pipeline already moved it on. Naming them is the point;
     this script does not silently pick a side. */
  const advanced = notProceeded.filter((r) => !["DRAFT", "CONFIRMED", "CANCELLED"].includes(r.status));
  note(`\n=== NOT PROCEEDED, but already past CONFIRMED: ${advanced.length} ===`);
  if (advanced.length) {
    note(`  These have no Processing Date, so by the rule they never proceeded —`);
    note(`  but their status says production already moved them on. Owner decides.`);
    for (const r of advanced.slice(0, 25)) {
      note(`    ${String(r.doc_no).padEnd(18)} ${String(r.status).padEnd(14)} clicked ${r.proc_date} ${r.proc_time}  deliv=${r.deliv ?? "-"}`);
    }
    if (advanced.length > 25) note(`    … and ${advanced.length - 25} more`);
  }

  /* ── 3. WHAT WAKES UP ─────────────────────────────────────────────────────
     Today MYT: the same +8 shift soProcessingLocked applies. A processing date
     strictly BEFORE today locks the order (procYmd === today stays open). */
  const [{ today_my: todayMY }] = await sql`SELECT to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS today_my`;
  const wouldLock = migrate.filter((r) => r.proc_date < todayMY && !["DRAFT", "CANCELLED"].includes(r.status));
  const gateFail = migrate.map((r) => {
    const miss = [];
    if (!(r.debtor_name ?? "").trim()) miss.push("customer name");
    if (!(r.address1 ?? "").trim()) miss.push("address line 1");
    if (!(r.postcode ?? "").trim()) miss.push("postcode");
    if (!r.deliv) miss.push("delivery date");
    const total = Number(r.local_total_centi || 0), paid = Number(r.paid_centi || 0);
    if (total > 0 && paid / total < DEPOSIT_THRESHOLD) {
      miss.push(`deposit ${(100 * paid / total).toFixed(0)}% < ${(100 * DEPOSIT_THRESHOLD).toFixed(0)}%`);
    }
    return { doc: r.doc_no, miss };
  }).filter((x) => x.miss.length);

  note(`\n=== WHAT WAKES UP THE MOMENT THE DATE LANDS (today MYT = ${todayMY}) ===`);
  note(`  become EDIT-LOCKED immediately (processing date already past):  ${wouldLock.length} of ${migrate.length}`);
  note(`  would FAIL the proceed gate on their NEXT save:                 ${gateFail.length} of ${migrate.length}`);
  note(`  (the gate does not run on this migration — it runs when a human next saves that order)`);
  const reasonTally = new Map();
  for (const g of gateFail) for (const m of g.miss) {
    const k = m.startsWith("deposit") ? "deposit below threshold" : m;
    reasonTally.set(k, (reasonTally.get(k) || 0) + 1);
  }
  for (const [k, n] of [...reasonTally].sort((a, b) => b[1] - a[1])) note(`     ${String(n).padStart(5)}  ${k}`);
  for (const g of gateFail.slice(0, 15)) note(`     ${String(g.doc).padEnd(18)} ${g.miss.join(", ")}`);
  if (gateFail.length > 15) note(`     … and ${gateFail.length - 15} more`);

  /* The full revert key. Printed in the dry-run so the undo exists BEFORE the
     do — reverting is: null out internal_expected_dd on exactly these doc_nos. */
  note(`\n=== REVERT KEY — the ${migrate.length} doc_no(s) this would write ===`);
  for (let i = 0; i < migrate.length; i += 12) {
    note(`  ${migrate.slice(i, i + 12).map((r) => r.doc_no).join(" ")}`);
  }

  if (!migrate.length) {
    note(`\nNothing to migrate.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── 4. WRITE ─────────────────────────────────────────────────────────────
  let wrote = 0;
  const ROLLBACK = Symbol("dry-run rollback");
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < migrate.length; i += 200) {
        for (const r of migrate.slice(i, i + 200)) {
          /* Company-scoped on every statement: the service role bypasses RLS,
             so this predicate is the only isolation there is. The IS NULL
             guard makes a re-run a no-op instead of an overwrite. */
          const back = await tx`
            UPDATE scm.mfg_sales_orders
               SET internal_expected_dd = ${r.proc_date}::date
             WHERE company_id = ${CO} AND doc_no = ${r.doc_no}
               AND internal_expected_dd IS NULL
            RETURNING doc_no`;
          wrote += back.length;
        }
      }
      note(`\n${APPLY ? "wrote" : "would write"}: ${wrote} row(s)`);
      if (wrote !== migrate.length) {
        throw new Error(`expected to write ${migrate.length}, wrote ${wrote} — refusing`);
      }
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`DRY-RUN: transaction rolled back, nothing was written.`);
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── 5. VERIFY ON A FRESH CONNECTION ──────────────────────────────────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const [after] = await check`
      SELECT count(*) FILTER (WHERE internal_expected_dd IS NOT NULL)::int AS has_ied,
             count(*) FILTER (WHERE proceeded_at IS NOT NULL AND internal_expected_dd IS NULL)::int AS still_split
        FROM scm.mfg_sales_orders WHERE company_id = ${CO}`;
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    note(`  now carry a Processing Date:                  ${after.has_ied}  (was ${census.has_ied})`);
    note(`  proceeded_at set but still no Processing Date: ${after.still_split}  (was ${census.proc_no_ied})`);
    note(`  ${after.still_split} = the not-proceeded + refused rows, deliberately untouched`);

    const mismatch = await check`
      SELECT doc_no FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND internal_expected_dd IS NOT NULL
         AND proceeded_at IS NOT NULL
         AND internal_expected_dd <> (proceeded_at AT TIME ZONE 'UTC')::date
       LIMIT 10`;
    if (mismatch.length) {
      bad(`${mismatch.length}+ row(s) where the moved date does not equal proceeded_at's date: ${mismatch.map((r) => r.doc_no).join(", ")}`);
    } else {
      note(`  every migrated date equals its source proceeded_at date`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
