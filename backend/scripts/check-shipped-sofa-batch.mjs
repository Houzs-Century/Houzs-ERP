// READ-ONLY. Retrospective: did every ALREADY-SHIPPED sofa set come from ONE
// batch (dye-lot)? (owner 2026-08-02: "查一下之前出货的 — 之前出货会不会有问题").
//
// A sofa is colour-matched: all its modules (1A / 2A / CNR ...) MUST ship from the
// same dye lot = the same batch_no = the same source PO. The allocator (READY) and
// the ship path (planSofaSetPoConflicts) enforce this going forward; this checks
// what ALREADY LEFT the building. For each delivered DO it groups the sofa
// consumptions by (SO doc, sofa model) and flags any group whose modules were
// consumed from more than one distinct batch_no.
//
// Grouping: model = the code up to the first '-' (BOOQIT-1A(LHF) -> BOOQIT), so
// the modules of one sofa on one SO are compared against each other.
//
// SELECT only. No writes.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const modelOf = (code) => String(code ?? "").split("-")[0].trim().toUpperCase();

async function main() {
  notice("=== SHIPPED SOFA — did every set ship from ONE batch (dye-lot)? READ-ONLY ===");

  // Every DO-sourced consumption of a SOFA line, with the consumed lot's batch and
  // the DO's status. A sofa line is identified by the product's category = SOFA.
  const rows = await sql`
    SELECT d.do_number, d.status::text AS do_status, d.company_id,
           d.so_doc_no AS so_doc, c.product_code, l.batch_no,
           SUM(c.qty_consumed)::numeric AS qty
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_lots l ON l.id = c.lot_id
      JOIN scm.delivery_orders d ON d.id = c.source_doc_id AND c.source_doc_type = 'DO'
      JOIN scm.mfg_products p ON p.code = c.product_code AND p.company_id = d.company_id
     WHERE UPPER(COALESCE(p.category::text,'')) = 'SOFA'
       AND UPPER(COALESCE(d.status::text,'')) <> 'CANCELLED'
     GROUP BY d.do_number, d.status, d.company_id, d.so_doc_no, c.product_code, l.batch_no`;

  notice(`shipped SOFA consumption rows: ${rows.length}`);
  const nullBatch = rows.filter((r) => !r.batch_no);
  notice(`  sofa consumptions whose lot had NO batch_no (source PO unknowable): ${nullBatch.length}`);
  for (const r of nullBatch.slice(0, 15)) notice(`      ${pad(r.do_number, 20)} ${pad(r.product_code, 26)} qty ${r.qty}`);

  // group by (company, SO doc, model) -> set of batches
  const groups = new Map();
  for (const r of rows) {
    const so = r.so_doc ?? `(DO ${r.do_number})`;
    const k = `${r.company_id}|${so}|${modelOf(r.product_code)}`;
    const g = groups.get(k) ?? { company: r.company_id, so, model: modelOf(r.product_code), dos: new Set(), batches: new Set(), lines: [] };
    g.dos.add(r.do_number); if (r.batch_no) g.batches.add(r.batch_no);
    g.lines.push(r); groups.set(k, g);
  }

  const sofaSets = [...groups.values()].filter((g) => g.lines.length > 1 || g.batches.size > 0);
  const mixed = sofaSets.filter((g) => g.batches.size > 1);
  notice("");
  notice(`shipped sofa SETS (grouped by SO + model): ${sofaSets.length}`);
  notice(`  sets that shipped from >1 distinct batch (MIXED dye-lot — a defect): ${mixed.length}`);
  for (const g of mixed) {
    notice(`      ${pad(g.so, 20)} ${pad(g.model, 16)} DO(s) ${[...g.dos].join(",")} batches: ${[...g.batches].join(" | ")}`);
    for (const l of g.lines) notice(`          ${pad(l.product_code, 26)} <- ${l.batch_no ?? "(no batch)"} qty ${l.qty}`);
  }
  notice("");
  notice(`=> VERDICT: ${mixed.length === 0
    ? "every already-shipped sofa set came from a SINGLE batch. Past shipments are consistent — no mixed dye-lot went out."
    : `${mixed.length} shipped sofa set(s) went out with MIXED batches — listed above for review.`}`);
  notice("=== END — read-only, nothing written. ===");
}

main().then(() => sql.end()).catch((e) => {
  console.error("SHIPPED_SOFA_BATCH_FAIL", e?.message ?? e);
  process.exit(1);
});
