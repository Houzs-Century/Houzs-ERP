// Global DO actual-cost restamp (ledger-perfection W5a, 2026-08-01).
//
// WHY. The W1-W4 ledger repairs (doc-ref ids, the GRN inbound gap, the
// variant-key relabel, the basis-cost seed) correct the MOVEMENT and LOT
// layers. delivery_order_items carries a DERIVED copy of those costs
// (unit_cost_sen / line_cost_sen / line_margin_sen, stamped by
// restampDoActualCost), and sales_invoice_items copies the DO's copy. Owner
// ruling (2026-08-01): after the ledger is right, EVERY shipped DO must read
// consistent — "已经错了的 DO ... 尽量统一掉吧，保持一致".
//
// REUSE, NOT REPLICATION (the recompute-so-allocation.mjs discipline).
// APPLY calls the REAL restampDoActualCost from
// src/scm/routes/delivery-orders-mfg.ts — the exact function every ship /
// line-edit / recost already runs — once per in-scope DO. Optionally
// (INCLUDE_SI=1, default) it then runs the REAL restampSiFromDo
// (src/scm/lib/recost.ts) for every DO whose lines changed and every DO whose
// Sales Invoice disagrees — the same DO -> SI chain reconcileUncostedAfterIn
// runs in production. This script contains NO costing logic of its own.
//
// TRANSPORT (changed 2026-08-01 after the live APPLY died asking for
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — the repo's Actions environment
// carries no PostgREST secrets; only the two 2990 workflows ever referenced
// them and neither has run with them). The canonical functions now talk
// through lib/pgrest-shim.mjs — a supabase-js-SHAPED builder over the SAME
// DATABASE_URL connection, implementing exactly the query surface these
// functions use and THROWING LOUDLY (plus recording on __gaps) on anything
// else, so an unimplemented method can never silently skip a money write. The
// run aborts non-zero if any gap was recorded. The LOGIC stays canonical;
// only the transport is mimicked — replicating the warehouse resolution +
// sofa batch map + variant keys in raw SQL is the "subtly-different sweep"
// this repo's backfills exist to avoid.
//
// The real functions have no dry-run mode, so:
//   DRY-RUN (default): READ-ONLY, DATABASE_URL only. Prints the scope (every
//     shipped non-cancelled DO, both companies) and a per-DO STALENESS
//     INDICATOR: Sigma(line_cost_sen) over non-service lines vs the signed
//     net movement cost booked under the DO (OUT total_cost_sen minus IN).
//     The restamp derives line costs FROM those movements, so a nonzero delta
//     is where APPLY is expected to move numbers (after W1-W4: the named W3
//     DOs and any W4-affected ones). It is an INDICATOR, not the per-line
//     answer — warehouse resolution and the sofa batch map belong to the real
//     function and are deliberately not replicated here. Also read-only: the
//     SI-vs-DO agreement report (sales_invoice_items.do_item_id whose
//     unit_cost_sen differs from its DO line).
//   APPLY (APPLY=1): DATABASE_URL only (see TRANSPORT above). Runs the
//     canonical restamp per DO, reads each DO's lines before/after, and
//     prints every changed line old -> new — the authoritative record of
//     what moved. Idempotent: a second run changes nothing.
//
// Env: DATABASE_URL (always — the only credential).
//      APPLY=1        write. Anything else dry-run.
//      DOS            optional comma-separated do_number list to scope down.
//      ONLY_STALE=1   APPLY only the DOs the indicator flags (plus DOS names).
//                     Default 0 = the full owner-ordered sweep.
//      INCLUDE_SI     1 (default) chain restampSiFromDo; 0 = DO lines only.
//
// Run under tsx (the TS imports): npx tsx scripts/restamp-do-actual-cost.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { DO_STOCK_OUT_STATES } from "./lib/do-shipped-states.mjs";

const APPLY = process.env.APPLY === "1";
const ONLY_STALE = process.env.ONLY_STALE === "1";
const INCLUDE_SI = (process.env.INCLUDE_SI ?? "1") === "1";
const DOS = (process.env.DOS || "").split(",").map((s) => s.trim()).filter(Boolean);

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const rm = (sen) => `RM${(Number(sen ?? 0) / 100).toFixed(2)}`;

