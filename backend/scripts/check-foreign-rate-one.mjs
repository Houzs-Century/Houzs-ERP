#!/usr/bin/env node
// Read-only detector for FOREIGN-CURRENCY DOCUMENT BOOKED AT RATE 1 (audit R2).
//
// WHY THIS EXISTS (inventory-costing-integrity audit 2026-07-25, risk R2).
// safeRate degrades a missing / non-positive / non-finite exchange rate to 1
// (backend/src/scm/lib/fx.ts:47-50), and a brand-new currency's
// currencies.rate_to_myr "defaults a new currency to 1 until the owner sets a real
// rate" (fx.ts:62-84). toMyrSen(x, 1) === x (fx.ts:57-59), so a GRN / PI in, say,
// RMB posted BEFORE the owner enters the RMB rate folds the raw foreign figure
// into the FIFO lot as if it were ringgit — a silent mis-cost. The FX guard is
// explicitly against ZEROING the money, not against a wrong-by-the-FX-factor cost,
// and recostFromGrn re-reads the GRN's OWN stored exchange_rate (recost.ts:248),
// so a rate-1 GRN re-applies 1 on every recost — the error is STICKY.
//
// This SIZES that exposure. Two source documents carry (currency, exchange_rate):
//   * grns              — currency + exchange_rate (grns.ts; fx.ts). The GRN IN
//     opens the FIFO lot, so grn.id joins inventory_lots on
//     (source_doc_type='GRN', source_doc_id = grn.id) to value the lots at risk.
//   * purchase_invoices — currency + exchange_rate + grn_id. A PI does NOT open a
//     lot; it RECOSTS the linked GRN's lots at its own rate. So a rate-1 foreign
//     PI is sized against the lots of its grn_id (the lots recostForPi would fold
//     the raw foreign figure into).
// Offending pair = currency <> MYR (trimmed/upper, blank treated as MYR) AND
// COALESCE(exchange_rate, 1) = 1 (a NULL rate is equally the "already-MYR"
// fold). MYR docs are rate 1 by design and are NOT flagged.
//
// STRICTLY READ-ONLY. SELECT only — no DDL, no writes, no transaction, no marker
// rows, NO change to any FX / costing logic. Every interpolated identifier is a
// schema/column name DISCOVERED from information_schema and re-validated against
// ^[a-z_][a-z0-9_]*$; no user input reaches any statement. Exits 0 for every
// legitimate answer (the ANSWER is the output, not the exit code); non-zero only
// when the database is unreachable or a query errors.
//
// Mirrors backend/scripts/check-costless-stock.mjs + check-uncosted-cogs.mjs (the
// repo's read-only-diagnostic shape) and its workflow
// .github/workflows/foreign-rate-one-check.yml.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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

const notice = (m) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const SAFE = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!SAFE.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (s, n) => String(s).padEnd(n);
const rm = (sen) => (sen == null ? "-" : `RM${(Number(sen) / 100).toFixed(2)}`);
const short = (s, n) => {
  const v = s == null ? "-" : String(s);
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};
const SAMPLE = 25;

