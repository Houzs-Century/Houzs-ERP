#!/usr/bin/env node
// ----------------------------------------------------------------------------
// RE-PUSH MIGRATED SALES ORDERS' BALANCE TO AUTOCOUNT — the 0842 backfill.
//
// WHY. Until 2026-09-12 `readSoOutstandingSen` refused to compose `UDF_BALANCE`
// for a migrated order (total_revenue_sen = 0), so a balance COLLECTED in the
// ERP after the cutover never reached the account book — and the "HC Delivery"
// operations sheet reads the balance FROM the book. 34 company-1 orders sat
// reading as owing RM 101,034 already collected (docs/bugs/0842,
// docs/migrated-so-lock-lifted-coe.md). autocount-read.ts now takes the
// local_total_sen fallback (AutoCount is push-only), so ONE more edit per order
// pushes the corrected balance.
//
// WHAT IT DOES. For each target order it calls the SAME `enqueueEdit` the routes
// call — a KEYED edit (rebuild: false), so it re-pushes the header (UDF_BALANCE)
// against the existing line keys and DESTROYS NOTHING. The drain sends it with
// the fixed composer. It never creates a second document.
//
// TARGETS. Default: company-1 orders that carry an `imported` payment row (a
// cutover migration) AND a later non-imported one (a collection the ERP took) —
// the exact shape of the 34. Override with DOC_NOS="HC-SO-x,HC-SO-y".
//
// ⚠ THE ONE RESIDUAL RISK (reason 2 in autocount-read.ts). For an order whose
// customer ALSO paid DIRECTLY in AutoCount (2026-08-28 .. the lock) and that
// never reached the ERP (docs/bugs/0678), local_total - paid OVERSTATES the
// debt. A SETTLED order (balance 0) cannot overstate; a PARTIAL one (balance
// > 0) can. So partials are HELD BACK by default and listed for a human to
// check against the book; add INCLUDE_PARTIAL=1 to push them too.
//
// MODE: DRY RUN unless APPLY=1. The dry run composes for real and throws the
// write away, so a refusal is the composer's own.
// CONFIRM: APPLY needs CONFIRM="PUSH MIGRATED BALANCE".
// RE-RUN: safe — a keyed edit is not additive; the book ends holding the ERP's
// balance either way, and an already-queued pending edit dedupes.
//
// Run: npx tsx scripts/backfill-migrated-so-balance-push.mjs            (plan)
//      APPLY=1 CONFIRM="PUSH MIGRATED BALANCE" npx tsx scripts/backfill-migrated-so-balance-push.mjs
// ----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const APPLY = process.env.APPLY === "1";
const CONFIRM = (process.env.CONFIRM || "").trim();
const INCLUDE_PARTIAL = process.env.INCLUDE_PARTIAL === "1";
const COMPANY_ID = Number(process.env.COMPANY_ID || "1");
const DOC_NOS = (process.env.DOC_NOS || "").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIRM_PHRASE = "PUSH MIGRATED BALANCE";

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toFixed(2)}`;

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY needs CONFIRM=${JSON.stringify(CONFIRM_PHRASE)}. Got ${JSON.stringify(CONFIRM)}.`);
  process.exit(2);
}

function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch { return undefined; }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

/* Indicative paid for CLASSIFICATION only — the drain's composer computes the
   authoritative UDF_BALANCE via readSoOutstandingSen. Deposit double-count edge
   (a legacy header deposit not in the ledger) is not modelled here because it
   only shifts a SETTLED order, never turns a settled one partial. */
