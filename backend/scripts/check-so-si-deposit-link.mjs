// check-so-si-deposit-link — READ-ONLY diagnosis for "the order is fully paid but
// the invoice raised from it still shows the whole balance owing" (the
// si-order-deposit read-through, #2681, not applying).
//
// It prints the exact linkage that read-through keys on, so nobody has to open a
// SQL console:
//   - the ORDER (mfg_sales_orders) by doc_no + its payments (mfg_sales_order_payments);
//   - the DELIVERY ORDER's so_doc_no (what the invoice inherits);
//   - EVERY sales_invoice carrying that so_doc_no (or linked by delivery_order_id).
// A so_doc_no / company_id mismatch, or a sibling invoice that already absorbed
// the deposit (allocation is earliest-first), then reads straight off the output.
//
// WHY A SCRIPT + WORKFLOW. The answer lives only in production, so the alternative
// was a human holding the DSN pasting SELECTs. Actions already holds
// secrets.DATABASE_URL for the deploy; the check runs there and nobody handles the
// credential.
//
// Strictly SELECTs. No writes, no DDL, no transaction. Exits 0 for EVERY real
// answer — the ANSWER is the output; only an unreachable DB / query error exits
// non-zero. Manual trigger only (so-si-deposit-link-check.yml).
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

// `notice` surfaces each line on the workflow run's summary page.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const SO = (process.env.SO_DOC || "HC-SO-013057").trim();
const DO = (process.env.DO_NUM || "HC-DO-2609-012").trim();

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  await pg`SET search_path = scm, public`;

  // 1. The ORDER, exactly as readOrderDeposit reads it (by doc_no).
  const so = await pg`
    SELECT doc_no, company_id, deposit_sen, total_revenue_sen
    FROM mfg_sales_orders WHERE doc_no = ${SO}`;
  let soCompany = null;
  if (so.length === 0) {
    notice(`ORDER ${SO}: NOT FOUND by doc_no — the invoice's so_doc_no cannot resolve to it.`);
  } else {
    soCompany = so[0].company_id;
    notice(`ORDER ${SO}: company_id=${so[0].company_id}, deposit_sen=${so[0].deposit_sen}, total_revenue_sen=${so[0].total_revenue_sen}`);
    const pay = await pg`
      SELECT count(*)::int n, coalesce(sum(amount_sen),0)::bigint sum_sen,
             coalesce(bool_or(is_deposit),false) any_is_deposit
      FROM mfg_sales_order_payments WHERE so_doc_no = ${SO}`;
    notice(`ORDER payments (so_doc_no=${SO}): rows=${pay[0].n}, sum_sen=${pay[0].sum_sen}, any_is_deposit=${pay[0].any_is_deposit}`);
  }

  // 2. The DELIVERY ORDER — the so_doc_no the invoice inherits on convert.
  const doo = await pg`
    SELECT id, do_number, so_doc_no, company_id
    FROM delivery_orders WHERE do_number = ${DO}`;
  const doId = doo.length ? doo[0].id : null;
  if (doo.length === 0) notice(`DO ${DO}: NOT FOUND by do_number.`);
  else notice(`DO ${DO}: so_doc_no='${doo[0].so_doc_no}', company_id=${doo[0].company_id} (invoice inherits this so_doc_no)`);

  // 3. EVERY invoice carrying that so_doc_no, or linked by delivery_order_id.
  const sis = await pg`
    SELECT invoice_number, so_doc_no, company_id, total_sen, paid_sen, status, invoice_date
    FROM sales_invoices
    WHERE so_doc_no = ${SO} OR delivery_order_id = ${doId}
    ORDER BY invoice_date NULLS LAST, invoice_number`;
  notice(`INVOICES linked to ${SO} / ${DO}: ${sis.length}`);
  for (const s of sis) {
    const soMatch = s.so_doc_no === SO ? "so_doc_no=OK" : `so_doc_no=MISMATCH('${s.so_doc_no}')`;
    const coMatch = soCompany != null && s.company_id !== soCompany ? " company=MISMATCH" : "";
    notice(`  ${s.invoice_number}: ${soMatch}${coMatch}, company=${s.company_id}, total_sen=${s.total_sen}, paid_sen=${s.paid_sen}, status=${s.status}`);
  }

  notice("VERDICT HINTS — (1) ORDER not found or so_doc_no=MISMATCH: the read-through never resolves the order. (2) a NON-CANCELLED sibling with high paid_sen: it absorbed the deposit (allocation is earliest invoice first). (3) company=MISMATCH: readOrderDeposit's company filter drops the order.");
} finally {
  await pg.end({ timeout: 5 });
}