function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

// The shipped set the restamp honours, plus COMPLETED, which the audit's 3b
// uses for the same reason: a COMPLETED DO has certainly shipped. That pairing
// now has a NAME — DO_STOCK_OUT_STATES — and one home, instead of being spelled
// out here and in five other scripts as "the other list, plus one". The
// function re-checks status itself, so an over-wide scope can only no-op,
// never mis-stamp.
const SHIPPED = DO_STOCK_OUT_STATES;

async function loadScope() {
  const rows = DOS.length
    ? await pg`
        SELECT id::text AS id, do_number, company_id, status::text AS status
          FROM scm.delivery_orders
         WHERE do_number = ANY(${DOS}) AND UPPER(status::text) <> 'CANCELLED'
         ORDER BY do_number`
    : await pg`
        SELECT id::text AS id, do_number, company_id, status::text AS status
          FROM scm.delivery_orders
         WHERE UPPER(status::text) = ANY(${SHIPPED})
         ORDER BY company_id, do_number`;
  return rows;
}

/* The staleness indicator, one SQL round trip. Line side excludes service
   lines (SVC-* / item_group SERVICE) — they move no stock, keep their
   benchmark cost, and would otherwise flag every DO that carries one. */
async function staleness() {
  return pg`
    WITH line_side AS (
      SELECT di.delivery_order_id AS do_id,
             SUM(COALESCE(di.line_cost_sen, 0))::bigint AS line_cost,
             count(*)::int AS n_lines
        FROM scm.delivery_order_items di
       WHERE NOT (COALESCE(di.item_group, '') = 'SERVICE' OR di.item_code LIKE 'SVC-%')
       GROUP BY di.delivery_order_id
    ), mov_side AS (
      SELECT source_doc_id AS do_id,
             SUM(CASE movement_type WHEN 'OUT' THEN COALESCE(total_cost_sen, 0)
                                    WHEN 'IN' THEN -COALESCE(total_cost_sen, 0)
                                    ELSE 0 END)::bigint AS mov_cost
        FROM scm.inventory_movements
       WHERE source_doc_type = 'DO' AND source_doc_id IS NOT NULL
       GROUP BY source_doc_id
    )
    SELECT d.id::text AS id, d.do_number, d.company_id, d.status::text AS status,
           COALESCE(l.line_cost, 0) AS line_cost,
           COALESCE(m.mov_cost, 0) AS mov_cost,
           COALESCE(l.line_cost, 0) - COALESCE(m.mov_cost, 0) AS delta,
           COALESCE(l.n_lines, 0) AS n_lines,
           EXISTS (SELECT 1 FROM scm.sales_invoices si WHERE si.delivery_order_id = d.id) AS has_si
      FROM scm.delivery_orders d
      LEFT JOIN line_side l ON l.do_id = d.id
      LEFT JOIN mov_side m ON m.do_id = d.id
     WHERE UPPER(d.status::text) = ANY(${SHIPPED})
       AND COALESCE(l.line_cost, 0) <> COALESCE(m.mov_cost, 0)
     ORDER BY ABS(COALESCE(l.line_cost, 0) - COALESCE(m.mov_cost, 0)) DESC, d.do_number`;
}

/* SI lines whose cost disagrees with the DO line they bill (do_item_id link,
   mig 0103) on non-cancelled invoices — the layer restampSiFromDo re-copies.
   The columns postdate the schema dump, so a pre-0103 environment degrades to
   an explicit "unavailable" rather than a crash. */
async function siDisagreement() {
  try {
    return await siDisagreementQuery();
  } catch (e) {
    warn(`SI-vs-DO agreement report unavailable on this database (${e?.message ?? e}) — continuing without it.`);
    return [];
  }
}
async function siDisagreementQuery() {
  return pg`
    SELECT si.invoice_number, si.status::text AS si_status, d.do_number, count(*)::int AS lines,
           SUM(ABS(COALESCE(sii.unit_cost_sen, 0) - COALESCE(di.unit_cost_sen, 0)))::bigint AS unit_cost_gap
      FROM scm.sales_invoice_items sii
      JOIN scm.sales_invoices si ON si.id = sii.sales_invoice_id
      JOIN scm.delivery_order_items di ON di.id = sii.do_item_id
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE sii.do_item_id IS NOT NULL
       AND UPPER(si.status::text) <> 'CANCELLED'
       AND COALESCE(sii.unit_cost_sen, 0) <> COALESCE(di.unit_cost_sen, 0)
     GROUP BY si.invoice_number, si.status, d.do_number
     ORDER BY unit_cost_gap DESC`;
}