async function schemaOf(table) {
  ident(table);
  const r = await pg`
    SELECT table_schema FROM information_schema.tables
     WHERE table_name = ${table}
       AND table_schema IN ('scm','public')
       AND table_type = 'BASE TABLE'
     ORDER BY CASE table_schema WHEN 'scm' THEN 0 ELSE 1 END`;
  return r[0]?.table_schema ?? null;
}
async function colsOf(schema, table) {
  const r = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}`;
  return new Set(r.map((x) => x.column_name));
}
const pickCol = (cols, candidates) => candidates.find((c) => cols.has(c)) ?? null;

// MYR is the base; blank / null currency normalises to MYR (fx.normalizeCurrency),
// so only a genuinely-foreign code with an effective rate of 1 is an offender.
// The currency column is NOT text in prod — it is a domain/enum, so btrim() has no
// candidate signature for it and the whole check died with
// "function pg_catalog.btrim(scm.currency_code) does not exist". Cast to text first;
// ::text is valid for text, varchar, a domain over either, and an enum alike.
const foreignRateOne = (currCol, rateCol) =>
  `${currCol} IS NOT NULL
     AND UPPER(TRIM(${currCol}::text)) <> 'MYR'
     AND UPPER(TRIM(${currCol}::text)) <> ''
     AND COALESCE(${rateCol}, 1) = 1`;

async function main() {
  notice("=== FOREIGN-CURRENCY DOC AT RATE 1 DETECTOR (R2) — READ-ONLY (no rows changed, no FX/costing logic touched) ===");
  notice("");

  const lotSchema = await schemaOf("inventory_lots");
  if (!lotSchema) {
    notice("FATAL — inventory_lots not found in scm or public. Cannot value lots at risk. (Missing-table condition, not a data answer.)");
    return;
  }
  const lotCols = await colsOf(lotSchema, "inventory_lots");
  for (const need of ["source_doc_type", "source_doc_id", "qty_received", "qty_remaining", "unit_cost_sen"]) {
    if (!lotCols.has(need)) {
      notice(`FATAL — inventory_lots has no ${need} column in ${lotSchema}. Cannot run. (Schema mismatch, not a data answer.)`);
      return;
    }
  }
  const L = `"${ident(lotSchema)}"."inventory_lots"`;
  notice(`schema: inventory_lots=${lotSchema}`);
  notice("");

  // Shared lot-value CTE per GRN source doc: total received value (the raw figure
  // capitalised) and current open value (still on the books). Both in sen.
  const lotAggFor = () => `
    SELECT source_doc_id::text AS grn_id,
           SUM(qty_received * unit_cost_sen)  AS recv_value_sen,
           SUM(qty_remaining * unit_cost_sen) AS open_value_sen,
           SUM(qty_received)                  AS recv_qty,
           SUM(qty_remaining)                 AS open_qty,
           COUNT(*)                           AS lot_count
      FROM ${L}
     WHERE source_doc_type = 'GRN'
       AND source_doc_id IS NOT NULL
     GROUP BY source_doc_id::text`;

  const results = { grn: null, pi: null };

  // ---------------- (1) GRNs at rate 1 ----------------
  notice("================ (1) GRN — foreign currency booked at rate 1 ================");
  const grnSchema = await schemaOf("grns");
  if (!grnSchema) {
    notice("  SKIP — grns table not found in scm or public.");
    notice("");
  } else {
    const gCols = await colsOf(grnSchema, "grns");
    const gCurr = pickCol(gCols, ["currency"]);
    const gRate = pickCol(gCols, ["exchange_rate", "exchangerate", "fx_rate"]);
    const gNo = pickCol(gCols, ["grn_number", "grn_no", "doc_no"]);
    const gHasCompany = gCols.has("company_id");
    if (!gCurr || !gRate) {
      notice(`  SKIP — grns has no currency/exchange_rate pair (currency=${gCurr ?? "MISSING"}, rate=${gRate ?? "MISSING"}) in ${grnSchema}.`);
      notice("");
    } else {
      const G = `"${ident(grnSchema)}"."grns"`;
      const noSel = gNo ? `g."${ident(gNo)}"::text` : "g.id::text";
      const coSel = gHasCompany ? "g.company_id" : "NULL::int AS company_id";
      const rows = await pg.unsafe(`
        WITH lot AS (${lotAggFor()})
        SELECT g.id::text                       AS doc_id,
               ${noSel}                          AS doc_no,
               UPPER(TRIM(g."${ident(gCurr)}"::text))  AS currency,
               g."${ident(gRate)}"               AS exchange_rate,
               ${coSel},
               COALESCE(l.recv_value_sen, 0)     AS recv_value_sen,
               COALESCE(l.open_value_sen, 0)     AS open_value_sen,
               COALESCE(l.recv_qty, 0)           AS recv_qty,
               COALESCE(l.open_qty, 0)           AS open_qty,
               COALESCE(l.lot_count, 0)          AS lot_count
          FROM ${G} g
          LEFT JOIN lot l ON l.grn_id = g.id::text
         WHERE ${foreignRateOne(`g."${ident(gCurr)}"`, `g."${ident(gRate)}"`)}
         ORDER BY COALESCE(l.recv_value_sen, 0) DESC, g.id::text`);

      const recv = rows.reduce((a, r) => a + Number(r.recv_value_sen), 0);
      const open = rows.reduce((a, r) => a + Number(r.open_value_sen), 0);
      results.grn = { count: rows.length, recv, open };
      notice(`  discovered: currency=${gCurr}  exchange_rate=${gRate}  doc-no=${gNo ?? "(id)"}  company_id=${gHasCompany ? "YES" : "NO"}`);
      notice(`  offending GRNs (foreign, rate 1)          : ${rows.length}`);
      notice(`  lot value CAPITALISED at the raw figure   : ${rm(recv)}  (${recv} sen)  <- value at risk (received)`);
      notice(`  ... of which STILL OPEN on the books      : ${rm(open)}  (${open} sen)`);
      notice("");
      if (rows.length) {
        notice(`  sample (up to ${SAMPLE}, largest received value first):`);
        notice(`    ${pad("grnNo", 20)} ${pad("cur", 4)} ${pad("rate", 6)} ${pad("co", 3)} ${pad("recvVal", 14)} ${pad("openVal", 14)} ${pad("lots", 5)} recvQty`);
        for (const r of rows.slice(0, SAMPLE)) {
          notice(`    ${pad(short(r.doc_no, 20), 20)} ${pad(short(r.currency, 4), 4)} ${pad(short(r.exchange_rate, 6), 6)} ${pad(r.company_id ?? "-", 3)} ${pad(rm(r.recv_value_sen), 14)} ${pad(rm(r.open_value_sen), 14)} ${pad(r.lot_count, 5)} ${r.recv_qty}`);
        }
        if (rows.length > SAMPLE) notice(`    ... and ${rows.length - SAMPLE} more.`);
      }
      notice("");
    }
  }

  // ---------------- (2) Purchase invoices at rate 1 ----------------
  notice("================ (2) PURCHASE INVOICE — foreign currency booked at rate 1 ================");
  const piSchema = await schemaOf("purchase_invoices");
  if (!piSchema) {
    notice("  SKIP — purchase_invoices table not found in scm or public.");
    notice("");
  } else {
    const pCols = await colsOf(piSchema, "purchase_invoices");
    const pCurr = pickCol(pCols, ["currency"]);
    const pRate = pickCol(pCols, ["exchange_rate", "exchangerate", "fx_rate"]);
    const pNo = pickCol(pCols, ["invoice_number", "pi_number", "doc_no"]);
    const pGrn = pickCol(pCols, ["grn_id"]);
    const pHasCompany = pCols.has("company_id");
    if (!pCurr || !pRate) {
      notice(`  SKIP — purchase_invoices has no currency/exchange_rate pair (currency=${pCurr ?? "MISSING"}, rate=${pRate ?? "MISSING"}) in ${piSchema}.`);
      notice("");
    } else {
      const P = `"${ident(piSchema)}"."purchase_invoices"`;
      const noSel = pNo ? `p."${ident(pNo)}"::text` : "p.id::text";
      const coSel = pHasCompany ? "p.company_id" : "NULL::int AS company_id";
      // A PI has no lot of its own; value it against its linked GRN's lots (the
      // ones recostForPi would fold the raw foreign figure into). If grn_id is
      // absent on this schema, report PIs with no lot valuation (count only).
      const lotJoin = pGrn
        ? `LEFT JOIN (${lotAggFor()}) l ON l.grn_id = p."${ident(pGrn)}"::text`
        : "";
      const valSel = pGrn
        ? "COALESCE(l.recv_value_sen,0) AS recv_value_sen, COALESCE(l.open_value_sen,0) AS open_value_sen, COALESCE(l.recv_qty,0) AS recv_qty, COALESCE(l.lot_count,0) AS lot_count"
        : "0::bigint AS recv_value_sen, 0::bigint AS open_value_sen, 0::bigint AS recv_qty, 0::bigint AS lot_count";
      const rows = await pg.unsafe(`
        SELECT p.id::text                       AS doc_id,
               ${noSel}                          AS doc_no,
               UPPER(TRIM(p."${ident(pCurr)}"::text))  AS currency,
               p."${ident(pRate)}"               AS exchange_rate,
               ${coSel},
               ${pGrn ? `p."${ident(pGrn)}"::text AS grn_id,` : "NULL::text AS grn_id,"}
               ${valSel}
          FROM ${P} p
          ${lotJoin}
         WHERE ${foreignRateOne(`p."${ident(pCurr)}"`, `p."${ident(pRate)}"`)}
         ORDER BY recv_value_sen DESC, p.id::text`);

      const recv = rows.reduce((a, r) => a + Number(r.recv_value_sen), 0);
      const open = rows.reduce((a, r) => a + Number(r.open_value_sen), 0);
      results.pi = { count: rows.length, recv, open, hasLotLink: !!pGrn };
      notice(`  discovered: currency=${pCurr}  exchange_rate=${pRate}  doc-no=${pNo ?? "(id)"}  grn link=${pGrn ?? "(none)"}  company_id=${pHasCompany ? "YES" : "NO"}`);
      notice(`  offending PIs (foreign, rate 1)           : ${rows.length}`);
      if (pGrn) {
        notice(`  linked-GRN lot value CAPITALISED          : ${rm(recv)}  (${recv} sen)  <- value the PI recost would fold`);
        notice(`  ... of which STILL OPEN on the books      : ${rm(open)}  (${open} sen)`);
      } else {
        notice("  (no grn_id column on this schema — count only; the PI's recost target lots cannot be linked here.)");
      }
      notice("");
      if (rows.length) {
        notice(`  sample (up to ${SAMPLE}, largest linked-lot value first):`);
        notice(`    ${pad("piNo", 20)} ${pad("cur", 4)} ${pad("rate", 6)} ${pad("co", 3)} ${pad("linkedVal", 14)} ${pad("openVal", 14)} grnId`);
        for (const r of rows.slice(0, SAMPLE)) {
          notice(`    ${pad(short(r.doc_no, 20), 20)} ${pad(short(r.currency, 4), 4)} ${pad(short(r.exchange_rate, 6), 6)} ${pad(r.company_id ?? "-", 3)} ${pad(rm(r.recv_value_sen), 14)} ${pad(rm(r.open_value_sen), 14)} ${short(r.grn_id, 40)}`);
        }
        if (rows.length > SAMPLE) notice(`    ... and ${rows.length - SAMPLE} more.`);
      }
      notice("");
    }
  }

  notice("================ SUMMARY ================");
  if (results.grn) notice(`  GRN  foreign@rate1 : ${results.grn.count}   received value at risk ${rm(results.grn.recv)}   (open ${rm(results.grn.open)})`);
  if (results.pi) notice(`  PI   foreign@rate1 : ${results.pi.count}   ${results.pi.hasLotLink ? `linked-GRN value ${rm(results.pi.recv)}   (open ${rm(results.pi.open)})` : "(count only — no grn link)"}`);
  notice("");
  notice("  INTERPRETATION (owner decides — this script changes NOTHING):");
  notice("   - A foreign document at rate 1 is almost always an UN-RATED foreign receipt: the raw RMB/USD figure was folded");
  notice("     into the MYR lot 1:1 (toMyrSen(x,1)===x). The cost is wrong by the true FX factor, and recost re-applies the");
  notice("     stored 1, so it is sticky. Confirm each against the currency master's real rate before repricing.");
  notice("   - Root cause + the (owner-gated) write-path guard 'refuse to POST a non-MYR doc whose currency has no positive");
  notice("     master rate' are in docs/inventory-costing-integrity-audit.md (R2). This detector changes no money.");
  notice("");
  notice("=== END — read-only, no rows changed. ===");
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("FOREIGN_RATE_ONE_CHECK_FAIL", e.message);
    try { await pg.end({ timeout: 5 }); } catch {}
    process.exit(1);
  });
