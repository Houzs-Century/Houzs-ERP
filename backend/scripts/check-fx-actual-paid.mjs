// READ-ONLY. The foreign-rate-1 detector (R2) found one RMB GRN/PI booked at rate 1.
// The owner's point: cost should be what we ACTUALLY PAID, not a rate field. The
// system already models that — payment_vouchers.exchange_rate is the cash-out rate
// (fx.ts header). So for every foreign doc at rate 1, this reports the three numbers
// that decide the true basis: the currency MASTER's rate, the PI's paid_sen, and
// any payment voucher's own rate/amount. One SELECT per question, no writes.
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });
const notice = (m) => console.log(`::notice::${m}`);
const rm = (sen) => `RM ${(Number(sen || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function tableCols(schema, table) {
  const r = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${table}`;
  return new Set(r.map((x) => x.column_name));
}
async function findTable(name) {
  const r = await sql`SELECT table_schema FROM information_schema.tables WHERE table_name=${name} ORDER BY (table_schema='scm') DESC LIMIT 1`;
  return r[0]?.table_schema ?? null;
}

async function main() {
  notice("=== FX ACTUAL-PAID BASIS (R2 follow-up) — READ-ONLY ===");

  // 1) the currency master
  const curSchema = await findTable("currencies");
  if (!curSchema) notice("  currencies master: TABLE NOT FOUND");
  else {
    const rows = await sql`SELECT * FROM ${sql(curSchema)}.currencies ORDER BY 1`;
    notice(`================ (1) CURRENCY MASTER (${curSchema}.currencies) ================`);
    for (const r of rows) {
      const code = r.code ?? r.currency ?? r.currency_code ?? "?";
      const rate = r.rate_to_myr ?? r.rate ?? "(no rate column)";
      notice(`    ${String(code).padEnd(6)} rate_to_myr=${rate}`);
    }
    notice("  ^ this is the rate the owner maintains. A NEW currency defaults to 1 until set (audit R2).");
  }

  // 2) the offending PI, its paid amount, and the GRN lot it capitalised
  const piSchema = await findTable("purchase_invoices");
  const grnSchema = await findTable("grns");
  notice(`================ (2) FOREIGN PI AT RATE 1 — invoiced vs PAID (${piSchema}) ================`);
  const piCols = await tableCols(piSchema, "purchase_invoices");
  const has = (c) => piCols.has(c);
  const rateCol = has("exchange_rate") ? "exchange_rate" : null;
  if (!rateCol) notice("  purchase_invoices has no exchange_rate column — cannot classify.");
  else {
    const pis = await sql`
      SELECT invoice_number, currency::text AS currency, exchange_rate,
             total_sen, paid_sen, status, grn_id
        FROM ${sql(piSchema)}.purchase_invoices
       WHERE currency::text <> 'MYR' AND COALESCE(exchange_rate,1) = 1
       ORDER BY total_sen DESC`;
    notice(`  foreign PIs at rate 1: ${pis.length}`);
    for (const p of pis) {
      notice(`    ${p.invoice_number}  ${p.currency}  rate=${p.exchange_rate}  status=${p.status}`);
      notice(`       invoiced total : ${p.total_sen} centi  -> booked as ${rm(p.total_sen)} (rate 1 = no-op)`);
      notice(`       paid_sen     : ${p.paid_sen} centi  -> ${rm(p.paid_sen)}`);
      notice(`       ^ if paid_sen is in the DOC currency it is ${p.currency}, NOT MYR. Read (3) for the cash-out rate.`);
    }
  }

  // 3) payment vouchers — the actual cash out, with their own rate
  const pvSchema = await findTable("payment_vouchers");
  notice("================ (3) PAYMENT VOUCHERS — the actual cash-out ================");
  if (!pvSchema) notice("  payment_vouchers: TABLE NOT FOUND — no cash-out record to compare against.");
  else {
    const pvCols = await tableCols(pvSchema, "payment_vouchers");
    notice(`  ${pvSchema}.payment_vouchers columns of interest: ${[...pvCols].filter((c) => /curr|rate|amount|centi|total|status|voucher|date/i.test(c)).join(", ")}`);
    const rateSel = pvCols.has("exchange_rate") ? sql`exchange_rate` : sql`NULL::numeric AS exchange_rate`;
    const curSel = pvCols.has("currency") ? sql`currency::text AS currency` : sql`NULL::text AS currency`;
    const pvs = await sql`
      SELECT *, ${curSel}, ${rateSel} FROM ${sql(pvSchema)}.payment_vouchers
       WHERE ${pvCols.has("currency") ? sql`currency::text <> 'MYR'` : sql`TRUE`}
       ORDER BY created_at DESC NULLS LAST LIMIT 25`;
    notice(`  non-MYR payment vouchers: ${pvs.length}`);
    for (const v of pvs) {
      const amt = v.amount_sen ?? v.total_sen ?? v.amount ?? "?";
      notice(`    ${v.voucher_number ?? v.id}  ${v.currency}  rate=${v.exchange_rate}  amount=${amt}  status=${v.status ?? "-"}`);
    }
    if (!pvs.length) notice("  ^ NONE. So the system holds no record of what was actually paid in MYR for the RMB invoice — the true basis is outside the system (bank slip).");
  }
  notice("=== END — read-only, no rows changed. ===");
}
main().then(() => sql.end()).catch((e) => { console.error("FX_ACTUAL_PAID_FAIL", e?.message ?? e); process.exit(1); });