async function main() {
  notice(`=== restamp-do-actual-cost  mode=${APPLY ? "APPLY" : "DRY-RUN"}  only_stale=${ONLY_STALE ? "1" : "0"}  include_si=${INCLUDE_SI ? "1" : "0"}${DOS.length ? `  dos=${DOS.join(",")}` : ""} ===`);

  const scope = await loadScope();
  const byCompany = new Map();
  for (const r of scope) byCompany.set(r.company_id, (byCompany.get(r.company_id) ?? 0) + 1);
  notice(`DOs in scope (shipped, non-cancelled${DOS.length ? ", named" : ""}): ${scope.length}  (${[...byCompany.entries()].map(([c, n]) => `company ${c}: ${n}`).join(", ")})`);

  const stale = await staleness();
  const staleInScope = stale.filter((s) => scope.some((d) => d.id === s.id));
  notice("");
  notice("--- STALENESS INDICATOR (read-only; line cost derives from movement cost, so a nonzero delta is where the restamp is expected to move numbers) ---");
  notice(`DOs whose non-service line-cost total differs from their net movement cost: ${staleInScope.length}`);
  for (const s of staleInScope.slice(0, 100)) {
    notice(`  ${s.do_number}  co=${s.company_id} ${s.status}  lines=${rm(s.line_cost)}  movements=${rm(s.mov_cost)}  delta=${rm(s.delta)}  n_lines=${s.n_lines}  SI=${s.has_si ? "yes" : "no"}`);
  }
  if (staleInScope.length > 100) notice(`  ... and ${staleInScope.length - 100} more.`);
  notice("(indicator caveats: drop-ship DOs awaiting receipt legitimately read cost 0 on the movement side;");
  notice(" per-line warehouse resolution and the sofa batch map belong to the canonical function, which APPLY runs.)");

  const disagree = await siDisagreement();
  notice("");
  notice(`--- SI-vs-DO agreement (read-only) --- invoices whose line costs differ from their DO lines: ${disagree.length}`);
  for (const s of disagree.slice(0, 50)) {
    notice(`  ${s.invoice_number} (${s.si_status})  bills ${s.do_number}: ${s.lines} line(s) differ, unit-cost gap ${rm(s.unit_cost_gap)}`);
  }
  if (disagree.length > 50) notice(`  ... and ${disagree.length - 50} more.`);

  if (!APPLY) {
    notice("");
    notice("DRY-RUN — nothing was written. APPLY runs the canonical restampDoActualCost per DO in scope");
    notice(`(${INCLUDE_SI ? "then restampSiFromDo for changed/disagreeing DOs" : "SI restamp disabled"}), printing every changed line old -> new. Set APPLY=1.`);
    await pg.end({ timeout: 5 });
    return;
  }

  // ── APPLY — canonical functions over the pgrest shim (DATABASE_URL only) ───
  const { restampDoActualCost } = await import("../src/scm/routes/delivery-orders-mfg.ts");
  const { restampSiFromDo } = await import("../src/scm/lib/recost.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(pg, "scm");
  const assertNoShimGaps = (context) => {
    if (sb.__gaps.length === 0) return;
    console.error(`SHIM GAP during ${context} — the canonical function called a method the shim does not implement; aborting so a silent skip can never read as success:`);
    for (const g of sb.__gaps) console.error(`  ${g}`);
    process.exit(1);
  };

  const staleIds = new Set(staleInScope.map((s) => s.id));
  const targets = ONLY_STALE ? scope.filter((d) => staleIds.has(d.id) || DOS.includes(d.do_number)) : scope;
  notice("");
  notice(`APPLY — restamping ${targets.length} DO(s) with the canonical restampDoActualCost...`);

  const readLines = async (doId) => {
    const rows = await pg`
      SELECT id::text AS id, item_code, qty, unit_cost_sen, line_cost_sen, line_margin_sen, ship_cost_sen
        FROM scm.delivery_order_items WHERE delivery_order_id = ${doId}::uuid ORDER BY id`;
    return new Map(rows.map((r) => [r.id, r]));
  };

  let changedDos = 0;
  let changedLines = 0;
  const changedDoIds = new Set();
  let i = 0;
  for (const d of targets) {
    i += 1;
    if (i % 50 === 0) notice(`  ... ${i}/${targets.length}`);
    const before = await readLines(d.id);
    await restampDoActualCost(sb, d.id);
    assertNoShimGaps(`restampDoActualCost(${d.do_number})`);
    const after = await readLines(d.id);
    const diffs = [];
    for (const [id, b] of before) {
      const a = after.get(id);
      if (!a) continue;
      if (Number(a.unit_cost_sen ?? 0) !== Number(b.unit_cost_sen ?? 0)
        || Number(a.line_cost_sen ?? 0) !== Number(b.line_cost_sen ?? 0)
        || Number(a.line_margin_sen ?? 0) !== Number(b.line_margin_sen ?? 0)
        || Number(a.ship_cost_sen ?? 0) !== Number(b.ship_cost_sen ?? 0)) {
        diffs.push({ b, a });
      }
    }
    if (diffs.length > 0) {
      changedDos += 1;
      changedLines += diffs.length;
      changedDoIds.add(d.id);
      notice(`  CHANGED ${d.do_number} (company ${d.company_id}, ${d.status}) — ${diffs.length} line(s):`);
      for (const { b, a } of diffs) {
        notice(`    ${b.item_code} qty=${b.qty}: unit ${rm(b.unit_cost_sen)} -> ${rm(a.unit_cost_sen)}, line ${rm(b.line_cost_sen)} -> ${rm(a.line_cost_sen)}, margin ${rm(b.line_margin_sen)} -> ${rm(a.line_margin_sen)}${Number(b.ship_cost_sen ?? 0) !== Number(a.ship_cost_sen ?? 0) ? `, ship-cost freeze ${rm(b.ship_cost_sen)} -> ${rm(a.ship_cost_sen)}` : ""}`);
      }
    }
  }
  notice(`DO restamp done: ${changedDos} DO(s) changed (${changedLines} line(s)); ${targets.length - changedDos} already consistent.`);

  if (INCLUDE_SI) {
    // The canonical DO -> SI chain, for every DO that changed plus every DO an
    // invoice already disagreed with (both idempotent).
    const disagreeDoNumbers = new Set(disagree.map((x) => x.do_number));
    const siTargets = [...new Set([
      ...changedDoIds,
      ...scope.filter((d) => disagreeDoNumbers.has(d.do_number)).map((d) => d.id),
    ])];
    notice("");
    notice(`SI restamp (restampSiFromDo) for ${siTargets.length} DO(s)...`);
    for (const doId of siTargets) {
      await restampSiFromDo(sb, doId);
      assertNoShimGaps(`restampSiFromDo(${doId})`);
    }
    const disagreeAfter = await siDisagreement();
    notice(`SI-vs-DO disagreement after: ${disagreeAfter.length} invoice(s) (was ${disagree.length}).`);
    for (const s of disagreeAfter.slice(0, 20)) {
      notice(`  still differing: ${s.invoice_number} bills ${s.do_number} (${s.lines} line(s)) — likely no do_item_id link or a cancelled-DO edge; owner review`);
    }
  }

  const staleAfter = await staleness();
  const staleAfterInScope = staleAfter.filter((s) => scope.some((d) => d.id === s.id));
  notice("");
  notice(`Indicator after: ${staleAfterInScope.length} DO(s) still differ (was ${staleInScope.length}).`);
  notice("(residual entries are the indicator's known blind spots — drop-ship awaiting receipt, benchmark-only");
  notice(" lines the canonical function deliberately skips. Judge against the per-line CHANGED log above.)");
  notice("Done. Re-run in DRY-RUN / re-run APPLY to confirm idempotence (0 further changes expected).");
  await pg.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("RESTAMP_DO_ACTUAL_COST_FAIL", e?.message ?? e);
  try { await pg.end({ timeout: 5 }); } catch { /* closing */ }
  process.exit(1);
});
