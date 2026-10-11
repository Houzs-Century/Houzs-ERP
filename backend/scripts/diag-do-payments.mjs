#!/usr/bin/env node
// Read-only forensics on the 13 SOURCE `public.delivery_order_payments` rows that
// the 2990 -> Houzs migration did NOT carry across (diag-migration-completeness.mjs
// found source=13, dest(company_2)=0). Owner ask (2026-07-24): "our payments are
// all recorded on the Sales Order — why are there DO-level payments, and why
// weren't they migrated? Understand what these 13 are BEFORE any backfill (it's
// money data)."
//
// ROOT CAUSE of the non-migration (traced, not guessed — see migrate-2990-into-
// houzs.mjs): the importer's generic guard `if (!dcols.includes("company_id"))`
// (line ~71) SKIPS any DEST table that has no company_id column. Houzs
// `scm.delivery_order_payments` is scoped through its parent DO
// (delivery_order_id -> delivery_orders.company_id), so the payment ROW carries
// no company_id of its own (PAYMENT_COLS in delivery-orders-mfg.ts:340-343). The
// table sits in the importer ORDER and even has a DANGLING_GUARD entry, but the
// company_id check fires first and prints "SKIP delivery_order_payments: no
// company_id" — so the guard is never reached and all 13 rows are dropped. This
// script CONFIRMS that at runtime (does dest carry company_id? how many DO
// payments are attached to company_2 DOs?) and then classifies each of the 13.
//
// THE QUESTION THAT DECIDES THE HANDLING (money): is each DO payment a DUPLICATE
// of a payment already recorded on the SO (so migrating it would double-count),
// or ADDITIONAL money — a balance / COD collected at delivery that Houzs has no
// record of anywhere (so SKIPPING it understates that SO's paid amount)? We answer
// it by putting each DO payment next to (a) what Houzs CURRENTLY records on that
// SO (dest scm.mfg_sales_order_payments for '2990-'+so_doc_no) and (b) what 2990
// recorded on that SO (source mfg_sales_order_payments), matched on amount+date.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no backfill.
// Every interpolated identifier is re-validated against ^[a-z_][a-z0-9_]*$ and the
// company_id is one we resolve ourselves; no user input reaches any statement.
// Exits 0 for every legitimate answer (the ANSWER is the output, not the exit
// code); non-zero only when a database is unreachable.
//
//   SOURCE = 2990 upstream Supabase (public schema) via SOURCE_SUPABASE_URL +
//            SOURCE_SERVICE_ROLE_KEY, @supabase/supabase-js — same as the importer.
//   DEST   = Houzs Postgres via DATABASE_URL, postgres.js. Dest tables live in a
//            MIX of schemas; each is DISCOVERED across scm+public at runtime.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const DST = process.env.DATABASE_URL;
if (!DST) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}
const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const src =
  SUPA_URL && SUPA_KEY
    ? createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })
    : null;

const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const pad = (s, n) => String(s).padEnd(n);
const rm = (centi) => (centi == null ? "-" : `RM${(Number(centi) / 100).toFixed(2)}`);
const dateOnly = (v) => (v == null ? null : String(v).slice(0, 10));
const norm = (v) => (v == null ? null : String(v).replace(/^2990-/, ""));
const prefixed = (v) => (v == null ? null : String(v).startsWith("2990-") ? String(v) : `2990-${v}`);

