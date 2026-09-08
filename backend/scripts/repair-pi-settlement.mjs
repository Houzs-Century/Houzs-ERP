#!/usr/bin/env node
/* Settle the purchase invoices an approved AP Payment paid but never marked paid.

   Why (docs/bugs/0700; owner 2026-09-08: 这个要做): approving a SUPPLIER_PAYMENT
   voucher settles each purchase invoice it pays through scm.settle_pi_paid_sen,
   and until 20260908T0900_scm_settle_pi_paid_sen_enum_status.sql that function
   failed on every call (42804 — it wrote a text status into the enum column).
   The voucher's journal entry was posted and the money left; the invoice never
   moved: paid_sen 0, status POSTED, still open in the AP Payment picker, still
   editable, and pv_allocations.applied_sen recorded 0 — so a cancel of the
   voucher would have released nothing. On prod that is 21 allocations under two
   2990 vouchers (2990-HPV-2608-026, 2990-HPV-2609-002), RM 46,948.10.

   WHICH rows, exactly — never "every allocation":
     • pv_allocations naming a purchase invoice (pi_id), with applied_sen 0 or
       NULL and amount_sen > 0, whose voucher is POSTED (approved = in the GL)
       with purpose SUPPLIER_PAYMENT.
   Each is settled through THE SAME function the approve calls — same row lock,
   same clamp at the invoice's outstanding — and applied_sen records what the
   function actually applied, exactly as the approve does, so a later cancel
   reverses the true figure. Vouchers are taken in the order they were approved.
   A row the function refuses is listed and left alone: an invoice that is
   DRAFT/CANCELLED (not_live), or one already paid in full (applied 0). A
   FOREIGN-currency row is listed and left alone too — the approve path also
   adopts the payment's rate onto an un-rated invoice and re-costs its GRN, and
   that is not replayed here (cancel and re-approve the voucher instead).

   PRECONDITION: the fixed function must be on the target. The script reads the
   function's body from the catalog and refuses to run (exit 3) while the enum
   cast is missing — settling through the broken one would only fail again.

   MODE=plan (default) reports; MODE=apply needs CONFIRM="SETTLE PI ALLOCATIONS".
   RE-RUN: convergent — a settled allocation no longer matches and reports nothing.
   Verification re-reads on a FRESH connection and asserts the shape: no MYR
   candidate whose invoice is live with money outstanding remains, and the sum
   applied equals the sum the plan expected. */
import postgres from "postgres";

const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = "SETTLE PI ALLOCATIONS";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM}"`); process.exit(2);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => (Number(sen) / 100).toFixed(2);

/* The marker the fix migration leaves in the function body. */
const FIX_MARKER = "::scm.purchase_invoice_status";

const CANDIDATES = (sql) => sql`
  SELECT a.id AS alloc_id, a.pi_id, a.amount_sen, a.applied_sen,
         v.company_id, v.pv_number, v.posted_at, v.currency AS pv_ccy,
         p.invoice_number, p.status::text AS pi_status, p.total_sen, p.paid_sen,
         p.currency::text AS pi_ccy
  FROM scm.pv_allocations a
  JOIN scm.payment_vouchers v ON v.id = a.pv_id
  JOIN scm.purchase_invoices p ON p.id = a.pi_id
  WHERE a.pi_id IS NOT NULL
    AND COALESCE(a.applied_sen, 0) = 0
    AND a.amount_sen > 0
    AND v.status::text = 'POSTED'
    AND v.purpose::text = 'SUPPLIER_PAYMENT'
  ORDER BY v.posted_at, v.pv_number, a.created_at, p.invoice_number`;

const isLive = (r) => !["DRAFT", "CANCELLED"].includes(String(r.pi_status ?? "").toUpperCase());
const isMyr = (r) => String(r.pi_ccy ?? "MYR").toUpperCase() === "MYR" && String(r.pv_ccy ?? "MYR").toUpperCase() === "MYR";
const outstanding = (r) => Math.max(0, Number(r.total_sen ?? 0) - Number(r.paid_sen ?? 0));
/* What the function will apply: the allocation, clamped at the outstanding. */
const expectedSen = (r) => (isLive(r) ? Math.min(Number(r.amount_sen), outstanding(r)) : 0);
const expectedStatus = (r) => {
  const paid = Number(r.paid_sen ?? 0) + expectedSen(r);
  return paid >= Number(r.total_sen ?? 0) ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "POSTED";
};
/* The rows this script settles; everything else is listed and left alone. */
const settleable = (r) => isMyr(r) && isLive(r) && expectedSen(r) > 0;