async function targets() {
  if (DOC_NOS.length) {
    return pg`
      SELECT o.doc_no, o.company_id, o.linked_ac_docno,
             COALESCE(o.local_total_sen, 0) AS local_total_sen,
             COALESCE((SELECT SUM(p.amount_sen) FROM scm.mfg_sales_order_payments p
                       WHERE p.so_doc_no = o.doc_no), 0) AS paid_sen
      FROM scm.mfg_sales_orders o
      WHERE o.doc_no = ANY(${DOC_NOS}) AND o.company_id = ${COMPANY_ID}
      ORDER BY o.doc_no`;
  }
  return pg`
    SELECT o.doc_no, o.company_id, o.linked_ac_docno,
           COALESCE(o.local_total_sen, 0) AS local_total_sen,
           COALESCE((SELECT SUM(p.amount_sen) FROM scm.mfg_sales_order_payments p
                     WHERE p.so_doc_no = o.doc_no), 0) AS paid_sen
    FROM scm.mfg_sales_orders o
    WHERE o.company_id = ${COMPANY_ID}
      AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p
                  WHERE p.so_doc_no = o.doc_no AND p.method = 'imported')
      AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p
                  WHERE p.so_doc_no = o.doc_no AND COALESCE(p.method, '') <> 'imported')
    ORDER BY o.doc_no`;
}

/* Enqueue one keyed edit, capturing the composed row in dry run. Mirrors
   rebuild-ac-document.mjs, but rebuild:false — a header re-push, not a rebuild. */
async function enqueueOne(docNo, companyId) {
  const captured = [];
  const probe = pgrestShim(pg, "scm", { writeback: APPLY ? "enqueue" : "enqueue" });
  const realFrom = probe.from.bind(probe);
  probe.from = (table) => {
    const q = realFrom(table);
    if (table !== "autocount_outbox" || APPLY) return q;
    const realInsert = q.insert.bind(q);
    q.insert = (rows) => { captured.push(...(Array.isArray(rows) ? rows : [rows])); return realInsert([]); };
    return q;
  };
  await enqueueEdit(probe, { companyId: Number(companyId), docType: "SO", docNo, rebuild: false });
  return captured;
}

async function main() {
  notice(`mode=${APPLY ? "APPLY" : "DRY RUN"} company=${COMPANY_ID} include_partial=${INCLUDE_PARTIAL}`);
  const rows = await targets();
  if (!rows.length) { notice("no target orders. Nothing to do."); return 0; }

  const settled = [], partial = [], unlinked = [];
  for (const r of rows) {
    const bal = Math.max(0, Number(r.local_total_sen) - Number(r.paid_sen));
    const rec = { ...r, bal };
    if (!r.linked_ac_docno) unlinked.push(rec);
    else if (bal > 0) partial.push(rec);
    else settled.push(rec);
  }

  notice(`targets=${rows.length}  settled(bal 0)=${settled.length}  partial(bal>0)=${partial.length}  unlinked=${unlinked.length}`);
  if (unlinked.length) {
    warn(`${unlinked.length} carry no linked_ac_docno — never reached AutoCount; a CREATE is their operation, not this. Skipped: ${unlinked.map((r) => r.doc_no).join(", ")}`);
  }
  if (partial.length) {
    warn(`PARTIAL balances (reason 2 — verify against the book before pushing): ` +
      partial.map((r) => `${r.doc_no} ${rm(r.bal)}`).join(", "));
    if (!INCLUDE_PARTIAL) warn("partials are HELD BACK. Re-run with INCLUDE_PARTIAL=1 once verified.");
  }

  const toPush = INCLUDE_PARTIAL ? [...settled, ...partial] : settled;
  notice(`will ${APPLY ? "ENQUEUE" : "compose (dry run)"} ${toPush.length} edit(s).`);

  let enqueued = 0, refused = 0;
  for (const r of toPush) {
    const captured = await enqueueOne(r.doc_no, r.company_id);
    if (!APPLY) {
      const bad = captured.find((c) => c.status === "skipped");
      if (bad) { refused++; warn(`${r.doc_no}: composer REFUSED — ${bad.last_error}`); }
      else enqueued++;
    } else {
      enqueued++;
      notice(`${r.doc_no}: edit enqueued (book balance -> ${rm(r.bal)}).`);
    }
  }
  notice(`${APPLY ? "ENQUEUED" : "WOULD ENQUEUE"} ${enqueued}; composer refusals ${refused}.`);
  if (!APPLY) notice(`DRY RUN — re-run with APPLY=1 CONFIRM=${JSON.stringify(CONFIRM_PHRASE)} to enqueue.`);
  return 0;
}

main().then((c) => pg.end().then(() => process.exit(c ?? 0)))
  .catch((e) => { console.error(e); return pg.end().then(() => process.exit(1)); });