// ── DEST helpers (discover, never assume) ───────────────────────────────────
async function destLocations(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table}
       AND table_schema IN ('scm','public')
       AND table_type = 'BASE TABLE'
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r.map((x) => x.table_schema);
}
async function destSchemaOf(table) {
  const loc = await destLocations(table);
  return loc[0] ?? null;
}
async function destCols(schema, table) {
  const r = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}
     ORDER BY ordinal_position`;
  return r.map((x) => x.column_name);
}
// Chunked `col IN (...)` with positional params — no ANY()/array binding, so a
// uuid column and a text[] of ids never trip a type-cast error. selectSql is
// built only from idents this file validates; values are bound, never inlined.
async function pgSelectIn(schema, table, selectSql, whereCol, values, extraWhere = "") {
  ident(schema); ident(table); ident(whereCol);
  const out = [];
  const uniq = [...new Set(values.filter((v) => v != null).map(String))];
  for (const chunk of chunks(uniq, 100)) {
    const ph = chunk.map((_, i) => `$${i + 1}`).join(",");
    const q = `SELECT ${selectSql} FROM "${schema}"."${table}" WHERE ${extraWhere ? extraWhere + " AND " : ""}"${whereCol}" IN (${ph})`;
    out.push(...(await pg.unsafe(q, chunk)));
  }
  return out;
}

// ── SOURCE helpers (Supabase REST) ──────────────────────────────────────────
async function srcColumns(table) {
  if (!src) return null;
  const { data, error } = await src.schema("public").from(table).select("*").limit(1);
  if (error || !data || !data.length) return null;
  return Object.keys(data[0]);
}
async function srcFetchAll(table) {
  const out = [];
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src.schema("public").from(table).select("*").range(f, f + P - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < P) break;
  }
  return out;
}
async function srcSelectIn(table, cols, col, values) {
  if (!values.length) return [];
  const out = [];
  const P = 150;
  const uniq = [...new Set(values.filter((v) => v != null).map(String))];
  for (let i = 0; i < uniq.length; i += P) {
    const { data, error } = await src
      .schema("public")
      .from(table)
      .select(cols.join(","))
      .in(col, uniq.slice(i, i + P));
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}

// Pick the sen (integer-cents) amount column from a discovered column list.
const pickAmountCol = (cols) =>
  cols.find((c) => c === "amount_centi") ||
  cols.find((c) => /amount.*cent|cent.*amount/i.test(c)) ||
  cols.find((c) => /^amount$|_amount$/i.test(c)) ||
  cols.find((c) => /amount/i.test(c)) ||
  null;
const pickDateCol = (cols) =>
  cols.find((c) => c === "paid_at") ||
  cols.find((c) => /paid_at|payment_date|paid_on|date/i.test(c)) ||
  null;
const pickTotalCol = (cols) =>
  cols.find((c) => c === "grand_total_centi") ||
  cols.find((c) => c === "net_total_centi") ||
  cols.find((c) => c === "local_total_centi") ||
  cols.find((c) => c === "total_centi") ||
  cols.find((c) => /(grand|net|final|local)?_?total.*cent/i.test(c)) ||
  null;

async function main() {
  const cidRow = await pg`SELECT id FROM companies WHERE code = '2990'`;
  if (!cidRow.length) {
    notice("FATAL — no company with code='2990'. Cannot scope dest counts.");
    await pg.end({ timeout: 5 });
    return;
  }
  const cid = Number(cidRow[0].id);
  notice(`2990 company_id = ${cid}   mode = READ-ONLY   source probe = ${src ? "ON" : "OFF (set SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY)"}`);
  if (!src) {
    notice("Source probe OFF — the 13 rows live only on the 2990 source. Nothing to classify. Aborting cleanly.");
    await pg.end({ timeout: 5 });
    return;
  }
  notice("");

  // ===================================================================
  // ROOT-CAUSE CONFIRMATION (runtime)
  // ===================================================================
  notice("================ ROOT CAUSE (why the importer skipped delivery_order_payments) ================");
  const dopSchema = await destSchemaOf("delivery_order_payments");
  const doSchema = await destSchemaOf("delivery_orders");
  const soPaySchema = await destSchemaOf("mfg_sales_order_payments");
  const soSchema = await destSchemaOf("mfg_sales_orders");
  if (!dopSchema) {
    notice("  dest has NO delivery_order_payments table at all.");
  } else {
    const dcols = await destCols(dopSchema, "delivery_order_payments");
    const hasCid = dcols.includes("company_id");
    notice(`  dest ${dopSchema}.delivery_order_payments columns: ${dcols.join(", ")}`);
    notice(`  has company_id column? ${hasCid ? "YES" : "NO"}  <-- importer line ~71 skips any dest table with NO company_id`);
    // How many DO payments are attached to company_2 DOs today (should be 0).
    if (doSchema) {
      const [r] = await pg.unsafe(
        `SELECT count(*)::int AS n
           FROM "${ident(dopSchema)}"."delivery_order_payments" p
           JOIN "${ident(doSchema)}"."delivery_orders" d ON d.id = p.delivery_order_id
          WHERE d.company_id = ${cid}`,
      );
      notice(`  DO payments currently attached to company_2 DOs (via parent join): ${r.n}`);
    }
    const [tot] = await pg.unsafe(`SELECT count(*)::int AS n FROM "${ident(dopSchema)}"."delivery_order_payments"`);
    notice(`  total rows in dest ${dopSchema}.delivery_order_payments (ALL companies): ${tot.n}`);
  }
  notice("");

  // ===================================================================
  // SECTION 1 — dump the 13 source delivery_order_payments with DO + SO context
  // ===================================================================
  notice("================ SECTION 1: the source delivery_order_payments rows ================");
  const dopCols = await srcColumns("delivery_order_payments");
  if (!dopCols) {
    notice("  source delivery_order_payments is empty or unreadable — nothing to classify.");
    await pg.end({ timeout: 5 });
    return;
  }
  notice(`  source columns: ${dopCols.join(", ")}`);
  const dopAmt = pickAmountCol(dopCols);
  const dopDate = pickDateCol(dopCols);
  const dopFk = dopCols.includes("delivery_order_id") ? "delivery_order_id" : dopCols.find((c) => /delivery_order/i.test(c) && /id/i.test(c));
  notice(`  amount col = ${dopAmt ?? "(none!)"}   date col = ${dopDate ?? "(none)"}   DO fk = ${dopFk ?? "(none!)"}`);
  const dop = await srcFetchAll("delivery_order_payments");
  notice(`  source row count = ${dop.length}`);

  // Parent source DOs -> do_number + so_doc_no
  const doIds = [...new Set(dop.map((r) => dopFk && r[dopFk]).filter(Boolean).map(String))];
  const srcDoCols = (await srcColumns("delivery_orders")) ?? [];
  const doSel = ["id", "do_number", "so_doc_no", "status", "debtor_name"].filter((c) => srcDoCols.includes(c));
  const srcDOs = await srcSelectIn("delivery_orders", doSel.length ? doSel : ["id"], "id", doIds);
  const doById = new Map(srcDOs.map((d) => [String(d.id), d]));

  // Which of those DOs actually landed in Houzs company_2? (dest DO id == source id, verbatim.)
  const destDoPresent = new Set();
  if (doSchema && doIds.length) {
    const rows = await pgSelectIn(doSchema, "delivery_orders", "id::text AS id", "id", doIds, `company_id = ${cid}`);
    for (const r of rows) destDoPresent.add(String(r.id));
  }

  notice("");
  notice(`  ${pad("#", 3)} ${pad("DO number", 16)} ${pad("SO number", 16)} ${pad("amount", 12)} ${pad("method", 12)} ${pad("date", 12)} parentDO@Houzs`);
  const enriched = dop.map((r, i) => {
    const d = dopFk ? doById.get(String(r[dopFk])) : null;
    const doNo = d?.do_number ?? "(DO missing)";
    const soNo = d?.so_doc_no ?? "(no SO link)";
    const amt = dopAmt ? r[dopAmt] : null;
    const method = r.method ?? r.type ?? r.payment_method ?? "(none)";
    const date = dopDate ? dateOnly(r[dopDate]) : "(none)";
    const present = dopFk && destDoPresent.has(String(r[dopFk]));
    notice(`  ${pad(i + 1, 3)} ${pad(doNo, 16)} ${pad(soNo, 16)} ${pad(rm(amt), 12)} ${pad(method, 12)} ${pad(date ?? "-", 12)} ${present ? "PRESENT" : "MISSING"}`);
    return { r, i, doNo, soNo: soNo, soDocNo: d?.so_doc_no ?? null, amt: amt == null ? null : Number(amt), method, date, doPresent: !!present };
  });
  // Extra columns worth showing if present
  const extra = ["note", "account_sheet", "online_type", "merchant_provider", "collected_by", "is_deposit", "created_at"].filter((c) => dopCols.includes(c));
  if (extra.length) {
    notice("");
    notice(`  extra columns present on source rows: ${extra.join(", ")}`);
    enriched.forEach(({ r, i }) => {
      const bits = extra.map((c) => `${c}=${r[c] ?? ""}`).join("  ");
      notice(`    #${i + 1}: ${bits}`);
    });
  }
  notice("");

  // ===================================================================
  // SECTION 2 — duplicate vs additional, per row
  // ===================================================================
  notice("================ SECTION 2: DUPLICATE (already on SO) vs ADDITIONAL (new money) ================");
  const soDocNos = [...new Set(enriched.map((e) => e.soDocNo).filter(Boolean).map(String))];

  // Source SO payments for those SOs
  const srcSoPayCols = (await srcColumns("mfg_sales_order_payments")) ?? [];
  const srcSoAmt = pickAmountCol(srcSoPayCols);
  const srcSoDate = pickDateCol(srcSoPayCols);
  const srcSoPayRows = srcSoPayCols.length
    ? await srcSelectIn("mfg_sales_order_payments", [...new Set(["so_doc_no", srcSoAmt, srcSoDate, "method", "is_deposit"].filter(Boolean))], "so_doc_no", soDocNos)
    : [];
  const srcSoPayBySo = groupBy(srcSoPayRows, (r) => String(r.so_doc_no));

  // Source SO headers -> order value
  const srcSoCols = (await srcColumns("mfg_sales_orders")) ?? [];
  const srcSoTotal = pickTotalCol(srcSoCols);
  const soKeyCol = srcSoCols.includes("doc_no") ? "doc_no" : srcSoCols.find((c) => /doc_no|^id$/i.test(c));
  const srcSoRows = srcSoCols.length && soKeyCol
    ? await srcSelectIn("mfg_sales_orders", [...new Set([soKeyCol, srcSoTotal].filter(Boolean))], soKeyCol, soDocNos)
    : [];
  const srcSoByNo = new Map(srcSoRows.map((s) => [String(s[soKeyCol]), s]));

  // Dest Houzs SO payments for those SOs (so_doc_no is stored '2990-'+n, company scoped)
  let destSoPayBySo = new Map();
  let destSoPayAmt = "amount_centi";
  if (soPaySchema && soDocNos.length) {
    const spCols = await destCols(soPaySchema, "mfg_sales_order_payments");
    destSoPayAmt = pickAmountCol(spCols) ?? "amount_centi";
    const spDate = pickDateCol(spCols) ?? "paid_at";
    const spHasCid = spCols.includes("company_id");
    ident(destSoPayAmt); ident(spDate);
    const selectSql =
      `so_doc_no, "${destSoPayAmt}"::bigint AS amt, "${spDate}"::text AS dt, ` +
      `${spCols.includes("method") ? "method" : "NULL AS method"}, ` +
      `${spCols.includes("is_deposit") ? "is_deposit" : "NULL AS is_deposit"}`;
    const rows = await pgSelectIn(
      soPaySchema, "mfg_sales_order_payments", selectSql, "so_doc_no",
      soDocNos.map(prefixed), spHasCid ? `company_id = ${cid}` : "",
    );
    destSoPayBySo = groupBy(rows, (r) => norm(r.so_doc_no));
  }

  let dupCenti = 0, addCenti = 0, unknownCenti = 0, missingDoCenti = 0;
  const verdicts = [];
  for (const e of enriched) {
    notice(`---- #${e.i + 1}  DO ${e.doNo}  ->  SO ${e.soNo}   payment ${rm(e.amt)} (${e.method}) on ${e.date} ----`);
    if (!e.soDocNo) {
      notice("     DO has no so_doc_no link — cannot compare to any SO ledger. Treat as UNKNOWN (manual review).");
      verdicts.push({ ...e, verdict: "UNKNOWN (no SO link)" });
      unknownCenti += e.amt ?? 0;
      continue;
    }
    const destLedger = destSoPayBySo.get(String(e.soDocNo)) ?? [];
    const srcLedger = srcSoPayBySo.get(String(e.soDocNo)) ?? [];
    const so = srcSoByNo.get(String(e.soDocNo));
    const orderVal = so && srcSoTotal ? Number(so[srcSoTotal]) : null;
    const destPaid = destLedger.reduce((a, b) => a + Number(b.amt ?? 0), 0);
    const srcPaid = srcLedger.reduce((a, b) => a + Number(srcSoAmt ? b[srcSoAmt] ?? 0 : 0), 0);

    // Show both ledgers
    notice(`     Houzs SO ledger (dest, company_2, so='2990-${e.soDocNo}'): ${destLedger.length} payment(s), sum ${rm(destPaid)}`);
    for (const p of destLedger) notice(`        ${rm(p.amt)}  ${dateOnly(p.dt)}  ${p.method ?? ""}${p.is_deposit ? "  [deposit]" : ""}`);
    notice(`     2990 SO ledger (source): ${srcLedger.length} payment(s), sum ${rm(srcPaid)}`);
    for (const p of srcLedger) notice(`        ${rm(srcSoAmt ? p[srcSoAmt] : null)}  ${dateOnly(srcSoDate ? p[srcSoDate] : null)}  ${p.method ?? ""}${p.is_deposit ? "  [deposit]" : ""}`);
    if (orderVal != null) notice(`     2990 SO order value (${srcSoTotal}) = ${rm(orderVal)}   -> Houzs-recorded balance = ${rm(orderVal - destPaid)}`);

    // Match the DO payment against the HOUZS SO ledger (what Houzs already has).
    const exact = destLedger.find((p) => Number(p.amt) === e.amt && dateOnly(p.dt) === e.date);
    const amtOnly = destLedger.find((p) => Number(p.amt) === e.amt);
    // And against the 2990 SO ledger (was it double-booked on both docs in 2990?).
    const srcExact = srcLedger.find((p) => Number(srcSoAmt ? p[srcSoAmt] : NaN) === e.amt && dateOnly(srcSoDate ? p[srcSoDate] : null) === e.date);

    let verdict;
    if (!e.doPresent) {
      // Parent DO isn't in Houzs — even a backfill has no row to attach to.
      verdict = "ORPHAN (parent DO not migrated)";
      missingDoCenti += e.amt ?? 0;
      notice(`     >>> ${verdict}: parent DO ${e.doNo} is NOT in Houzs company_2, so this payment cannot attach to a DO. Needs the DO first (or fold onto SO).`);
    } else if (exact) {
      verdict = "DUPLICATE (exact amount+date already on Houzs SO ledger)";
      dupCenti += e.amt ?? 0;
      notice(`     >>> ${verdict} — migrating it would DOUBLE-COUNT. Safe to SKIP.`);
    } else if (amtOnly && srcExact) {
      verdict = "LIKELY DUPLICATE (amount on SO ledger; also on both docs in 2990)";
      dupCenti += e.amt ?? 0;
      notice(`     >>> ${verdict} — same money booked on SO + DO in 2990. Likely SKIP; eyeball dates.`);
    } else {
      verdict = "ADDITIONAL (not on Houzs SO ledger — money Houzs has no record of)";
      addCenti += e.amt ?? 0;
      notice(`     >>> ${verdict} — SKIPPING understates SO ${e.soNo}'s paid amount by ${rm(e.amt)}.`);
    }
    verdicts.push({ ...e, verdict });
    notice("");
  }

  // ===================================================================
  // SECTION 3 — how Houzs models delivery-time payments
  // ===================================================================
  notice("================ SECTION 3: how Houzs models delivery-time payments ================");
  notice("  Houzs HAS a first-class DO payment ledger, separate from the SO ledger:");
  notice("   - table  scm.delivery_order_payments (keyed by delivery_order_id; NO company_id — scoped via parent DO)");
  notice("   - routes GET/POST/DELETE /api/scm/delivery-orders-mfg/:id/payments (delivery-orders-mfg.ts:4077/4120/4157)");
  notice("   - UI     DO Detail payments panel + MobilePOD (driver collects balance/COD at delivery)");
  notice("  So delivery-time payments are NOT folded into the SO in Houzs; the target table + API already exist.");
  notice("  => a backfill target EXISTS. The only reason the 13 didn't migrate is the company_id skip above.");
  notice("");

  // ===================================================================
  // SECTION 4 — totals + recommendation inputs
  // ===================================================================
  notice("================ SECTION 4: totals + recommendation ================");
  const grand = enriched.reduce((a, b) => a + (b.amt ?? 0), 0);
  notice(`  rows: ${enriched.length}   total money at stake: ${rm(grand)} (${grand} sen)`);
  notice(`  DUPLICATE (skip-safe)                : ${rm(dupCenti)}`);
  notice(`  ADDITIONAL (skipping understates SO) : ${rm(addCenti)}`);
  notice(`  ORPHAN (parent DO not in Houzs)      : ${rm(missingDoCenti)}`);
  notice(`  UNKNOWN (no SO link)                 : ${rm(unknownCenti)}`);
  const parentsPresent = enriched.filter((e) => e.doPresent).length;
  notice(`  parent DOs present in Houzs company_2: ${parentsPresent}/${enriched.length} (backfill-attachable)`);
  notice("");
  notice("  Verdict table:");
  for (const v of verdicts) notice(`    #${v.i + 1}  ${pad(v.doNo, 16)} ${pad(v.soNo, 16)} ${pad(rm(v.amt), 11)} ${v.verdict}`);
  notice("");
  notice("  RECOMMENDATION INPUTS (owner decides):");
  notice(`   - If ADDITIONAL total (${rm(addCenti)}) > 0: those SOs are UNDER-recorded in Houzs today; a backfill of ONLY the additional rows into scm.delivery_order_payments (parent DO present) restores them without double-counting.`);
  notice(`   - DUPLICATE rows (${rm(dupCenti)}) should be SKIPPED — the money is already on the Houzs SO ledger.`);
  notice(`   - ORPHAN rows (${rm(missingDoCenti)}) can't attach (no parent DO in Houzs) — migrate the DO first, or fold onto the SO, per owner.`);
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
function* chunks(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("DIAG_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