async function assertFixApplied(sql) {
  const [row] = await sql`
    SELECT position(${FIX_MARKER} IN pg_get_functiondef('scm.settle_pi_paid_sen(uuid,bigint)'::regprocedure)) > 0 AS fixed`;
  if (!row?.fixed) {
    console.error("scm.settle_pi_paid_sen on this database still writes a text status into the enum column — "
      + "apply 20260908T0900_scm_settle_pi_paid_sen_enum_status.sql first (the deploy does).");
    process.exit(3);
  }
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  note(`mode=${APPLY ? "APPLY" : "PLAN (read-only)"}`);
  await assertFixApplied(sql);
  const rows = await CANDIDATES(sql);
  const todo = rows.filter(settleable);
  const stuck = rows.filter((r) => !settleable(r));

  const perCompany = new Map();
  for (const r of todo) {
    const c = perCompany.get(r.company_id) ?? { n: 0, sen: 0, vouchers: new Set() };
    c.n += 1; c.sen += expectedSen(r); c.vouchers.add(r.pv_number);
    perCompany.set(r.company_id, c);
  }
  for (const [co, c] of perCompany) note(`co${co}: ${c.n} allocation(s) under ${c.vouchers.size} voucher(s), RM ${rm(c.sen)} to settle`);
  for (const r of todo) {
    const clamp = expectedSen(r) < Number(r.amount_sen) ? ` (clamped from ${rm(r.amount_sen)}: outstanding ${rm(outstanding(r))})` : "";
    note(`  co${r.company_id} ${r.pv_number} -> ${r.invoice_number}: RM ${rm(expectedSen(r))} => ${expectedStatus(r)}${clamp}`);
  }
  for (const r of stuck) {
    const why = !isMyr(r) ? `foreign currency ${r.pi_ccy}/${r.pv_ccy} — cancel and re-approve the voucher`
      : !isLive(r) ? `invoice is ${r.pi_status}`
      : `invoice already paid in full (RM ${rm(r.paid_sen)} of ${rm(r.total_sen)})`;
    note(`LEFT ALONE: co${r.company_id} ${r.pv_number} -> ${r.invoice_number} RM ${rm(r.amount_sen)}: ${why}`);
  }
  const expectedTotal = todo.reduce((s, r) => s + expectedSen(r), 0);
  if (!APPLY) {
    note(`PLAN complete — ${todo.length} allocation(s) would settle RM ${rm(expectedTotal)}, ${stuck.length} left alone.`);
  } else {
    let settled = 0; let appliedTotal = 0;
    for (const r of todo) {
      const res = await sql.begin(async (tx) => {
        const [s] = await tx`
          SELECT applied_sen, new_paid_sen, new_status, reason
          FROM scm.settle_pi_paid_sen(${r.pi_id}::uuid, ${Number(r.amount_sen)}::bigint)`;
        const applied = Number(s?.applied_sen ?? 0);
        if (applied > 0) {
          const u = await tx`UPDATE scm.pv_allocations SET applied_sen = ${applied}
            WHERE id = ${r.alloc_id} AND COALESCE(applied_sen, 0) = 0`;
          if (u.count !== 1) throw new Error(`allocation ${r.alloc_id} (${r.pv_number} -> ${r.invoice_number}) moved under us`);
        }
        return { applied, status: s?.new_status ?? null, reason: s?.reason ?? null };
      });
      if (res.applied > 0) { settled += 1; appliedTotal += res.applied; }
      note(`  ${res.applied > 0 ? "settled" : "REFUSED"}: ${r.pv_number} -> ${r.invoice_number} applied RM ${rm(res.applied)} => ${res.status ?? "?"}${res.reason ? ` (${res.reason})` : ""}`);
    }
    note(`settled ${settled} of ${todo.length}, RM ${rm(appliedTotal)} applied (plan expected RM ${rm(expectedTotal)})`);
    // fresh-connection SHAPE verification
    await sql.end({ timeout: 5 });
    const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
    const left = (await CANDIDATES(check)).filter(settleable);
    const ids = todo.map((r) => r.alloc_id);
    const [sum] = ids.length > 0
      ? await check`SELECT COALESCE(SUM(applied_sen), 0)::bigint AS applied FROM scm.pv_allocations WHERE id IN ${check(ids)}`
      : [{ applied: 0 }];
    await check.end({ timeout: 5 });
    note(`verify: ${left.length} settleable allocation(s) still at applied_sen 0; RM ${rm(sum.applied)} now recorded on the ${ids.length} allocation(s)`);
    if (left.length > 0 || settled !== todo.length || Number(sum.applied) !== expectedTotal) {
      console.error("VERIFICATION FAILED"); process.exit(1);
    }
    note("APPLIED and verified on a fresh connection.");
    process.exit(0);
  }
} finally {
  try { await sql.end({ timeout: 5 }); } catch { /* closed above on apply */ }
}
