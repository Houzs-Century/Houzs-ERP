#!/usr/bin/env node
// DIAG (+ optional backfill) — "this SKU has no PWP price set (SKU Master)".
//
// 2026-08-01, from a POS order that died with:
//   pwp_code_rejected — CODY-(SS): PWP-4599PWWB — this SKU has no PWP price set
//                       CODY-(Q):  PWP-1018CWUU — this SKU has no PWP price set
//
// That reject fires at ONE place: scm/routes/mfg-sales-orders.ts, where a
// non-'promo' voucher demands `mfg_products.pwp_price_sen > 0` on the reward
// SKU. Reaching it already proves the code exists, is redeemable, matches the
// reward category and the customer — the ONLY failing fact is the price. On the
// 2990 source those same SKUs carry pwp_price_sen = 49000 (RM 490), so the
// value did not survive the move.
//
// Two candidate causes, and they need OPPOSITE fixes — hence one probe:
//
//   H1 DATA. The company-2 row's pwp_price_sen really is 0. mfg_products was
//      NOT in migrate-2990-into-houzs.mjs's ORDER until 2026-07-23 (see the
//      note there) — the catalog landed via a manual one-shot at cutover, and
//      because the top-up inserts ON CONFLICT DO NOTHING, no later run could
//      ever repair a column that one-shot omitted. Fix = backfill (below).
//
//   H2 CODE. The row is fine, but the SO path reads a DIFFERENT row.
//      `idx_mfg_products_code` is a PLAIN index, not unique, and
//      loadProductsByCodes() (mfg-pricing-recompute.ts) does a bare
//      `.in('code', …)` with NO company predicate and NO ORDER BY, then keys a
//      Map by code — so with more than one row per code it keeps whichever
//      Postgres returned last. 0187's own header already asserts the natural
//      key is (company_id, product_code) "the key the SO pricing path already
//      resolves by" — it doesn't. Fix = scope the loader, NOT a backfill.
//
// THE POS ALREADY POINTS AT H2. Configurator.tsx runs the SAME rule client-side
// (`hasPwpPrice`, :1516) off the COMPANY-SCOPED /pos-pools/mfg-catalog read, and
// `appliedPwpCode` (:1526) is null unless it passes — both the same-cart toggle
// and Insert PWP Code. A non-promo code therefore cannot even be ATTACHED to a
// line unless the POS saw pwp_price_sen > 0 for that exact size; the operator
// would have got "This size has no PWP price set — set it in SKU Master first."
// (:851) instead. They didn't — they reached Complete order, and only the server
// refused. Two reads of one code disagreeing is what a duplicate row looks like.
//
// AND THE SKU MASTER SHOWS RM 490 FOR THESE SKUS. The POS Products page is not
// a separate table: since the 2026-07-21 flip the POS builds with
// VITE_BACKEND_TARGET=houzs (deploy.yml) and every authedFetch goes to
// erp.houzscentury.com/api/scm with X-Company-Id: 2 — the SAME GET /mfg-products
// the Houzs SCM Products page uses. One row, two column projections: the POS
// renders sell_price_sen + pwp_price_sen (selling), the SCM page renders
// base_price_sen + price1_sen as "Price 2"/"Price 1" (cost) — the 0109 split.
// So the RM 490 on that screen IS this database, and the SO path still reads 0.
//
// WHERE A DUPLICATE CAN HIDE. GET /mfg-products is scopeToCompany'd, ordered by
// code AND filtered `.eq('status','ACTIVE')`. loadProductsByCodes has NONE of
// those three. So a duplicate that is another company's row, OR a company-2 row
// left non-ACTIVE, is invisible in both SKU Masters while remaining perfectly
// visible to the SO path — which is why both screens can still show a tidy 50.
//
// Section A settles it, and it is deliberately NOT restricted to cross-company
// duplicates: the top-up inserts the source's verbatim `id`, so a one-shot that
// minted different ids leaves TWO rows for one code under the SAME company, and
// the unordered read breaks identically. It reports status per code for the same
// reason. If A is empty, it is H1 after all.
//
// READ-ONLY by default. APPLY=1 additionally fills company-2 rows whose
// pwp_price_sen is 0 while the 2990 source has a real value — zeros only, so
// it can never lower a price an operator has since set by hand.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const DST = process.env.DATABASE_URL;
const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const APPLY = process.env.APPLY === "1";
// The SKUs + vouchers from the report. Override to probe a different failure.
const FOCUS_CODES = (process.env.FOCUS_CODES ?? "CODY").split(",").map((s) => s.trim()).filter(Boolean);
const FOCUS_VOUCHERS = (process.env.FOCUS_VOUCHERS ?? "PWP-4599PWWB,PWP-1018CWUU").split(",").map((s) => s.trim()).filter(Boolean);

if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const src = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } }) : null;

const rm = (sen) => (sen == null ? "—" : `RM ${(Number(sen) / 100).toFixed(2)}`);

async function sourcePwpByCode() {
  if (!src) return null;
  const out = new Map();
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src.schema("public").from("mfg_products")
      .select("code, category, sell_price_sen, pwp_price_sen").range(f, f + P - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.set(r.code, r);
    if (!data || data.length < P) break;
  }
  return out;
}

async function main() {
  const co = await db`SELECT id, code FROM companies ORDER BY id`;
  const cid2990 = co.find((r) => r.code === "2990")?.id;
  console.log(`companies: ${co.map((r) => `${r.code}=${r.id}`).join("  ")}`);
  if (cid2990 == null) throw new Error("no 2990 company row — wrong DB?");
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}  source=${src ? "connected" : "NOT SET (sections D/E skipped)"}\n`);

  /* ── A. duplicate codes — the H2 hazard, BOTH flavours ───────────────────
     `idx_mfg_products_code` is a plain index, so one code may repeat
     ACROSS companies (the manual one-shot landed under one company, the
     top-up under another) or WITHIN one (the top-up inserts the source's
     verbatim `id`, so `ON CONFLICT DO NOTHING` skips nothing when the
     one-shot minted different ids — a second row for the same code).
     Both break the SO path's unscoped, unordered `.in('code', …)` -> Map
     identically: it keeps whichever row Postgres returned last. Rows that
     also DISAGREE on pwp_price_sen are the ones that reproduce this reject. */
  console.log("=== A. codes with MORE THAN ONE row (unscoped/unordered-read hazard) ===");
  const dupes = await db`
    SELECT code,
           count(*)::int                          AS n_rows,
           count(DISTINCT company_id)::int        AS n_companies,
           array_agg(DISTINCT company_id)         AS companies,
           array_agg(DISTINCT status::text)       AS statuses,
           count(*) FILTER (WHERE status = 'ACTIVE')::int AS n_active,
           array_agg(DISTINCT pwp_price_sen)      AS pwp_values,
           array_agg(DISTINCT sell_price_sen)     AS sell_values
    FROM scm.mfg_products
    GROUP BY code
    HAVING count(*) > 1
    ORDER BY code`;
  if (dupes.length === 0) {
    console.log("  (none — every code has exactly one row; H2 is RULED OUT, cause is H1 data)");
  } else {
    const xco = dupes.filter((d) => d.n_companies > 1);
    const inco = dupes.filter((d) => d.n_companies === 1);
    const pwpSplit = dupes.filter((d) => (d.pwp_values ?? []).length > 1);
    const hidden = dupes.filter((d) => d.n_active < d.n_rows);
    console.log(`  ${dupes.length} duplicated code(s): ${xco.length} across companies, ${inco.length} within one company`);
    console.log(`  ${pwpSplit.length} of them DISAGREE on pwp_price_sen  <-- these reproduce the reject`);
    console.log(`  ${hidden.length} have a non-ACTIVE row: INVISIBLE in both SKU Masters (GET /mfg-products filters status='ACTIVE'), still picked by the SO path (no status filter)`);
    for (const d of dupes.slice(0, 40)) {
      const flag = (d.pwp_values ?? []).length > 1 ? "  <-- pwp split" : "";
      console.log(`  ${d.code.padEnd(16)} rows=${d.n_rows} (${d.n_active} ACTIVE) companies=[${d.companies}] status=[${d.statuses}]  pwp=[${d.pwp_values}]  sell=[${d.sell_values}]${flag}`);
    }
    if (dupes.length > 40) console.log(`  … ${dupes.length - 40} more`);
    console.log("  H2 is LIVE — backfilling data will NOT reliably fix these; the loaders must resolve by (company_id, code)");
    console.log("  and the duplicate rows must be reconciled. Section F deliberately does NOT touch a duplicated code.");
  }

  // ── B. the SKUs from the report, every company ──────────────────────────
  console.log(`\n=== B. rows for code(s) LIKE ${FOCUS_CODES.map((c) => `${c}%`).join(" / ")} (all companies) ===`);
  for (const prefix of FOCUS_CODES) {
    const rows = await db`
      SELECT code, company_id, category, status, pos_active, sell_price_sen, pwp_price_sen, model_id
      FROM scm.mfg_products WHERE code LIKE ${prefix + "%"} ORDER BY code, company_id`;
    if (rows.length === 0) { console.log(`  ${prefix}%: (no rows at all)`); continue; }
    for (const r of rows) {
      const flag = Number(r.pwp_price_sen) > 0 ? "" : "   <-- pwp 0 = REJECTS every non-promo voucher";
      console.log(`  ${r.code.padEnd(14)} co=${String(r.company_id).padEnd(4)} ${String(r.category).padEnd(9)} ${r.status} pos_active=${r.pos_active}  sell=${rm(r.sell_price_sen)}  pwp=${rm(r.pwp_price_sen)}${flag}`);
    }
  }

  // ── C. the vouchers themselves ──────────────────────────────────────────
  console.log(`\n=== C. voucher rows ${FOCUS_VOUCHERS.join(", ")} ===`);
  const codes = await db`
    SELECT code, company_id, status, type, reward_category, eligible_reward_model_ids,
           reward_size_codes, reward_compartments, customer_id, source_doc_no, redeemed_doc_no, created_at
    FROM scm.pwp_codes WHERE code = ANY(${FOCUS_VOUCHERS})`;
  if (codes.length === 0) console.log("  (none found — check the codes)");
  for (const r of codes) {
    console.log(`  ${r.code}  co=${r.company_id}  ${r.status}/${r.type}  rewards=${r.reward_category}  from=${r.source_doc_no ?? "—"}  models=${JSON.stringify(r.eligible_reward_model_ids)}  sizes=${JSON.stringify(r.reward_size_codes)}`);
  }

  // ── D. blast radius: which company-2 SKUs lost their PWP price ──────────
  const srcMap = await sourcePwpByCode();
  if (!srcMap) {
    console.log("\n=== D/E skipped — set SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY to diff against 2990 ===");
  } else {
    const dest = await db`
      SELECT id, code, category, sell_price_sen, pwp_price_sen
      FROM scm.mfg_products WHERE company_id = ${cid2990} ORDER BY code`;
    const dupCodes = new Set(dupes.map((d) => d.code));
    const gap = [], divergent = [], missingOnSrc = [], gapButDuplicated = [];
    for (const d of dest) {
      const s = srcMap.get(d.code);
      if (!s) { missingOnSrc.push(d); continue; }
      const sp = Number(s.pwp_price_sen ?? 0), dp = Number(d.pwp_price_sen ?? 0);
      if (dp === 0 && sp > 0) (dupCodes.has(d.code) ? gapButDuplicated : gap).push({ ...d, srcPwp: sp });
      else if (dp !== sp) divergent.push({ ...d, srcPwp: sp });
    }
    console.log(`\n=== D. company-2 SKUs where Houzs pwp=0 but 2990 has a price (the gap) ===`);
    console.log(`  dest company-2 rows: ${dest.length}   fillable gap: ${gap.length}   gap on a DUPLICATED code (held back): ${gapButDuplicated.length}   other divergence: ${divergent.length}   not on source: ${missingOnSrc.length}`);
    for (const g of gapButDuplicated.slice(0, 20)) console.log(`    HELD ${g.code.padEnd(16)} houzs=${rm(g.pwp_price_sen)}  2990=${rm(g.srcPwp)}  (code has >1 row — reconcile the rows first)`);
    if (gapButDuplicated.length > 20) console.log(`    … ${gapButDuplicated.length - 20} more held`);
    const byCat = new Map();
    for (const g of gap) byCat.set(g.category, (byCat.get(g.category) ?? 0) + 1);
    for (const [cat, n] of [...byCat].sort()) console.log(`    ${String(cat).padEnd(10)} ${n}`);
    for (const g of gap.slice(0, 30)) console.log(`    ${g.code.padEnd(16)} houzs=${rm(g.pwp_price_sen)}  2990=${rm(g.srcPwp)}`);
    if (gap.length > 30) console.log(`    … ${gap.length - 30} more`);

    console.log(`\n=== E. company-2 SKUs whose PWP price differs from 2990 in some OTHER way ===`);
    if (divergent.length === 0) console.log("  (none)");
    for (const d of divergent.slice(0, 20)) console.log(`    ${d.code.padEnd(16)} houzs=${rm(d.pwp_price_sen)}  2990=${rm(d.srcPwp)}`);
    if (divergent.length > 20) console.log(`    … ${divergent.length - 20} more`);

    /* ── F. backfill (APPLY=1) ────────────────────────────────────────────
       ZEROS ONLY, and only where the source has a real price. A SKU whose
       PWP price an operator has already set by hand on Houzs is never
       touched, and neither is one the source also leaves at 0 (that 0 is a
       deliberate "not a PWP reward"). Row-by-row by id — company-2 rows
       only — so a duplicated code cannot splash onto the other company. */
    console.log(`\n=== F. backfill ${APPLY ? "(APPLYING)" : "(dry-run — set APPLY=1 to write)"} ===`);
    if (gap.length === 0) {
      console.log("  nothing to fill");
    } else if (!APPLY) {
      console.log(`  would set pwp_price_sen on ${gap.length} company-2 row(s) from the 2990 source`);
    } else {
      let n = 0;
      for (const g of gap) {
        const r = await db`
          UPDATE scm.mfg_products SET pwp_price_sen = ${g.srcPwp}, updated_at = now()
          WHERE id = ${g.id} AND company_id = ${cid2990} AND pwp_price_sen = 0`;
        n += r.count ?? 0;
      }
      console.log(`  updated ${n} row(s)`);
    }
  }
}

main().then(() => db.end()).catch(async (e) => {
  console.error("DIAG_FAIL", e.message);
  await db.end();
  process.exit(1);
});
