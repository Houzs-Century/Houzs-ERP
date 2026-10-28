#!/usr/bin/env node
/* Split a sales-order line that carries TWO colours into one line per colour,
   by the stated quantity, together with EVERY downstream line that points at
   it — owner 2026-09-15: 「这个是两个 quantity 一个颜色 两个 quantity 一个颜色啊」
   「全部你要看 qty」「split agent 去做」. He has seen that some of these lines
   are already received / invoiced / delivered with posted documents and still
   wants them split.

   REUSABLE: the next case is one workflow dispatch, no new code. Input SPLITS
   is semicolon-separated  DOC:LINE_NO:QTY1xCOLOUR1+QTY2xCOLOUR2 , e.g.
     HC-SO-012927:5:2xBO315-27+2xBO315-28;HC-SO-012046:3:2xM2402-09+2xM2402-15
   Company 1 only. Every colour must be an ACTIVE scm.fabric_colours colour_id
   of company 1, and QTY1+QTY2 must equal the line's qty.

   WHAT IS SPLIT. The sales-order line (scm.mfg_sales_order_items), and the tree
   below it:
     purchase_order_items.so_item_id -> grn_items.purchase_order_item_id
       -> purchase_invoice_items.grn_item_id
     delivery_order_items.so_item_id -> sales_invoice_items.do_item_id
     sales_invoice_items.so_item_id
   The KEPT row keeps its id and takes COLOUR1/QTY1; a NEW row copies every
   column (except id; created_at = now()) and takes COLOUR2/QTY2. A new child
   row's parent link points at the NEW parent row. Every row of the tree must
   carry the same quantity as the sales-order line (its qty; qty_received for a
   GRN line) — a partial PO / DO / invoice makes "which colour is on which
   document" unknowable, so it is REFUSED.

   COLUMNS — every column of every table is classified; an unclassified column
   REFUSES the whole run (a new column must be read and placed here first):
     COUNT  split by the qty ratio and must divide exactly (qty, received_qty,
            qty_received/accepted/rejected, invoiced_qty, returned_qty,
            po_qty_picked, stock_qty_ready); otherwise REFUSED.
     MONEY  split by the qty ratio, truncated; the remainder sen stays on the
            kept row, so the two rows SUM EXACTLY to the original.
     UNIT   per-unit price/cost, copied unchanged (unit_price_sen, unit_cost_sen,
            divan/leg/special_order_price_sen — per-unit surcharges, see
            mfg-pricing-recompute.ts total = unit x qty — po_unit_price_sen,
            ship_cost_sen "frozen UNIT cost").
     ZERO   meaning per-unit vs per-line not settled (m3_milli) or would go
            stale with a new colour (committed_variant_key): must be 0/NULL,
            else REFUSED.
     COPY   identity and attributes, same on both rows — including
            linked_ac_dtlkey (the precedent for one book line held as several
            ERP rows) and remark (the SO's 「账本原文」 is the book's text).
     TEXT   description2 = "<colour_id> <label> x<qty>"; variants.fabricCode =
            colour_id (variants must be a jsonb object or NULL);
            variants.extraAddonNote rewritten only where the key exists;
            notes rewritten only where it repeated description2 verbatim.
     LINE_NO next free line_no of the document (max + 1), not "right after":
            PO line_no is "never recomputed" and the other lines keep theirs.

   HEADERS. Totals do not move (the rows sum to the original). line_count (where
   the header has one) = its line rows, when it matched before. The sales-order
   header's version (the edit concurrency token) is bumped so an open form
   cannot save the unsplit line back.

   OTHER REFERENCES. Every foreign key into the six line tables other than the
   parent links above, and every *_item_id / *_line_id column anywhere, is
   counted for the tree's ids; a hit REFUSES (allocations, price overrides,
   delivery / purchase returns, …). A PENDING scm.autocount_outbox row whose
   payload names a tree id REFUSES; a finished one is reported and left.

   STOCK LEDGER — NOT TOUCHED. No movement, lot, consumption, quantity or cost
   is created or changed. HC-DO-2609-033's OUT movements consumed AutoCount
   opening-balance lots with variant_key '' (colourless stock); they stay as
   they are, label unchanged. Lots sourced from a GRN of the tree are reported
   and left (the migrated GRNs carry migrated_no_stock, so none are expected).
   The on-hand buckets for each split SKU are printed, because a fabric_accessory
   line keys stock on fabricCode: a line that read READY against colourless
   stock may read short after its next allocation recompute.

   MODE=plan (default) does everything inside a transaction, runs the same
   checks on that connection, and ROLLS BACK. MODE=apply requires
   CONFIRM="SPLIT TWO COLOUR LINES", commits, then re-reads on a FRESH
   connection: each original quantity and money column = the sum of its two
   rows, per-unit and copied columns unchanged on both, each new child row links
   to the new parent, variants is a jsonb OBJECT with the right fabricCode,
   description2 names its own colour and qty, header rows unchanged apart from
   line_count / version, header line sums unchanged, line_count = line rows.

   Any refusal writes NOTHING for ANY split in the run and exits 1.

   RE-RUN: inert. A line already split (qty = QTY1, fabricCode = COLOUR1, and a
   sibling row with the same item and book key holding QTY2 of COLOUR2) is
   reported as done and skipped; anything else that no longer matches is refused. */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "SPLIT TWO COLOUR LINES";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
const COMPANY = 1;
const GH = !!process.env.GITHUB_ACTIONS;
const notice = (m) => console.log(GH ? `::notice::${m}` : m);
const errorLine = (m) => console.log(GH ? `::error::${m}` : `ERROR ${m}`);
const say = (m = "") => console.log(m);

// ── the input ──────────────────────────────────────────────────────────────
function parseSplits(raw) {
  const out = [];
  const bad = [];
  for (const part of String(raw ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Z0-9-]+):(\d+):(\d+)\s*[xX]\s*([A-Za-z0-9-]+)\s*\+\s*(\d+)\s*[xX]\s*([A-Za-z0-9-]+)$/.exec(part);
    if (!m) { bad.push(`"${part}" is not DOC:LINE_NO:QTY1xCOLOUR1+QTY2xCOLOUR2`); continue; }
    const s = { spec: part, doc: m[1].toUpperCase(), lineNo: Number(m[2]), q1: Number(m[3]), c1: m[4].toUpperCase(), q2: Number(m[5]), c2: m[6].toUpperCase() };
    if (s.q1 < 1 || s.q2 < 1) bad.push(`${part}: both quantities must be at least 1`);
    else if (s.c1 === s.c2) bad.push(`${part}: the two colours are the same`);
    else out.push(s);
  }
  const keys = out.map((s) => `${s.doc}:${s.lineNo}`);
  for (const k of new Set(keys)) if (keys.filter((x) => x === k).length > 1) bad.push(`${k} is named twice`);
  return { splits: out, bad };
}

// ── the tables and their columns ───────────────────────────────────────────
const TABLES = {
  mfg_sales_order_items: { qtyCol: "qty", header: { table: "mfg_sales_orders", lineKey: "doc_no", headerKey: "doc_no" }, lineNoScope: "doc_no" },
  purchase_order_items: { qtyCol: "qty", parent: { so_item_id: "mfg_sales_order_items" }, header: { table: "purchase_orders", lineKey: "purchase_order_id", headerKey: "id" }, lineNoScope: "purchase_order_id" },
  grn_items: { qtyCol: "qty_received", parent: { purchase_order_item_id: "purchase_order_items" }, header: { table: "grns", lineKey: "grn_id", headerKey: "id" } },
  purchase_invoice_items: { qtyCol: "qty", parent: { grn_item_id: "grn_items" }, header: { table: "purchase_invoices", lineKey: "purchase_invoice_id", headerKey: "id" } },
  delivery_order_items: { qtyCol: "qty", parent: { so_item_id: "mfg_sales_order_items" }, header: { table: "delivery_orders", lineKey: "delivery_order_id", headerKey: "id" }, lineNoScope: "delivery_order_id" },
  sales_invoice_items: { qtyCol: "qty", parent: { so_item_id: "mfg_sales_order_items", do_item_id: "delivery_order_items" }, header: { table: "sales_invoices", lineKey: "sales_invoice_id", headerKey: "id" }, lineNoScope: "sales_invoice_id" },
};
const ORDER = ["mfg_sales_order_items", "purchase_order_items", "grn_items", "purchase_invoice_items", "delivery_order_items", "sales_invoice_items"];
const HANDLED_LINKS = new Set(Object.entries(TABLES).flatMap(([t, d]) => Object.entries(d.parent ?? {}).map(([c, p]) => `scm.${t}.${c}->scm.${p}`)));

const COUNT = new Set(["qty", "received_qty", "qty_received", "qty_accepted", "qty_rejected", "invoiced_qty", "returned_qty", "po_qty_picked", "stock_qty_ready"]);
const MONEY = new Set(["discount_sen", "total_sen", "tax_sen", "total_inc_sen", "balance_sen", "line_total_sen", "line_cost_sen", "line_margin_sen", "allocated_charge_sen"]);
const UNIT = new Set(["unit_price_sen", "unit_cost_sen", "divan_price_sen", "leg_price_sen", "special_order_price_sen", "po_unit_price_sen", "ship_cost_sen"]);
const ZERO = new Set(["m3_milli", "committed_variant_key"]);
const COPY = new Set([
  "doc_no", "line_date", "debtor_code", "debtor_name", "agent", "item_group", "item_code", "description", "uom", "location",
  "warehouse_id", "payment_status", "venue", "branding", "remark", "cancelled", "gap_inches", "divan_height_inches",
  "leg_height_inches", "custom_specials", "line_suffix", "line_delivery_date", "line_delivery_date_overridden", "photo_urls",
  "stock_status", "allocated_batch_no", "company_id", "linked_ac_dtlkey",
  "purchase_order_id", "binding_id", "material_kind", "material_name", "supplier_sku", "delivery_date", "from_mrp",
  "supplier_delivery_date_2", "supplier_delivery_date_3", "supplier_delivery_date_4",
  "grn_id", "rejection_reason", "rack_id", "zero_cost_ack", "zero_cost_reason", "zero_cost_ack_by", "zero_cost_ack_at",
  "purchase_invoice_id", "delivery_order_id", "committed_po_batch_no", "committed_batch_strict", "ac_substituted", "sales_invoice_id",
]);
const TEXT = new Set(["description2", "variants", "notes"]);
const SPECIAL = new Set(["id", "created_at", "line_no"]);
const PARENT_COLS = new Set(["so_item_id", "purchase_order_item_id", "grn_item_id", "do_item_id"]);

function classify(table, col) {
  if (SPECIAL.has(col)) return "SPECIAL";
  if (PARENT_COLS.has(col)) return TABLES[table].parent?.[col] ? "PARENT" : null;
  for (const [name, set] of [["COUNT", COUNT], ["MONEY", MONEY], ["UNIT", UNIT], ["ZERO", ZERO], ["COPY", COPY], ["TEXT", TEXT]]) if (set.has(col)) return name;
  return null;
}

const q = (c) => `"${c.replace(/"/g, '""')}"`;
const n = (v) => (v === null || v === undefined ? 0 : Number(v));
const castOf = (dataType) => ({ integer: "integer", bigint: "bigint", text: "text", uuid: "uuid", boolean: "boolean", date: "date" }[dataType] ?? null);

async function loadColumns(db) {
  const rows = await db`SELECT table_name::text AS t, column_name::text AS c, data_type::text AS d, is_generated::text AS g
    FROM information_schema.columns WHERE table_schema = 'scm' AND table_name IN ${db(ORDER)} ORDER BY table_name, ordinal_position`;
  const cols = {};
  for (const r of rows) (cols[r.t] ||= []).push({ name: r.c, type: r.d, generated: r.g === "ALWAYS" });
  return cols;
}

// ── plan: read, check, write inside the transaction ────────────────────────
async function plan(tx, splits) {
  notice(`=== split colour lines — ${APPLY ? "APPLY" : "PLAN (rolled back)"} — ${splits.length} split(s) ===`);
  const refusals = [];
  const refuse = (m) => { refusals.push(m); errorLine(`REFUSED ${m}`); };

  const COLS = await loadColumns(tx);
  for (const t of ORDER) {
    if (!COLS[t]) { refuse(`scm.${t} not found`); continue; }
    const unknown = COLS[t].filter((c) => !classify(t, c.name)).map((c) => c.name);
    if (unknown.length) refuse(`scm.${t} has column(s) this tool has not classified: ${unknown.join(", ")} — read what they mean and place them in split-colour-lines.mjs`);
    const generated = COLS[t].filter((c) => c.generated).map((c) => c.name);
    if (generated.length) refuse(`scm.${t} has generated column(s) ${generated.join(", ")} — the copy would fail`);
  }
  if (refusals.length) return { refusals };

  // Colours.
  const colourIds = [...new Set(splits.flatMap((s) => [s.c1, s.c2]))];
  const colourRows = await tx`SELECT colour_id::text AS id, label::text AS label FROM scm.fabric_colours
    WHERE company_id = ${COMPANY} AND active AND colour_id IN ${tx(colourIds)}`;
  const colour = new Map();
  for (const id of colourIds) {
    const hits = colourRows.filter((r) => r.id === id);
    if (!hits.length) { refuse(`colour ${id} is not an active scm.fabric_colours colour_id of company ${COMPANY}`); continue; }
    const labels = [...new Set(hits.map((h) => String(h.label ?? "").trim()).filter(Boolean))];
    const label = labels.length === 1 ? labels[0].replace(new RegExp(`^${id.replace(/[-]/g, "\\-")}\\s*`, "i"), "").trim() : "";
    colour.set(id, { id, label });
  }
  const textFor = (code, qty) => `${code}${colour.get(code)?.label ? ` ${colour.get(code).label}` : ""} x${qty}`;

  // External references: FKs into the line tables, plus *_item_id/*_line_id columns anywhere.
  const fks = await tx`SELECT c.conrelid::regclass::text AS src, a.attname::text AS col, c.confrelid::regclass::text AS dst
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND c.confrelid::regclass::text IN ${tx(ORDER.map((t) => `scm.${t}`))}`;
  const nameCols = await tx`SELECT c.table_schema::text AS s, c.table_name::text AS t, c.column_name::text AS c, c.data_type::text AS d FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND (c.column_name ILIKE '%item_id' OR c.column_name ILIKE '%line_id' OR c.column_name ILIKE '%item_ids' OR c.column_name ILIKE '%line_ids')
      AND c.data_type IN ('uuid', 'text', 'ARRAY', 'character varying')`;
  const refCols = new Map();
  for (const f of fks) {
    if (HANDLED_LINKS.has(`${f.src}.${f.col}->${f.dst}`)) continue;
    const [sch, tbl] = f.src.includes(".") ? f.src.split(".") : ["public", f.src];
    refCols.set(`${sch}.${tbl}.${f.col}`, { from: `${q(sch)}.${q(tbl)}`, label: `${sch}.${tbl}.${f.col}`, col: f.col, isArray: false });
  }
  for (const c of nameCols) {
    const key = `${c.s}.${c.t}.${c.c}`;
    const handled = [...HANDLED_LINKS].some((h) => h.startsWith(`${key}->`));
    if (!handled && !refCols.has(key)) refCols.set(key, { from: `${q(c.s)}.${q(c.t)}`, label: key, col: c.c, isArray: c.d === "ARRAY" });
  }
  say(`reference columns checked for every tree: ${refCols.size}`);
  const headers = new Map(); // header key -> snapshot taken before any line under it is written

  const results = [];
  for (const s of splits) {
    say(`\n── ${s.spec}`);
    const before = refusals.length;
    const [soRow, ...more] = await tx`SELECT * FROM scm.mfg_sales_order_items WHERE company_id = ${COMPANY} AND doc_no = ${s.doc} AND line_no = ${s.lineNo}`;
    if (!soRow) { refuse(`${s.spec}: ${s.doc} has no line ${s.lineNo} in company ${COMPANY}`); continue; }
    if (more.length) { refuse(`${s.spec}: ${s.doc} has ${more.length + 1} rows with line_no ${s.lineNo}`); continue; }
    if (soRow.cancelled) { refuse(`${s.spec}: the line is cancelled`); continue; }
    const soFabric = soRow.variants && typeof soRow.variants === "object" && !Array.isArray(soRow.variants) ? String(soRow.variants.fabricCode ?? "") : "";
    if (n(soRow.qty) !== s.q1 + s.q2) {
      const [sib] = await tx`SELECT id::text, line_no, qty FROM scm.mfg_sales_order_items
        WHERE company_id = ${COMPANY} AND doc_no = ${s.doc} AND id::text <> ${String(soRow.id)} AND item_code = ${soRow.item_code}
          AND linked_ac_dtlkey::text IS NOT DISTINCT FROM ${soRow.linked_ac_dtlkey == null ? null : String(soRow.linked_ac_dtlkey)}::text AND qty = ${s.q2}
          AND jsonb_typeof(variants) = 'object' AND variants->>'fabricCode' = ${s.c2}`;
      if (n(soRow.qty) === s.q1 && soFabric === s.c1 && sib) { notice(`ALREADY SPLIT ${s.spec}: line ${s.lineNo} holds ${s.q1} × ${s.c1}, line ${sib.line_no} holds ${s.q2} × ${s.c2} — skipped`); continue; }
      refuse(`${s.spec}: line qty is ${soRow.qty}, not ${s.q1}+${s.q2}`);
      continue;
    }
    if (!colour.has(s.c1) || !colour.has(s.c2)) continue; // already refused above

    // The tree.
    const nodes = []; // { table, row, parentTable, parentId }
    const add = (table, row) => { if (!nodes.some((x) => x.table === table && x.row.id === row.id)) nodes.push({ table, row }); };
    add("mfg_sales_order_items", soRow);
    for (const p of await tx`SELECT * FROM scm.purchase_order_items WHERE so_item_id = ${soRow.id}`) {
      add("purchase_order_items", p);
      for (const g of await tx`SELECT * FROM scm.grn_items WHERE purchase_order_item_id = ${p.id}`) {
        add("grn_items", g);
        for (const pi of await tx`SELECT * FROM scm.purchase_invoice_items WHERE grn_item_id = ${g.id}`) add("purchase_invoice_items", pi);
      }
    }
    for (const d of await tx`SELECT * FROM scm.delivery_order_items WHERE so_item_id = ${soRow.id}`) {
      add("delivery_order_items", d);
      for (const si of await tx`SELECT * FROM scm.sales_invoice_items WHERE do_item_id = ${d.id}`) add("sales_invoice_items", si);
    }
    for (const si of await tx`SELECT * FROM scm.sales_invoice_items WHERE so_item_id = ${soRow.id}`) add("sales_invoice_items", si);
    nodes.sort((a, b) => ORDER.indexOf(a.table) - ORDER.indexOf(b.table));
    const ids = nodes.map((x) => String(x.row.id));
    const inTree = new Map(nodes.map((x) => [String(x.row.id), x]));

    // Per-row checks.
    for (const node of nodes) {
      const { table, row } = node;
      const label = `${table} ${row.id}`;
      const Q = n(row[TABLES[table].qtyCol]);
      if (Q !== s.q1 + s.q2) refuse(`${s.spec}: ${label} carries ${TABLES[table].qtyCol} ${Q}, not the line's ${s.q1 + s.q2} — a partial document cannot be split by colour`);
      if (String(row.company_id) !== String(COMPANY)) refuse(`${s.spec}: ${label} is company ${row.company_id}`);
      const v = row.variants;
      if (v !== null && v !== undefined && (typeof v !== "object" || Array.isArray(v))) refuse(`${s.spec}: ${label} variants is not a jsonb object (${Array.isArray(v) ? "array" : typeof v})`);
      const fc = v && typeof v === "object" && !Array.isArray(v) ? String(v.fabricCode ?? "") : "";
      if (fc && fc !== s.c1) refuse(`${s.spec}: ${label} already carries fabricCode ${fc}`);
      for (const c of COLS[table]) {
        const kind = classify(table, c.name);
        const val = row[c.name];
        if (kind === "COUNT" && val !== null && (n(val) * s.q2) % Q !== 0) refuse(`${s.spec}: ${label} ${c.name} = ${val} does not divide by the ${s.q1}+${s.q2} split — which colour it covers is unknowable`);
        if (kind === "ZERO" && val !== null && val !== 0 && val !== "0") refuse(`${s.spec}: ${label} ${c.name} = ${JSON.stringify(val)} — must be 0/NULL for this tool to split the line`);
        if (kind === "PARENT" && val !== null && !inTree.has(String(val))) refuse(`${s.spec}: ${label} ${c.name} points at ${val}, outside this line's tree`);
      }
    }
    // External references.
    for (const rc of refCols.values()) {
      const where = rc.isArray
        ? `EXISTS (SELECT 1 FROM unnest(${q(rc.col)}) x WHERE x::text = ANY($1::text[]))`
        : `${q(rc.col)}::text = ANY($1::text[])`;
      const [r] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${rc.from} WHERE ${where}`, [ids]);
      if (r.n) refuse(`${s.spec}: ${r.n} row(s) of ${rc.label} reference this line's tree — not handled by this tool`);
    }
    const outbox = await tx`SELECT id::text, op, doc_type, doc_no, status FROM scm.autocount_outbox
      WHERE company_id = ${COMPANY} AND payload::text LIKE ANY(${ids.map((i) => `%${i}%`)})`;
    for (const o of outbox) {
      if (["pending"].includes(String(o.status)) ) refuse(`${s.spec}: AutoCount outbox ${o.id} (${o.op} ${o.doc_type} ${o.doc_no}) is still ${o.status} and names a tree line`);
      else say(`   AutoCount outbox ${o.id} ${o.op} ${o.doc_type} ${o.doc_no} status ${o.status} names a tree line — finished, left as it is`);
    }
    // Stock ledger: report only.
    const grnHeaderIds = nodes.filter((x) => x.table === "grn_items").map((x) => String(x.row.grn_id));
    if (grnHeaderIds.length) {
      const lots = await tx`SELECT id::text, variant_key, qty_received, qty_remaining, source_doc_no FROM scm.inventory_lots
        WHERE company_id = ${COMPANY} AND item_code = ${soRow.item_code} AND source_doc_id::text IN ${tx(grnHeaderIds)}`;
      for (const l of lots) say(`   STOCK lot ${l.id} from ${l.source_doc_no} variant_key "${l.variant_key}" received ${l.qty_received} remaining ${l.qty_remaining} — LEFT as it is (not relabelled)`);
      if (!lots.length) say(`   STOCK no lot was created by the tree's GRN(s) — nothing to relabel`);
    }
    const doIds = nodes.filter((x) => x.table === "delivery_order_items").map((x) => String(x.row.delivery_order_id));
    if (doIds.length) {
      const mv = await tx`SELECT id::text, movement_type, variant_key, qty, total_cost_sen, source_doc_no FROM scm.inventory_movements
        WHERE company_id = ${COMPANY} AND item_code = ${soRow.item_code} AND source_doc_id::text IN ${tx(doIds)}`;
      for (const m of mv) say(`   STOCK movement ${m.id} ${m.movement_type} ${m.source_doc_no} variant_key "${m.variant_key}" qty ${m.qty} cost ${m.total_cost_sen} — LEFT as it is (colourless stock it came from)`);
    }
    const bal = await tx`SELECT variant_key, sum(qty)::int AS qty FROM scm.inventory_balances
      WHERE item_code = ${soRow.item_code} AND warehouse_id::text IS NOT DISTINCT FROM ${soRow.warehouse_id == null ? null : String(soRow.warehouse_id)}::text GROUP BY variant_key ORDER BY variant_key`;
    say(`   STOCK on hand ${soRow.item_code} in the line's warehouse by variant_key: ${bal.map((b) => `"${b.variant_key}"=${b.qty}`).join(", ") || "(none)"} (item_group ${soRow.item_group})`);

    if (refusals.length > before) continue;

    // Before.
    for (const { table, row } of nodes) {
      const money = COLS[table].filter((c) => MONEY.has(c.name) || UNIT.has(c.name) || COUNT.has(c.name)).map((c) => `${c.name}=${row[c.name]}`).filter((x) => !/=(0|null)$/.test(x));
      say(`   BEFORE ${table} ${row.id}${row.line_no != null ? ` ln${row.line_no}` : ""}: ${money.join(" ")} | desc2 ${JSON.stringify(row.description2)} | variants ${JSON.stringify(row.variants)}`);
    }

    // Snapshot every header this tree sits under, BEFORE any line under it is written.
    for (const { table, row } of nodes) {
      const h = TABLES[table].header;
      const key = String(row[h.lineKey]);
      const hk = `${h.table}:${key}`;
      if (!headers.has(hk)) {
        const [hrow] = await tx.unsafe(`SELECT * FROM scm.${h.table} WHERE ${q(h.headerKey)}::text = $1`, [key]);
        const sumCols = COLS[table].filter((c) => COUNT.has(c.name) || MONEY.has(c.name)).map((c) => c.name);
        const [sums] = await tx.unsafe(`SELECT ${sumCols.map((c) => `coalesce(sum(${q(c)}), 0)::text AS ${q(c)}`).join(", ")}, count(*)::int AS "__rows"
          FROM scm.${table} WHERE ${q(h.lineKey)}::text = $1`, [key]);
        const hcols = (await tx`SELECT column_name::text AS c FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ${h.table}`).map((x) => x.c);
        if (!hrow) refuse(`${s.spec}: header ${h.table} ${key} of ${table} ${row.id} not found`);
        headers.set(hk, { table: h.table, lineTable: table, lineKey: h.lineKey, headerKey: h.headerKey, key, row: hrow, hcols, sumCols, sums, rowsBefore: sums.__rows, added: 0 });
      }
      headers.get(hk).added += 1;
    }
    if (refusals.length > before) continue;

    // Write, parents first.
    const newId = new Map(); // old id -> new id
    for (const { table, row } of nodes) {
      const Q = n(row[TABLES[table].qtyCol]);
      const cols = COLS[table];
      const keep = {}; const add2 = {};
      for (const c of cols) {
        const kind = classify(table, c.name);
        const val = row[c.name];
        if ((kind === "COUNT" || kind === "MONEY") && val !== null) {
          const part = kind === "COUNT" ? (n(val) * s.q2) / Q : Math.trunc((n(val) * s.q2) / Q);
          add2[c.name] = part; keep[c.name] = n(val) - part;
        }
        if (kind === "PARENT" && val !== null) add2[c.name] = newId.get(String(val));
      }
      const d1 = textFor(s.c1, s.q1); const d2 = textFor(s.c2, s.q2);
      keep.description2 = d1; add2.description2 = d2;
      const notesRepeated = row.notes != null && row.description2 != null && String(row.notes).trim() === String(row.description2).trim();
      if (notesRepeated) { keep.notes = d1; add2.notes = d2; }

      // The new row: a copy of every column but id, then the overrides.
      const copyCols = cols.filter((c) => c.name !== "id").map((c) => c.name);
      const sel = copyCols.map((c) => (c === "created_at" ? "now()" : q(c))).join(", ");
      const [ins] = await tx.unsafe(`INSERT INTO scm.${table} (${copyCols.map(q).join(", ")}) SELECT ${sel} FROM scm.${table} WHERE id = $1::uuid RETURNING id::text`, [String(row.id)]);
      newId.set(String(row.id), ins.id);
      const scope = TABLES[table].lineNoScope;
      if (scope) {
        const [{ next }] = await tx.unsafe(`SELECT coalesce(max(line_no), 0) + 1 AS next FROM scm.${table} WHERE ${q(scope)} = $1`, [String(row[scope])]);
        add2.line_no = Number(next);
      }
      const setCols = async (id, obj) => {
        const entries = Object.entries(obj);
        if (!entries.length) return;
        const params = []; const sets = [];
        for (const [c, v] of entries) {
          const cast = castOf(cols.find((x) => x.name === c).type);
          if (!cast) throw new Error(`no cast for ${table}.${c}`);
          params.push(v === null || v === undefined ? null : String(v));
          sets.push(`${q(c)} = $${params.length}::${cast}`);
        }
        params.push(id);
        const back = await tx.unsafe(`UPDATE scm.${table} SET ${sets.join(", ")} WHERE id = $${params.length}::uuid RETURNING id`, params);
        if (back.length !== 1) throw new Error(`update of ${table} ${id} touched ${back.length} rows`);
      };
      await setCols(String(row.id), keep);
      await setCols(ins.id, add2);
      const setVariants = (id, code, note) => tx.unsafe(`UPDATE scm.${table}
        SET variants = (CASE WHEN variants IS NULL OR jsonb_typeof(variants) = 'null' THEN '{}'::jsonb ELSE variants END)
                       || jsonb_build_object('fabricCode', $1::text)
                       || (CASE WHEN jsonb_typeof(variants) = 'object' AND variants ? 'extraAddonNote' THEN jsonb_build_object('extraAddonNote', $2::text) ELSE '{}'::jsonb END)
        WHERE id = $3::uuid AND (variants IS NULL OR jsonb_typeof(variants) IN ('object', 'null')) RETURNING id`, [code, note, id]);
      if ((await setVariants(String(row.id), s.c1, d1)).length !== 1) throw new Error(`variants of ${table} ${row.id} not written`);
      if ((await setVariants(ins.id, s.c2, d2)).length !== 1) throw new Error(`variants of ${table} ${ins.id} not written`);
      say(`   SPLIT ${table} ${row.id} -> kept ${s.q1} × ${s.c1} | new ${ins.id}${add2.line_no ? ` ln${add2.line_no}` : ""} ${s.q2} × ${s.c2}${Object.keys(add2).filter((k) => PARENT_COLS.has(k)).map((k) => ` ${k}=${add2[k]}`).join("")}`);
    }
    results.push({ split: s, nodes: nodes.map(({ table, row }) => ({ table, row, newId: newId.get(String(row.id)) })) });
  }
  if (refusals.length) return { refusals };

  // Headers: line_count and the SO edit token. Totals are not written — the rows sum to the original.
  const headerSnap = [...headers.values()];
  for (const h of headerSnap) {
    const row = h.row;
    h.lineCountTarget = null;
    if (h.hcols.includes("line_count")) {
      const wasConsistent = n(row.line_count) === h.rowsBefore;
      h.lineCountTarget = wasConsistent ? h.rowsBefore + h.added : n(row.line_count) + h.added;
      if (!wasConsistent) notice(`${h.table} ${h.key}: line_count ${row.line_count} did not match its ${h.rowsBefore} line rows before — raised by ${h.added}, not reset`);
      await tx.unsafe(`UPDATE scm.${h.table} SET line_count = $1::integer WHERE ${q(h.headerKey)}::text = $2`, [String(h.lineCountTarget), h.key]);
    }
    h.bumpVersion = h.table === "mfg_sales_orders" && h.hcols.includes("version");
    if (h.bumpVersion) await tx.unsafe(`UPDATE scm.${h.table} SET version = version + 1 WHERE ${q(h.headerKey)}::text = $1`, [h.key]);
    say(`   HEADER ${h.table} ${row.doc_no ?? row.po_number ?? row.grn_number ?? row.invoice_number ?? row.do_number ?? h.key}: line rows ${h.rowsBefore} -> ${h.rowsBefore + h.added}${h.lineCountTarget != null ? `, line_count ${row.line_count} -> ${h.lineCountTarget}` : " (no line_count column)"}${h.bumpVersion ? `, version ${row.version} -> ${n(row.version) + 1}` : ""}; totals ${["subtotal_sen", "total_sen", "local_total_sen", "balance_sen"].filter((c) => c in row).map((c) => `${c}=${row[c]}`).join(" ")} unchanged`);
  }
  return { refusals, results, headerSnap };
}

// ── the checks, run on whatever connection is given ─────────────────────────
async function check(db, state) {
  const fails = [];
  const COLS = await loadColumns(db);
  for (const { split: s, nodes } of state.results) {
    const byOld = new Map(nodes.map((x) => [String(x.row.id), x]));
    for (const { table, row, newId } of nodes) {
      const [kept] = await db.unsafe(`SELECT *, jsonb_typeof(variants) AS variants_shape FROM scm.${table} WHERE id = $1::uuid`, [String(row.id)]);
      const [made] = await db.unsafe(`SELECT *, jsonb_typeof(variants) AS variants_shape FROM scm.${table} WHERE id = $1::uuid`, [newId]);
      const tag = `${s.doc}:${s.lineNo} ${table} ${row.id}/${newId}`;
      if (!kept || !made) { fails.push(`${tag}: a row is missing`); continue; }
      const qc = TABLES[table].qtyCol;
      if (n(kept[qc]) !== s.q1 || n(made[qc]) !== s.q2) fails.push(`${tag}: ${qc} ${kept[qc]}+${made[qc]}, want ${s.q1}+${s.q2}`);
      for (const c of COLS[table]) {
        const kind = classify(table, c.name);
        const o = row[c.name];
        if (kind === "COUNT" || kind === "MONEY") {
          if (o === null ? (kept[c.name] !== null || made[c.name] !== null) : n(kept[c.name]) + n(made[c.name]) !== n(o)) fails.push(`${tag}: ${c.name} ${kept[c.name]}+${made[c.name]} != ${o}`);
        } else if (kind === "UNIT" || kind === "COPY" || kind === "ZERO") {
          const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
          if (!same(kept[c.name], o) || !same(made[c.name], o)) fails.push(`${tag}: ${c.name} changed (${JSON.stringify(o)} -> ${JSON.stringify(kept[c.name])} / ${JSON.stringify(made[c.name])})`);
        } else if (kind === "PARENT") {
          if (String(kept[c.name]) !== String(o)) fails.push(`${tag}: kept ${c.name} moved`);
          const want = o === null ? null : byOld.get(String(o))?.newId;
          if (String(made[c.name]) !== String(want)) fails.push(`${tag}: new ${c.name} = ${made[c.name]}, want the new parent ${want}`);
        }
      }
      for (const [r, code, qty] of [[kept, s.c1, s.q1], [made, s.c2, s.q2]]) {
        if (r.variants_shape !== "object") fails.push(`${tag}: variants is ${r.variants_shape}, not an object`);
        else if (r.variants.fabricCode !== code) fails.push(`${tag}: fabricCode ${r.variants.fabricCode}, want ${code}`);
        if (!new RegExp(`^${code}\\b.* x${qty}$`).test(String(r.description2 ?? ""))) fails.push(`${tag}: description2 ${JSON.stringify(r.description2)} does not name ${code} x${qty}`);
        if (r.variants_shape === "object" && "extraAddonNote" in r.variants && r.variants.extraAddonNote !== r.description2) fails.push(`${tag}: extraAddonNote ${JSON.stringify(r.variants.extraAddonNote)} != description2`);
      }
      if (TABLES[table].lineNoScope && (made.line_no == null || n(made.line_no) <= 0)) fails.push(`${tag}: new row has no line_no`);
    }
  }
  const IGNORE = new Set(["line_count", "version", "updated_at"]);
  for (const h of state.headerSnap) {
    const [row] = await db.unsafe(`SELECT * FROM scm.${h.table} WHERE ${q(h.headerKey)}::text = $1`, [h.key]);
    const tag = `${h.table} ${h.key}`;
    if (!row) { fails.push(`${tag}: missing`); continue; }
    for (const k of Object.keys(h.row)) if (!IGNORE.has(k) && JSON.stringify(row[k]) !== JSON.stringify(h.row[k])) fails.push(`${tag}: header ${k} changed ${JSON.stringify(h.row[k])} -> ${JSON.stringify(row[k])}`);
    if (h.lineCountTarget != null && n(row.line_count) !== h.lineCountTarget) fails.push(`${tag}: line_count ${row.line_count}, want ${h.lineCountTarget}`);
    if (h.bumpVersion && n(row.version) !== n(h.row.version) + 1) fails.push(`${tag}: version ${row.version}, want ${n(h.row.version) + 1}`);
    const [sums] = await db.unsafe(`SELECT ${h.sumCols.map((c) => `coalesce(sum(${q(c)}), 0)::text AS ${q(c)}`).join(", ")}, count(*)::int AS "__rows"
      FROM scm.${h.lineTable} WHERE ${q(h.lineKey)}::text = $1`, [h.key]);
    for (const c of h.sumCols) if (sums[c] !== h.sums[c]) fails.push(`${tag}: line sum ${c} was ${h.sums[c]} before the split, now ${sums[c]}`);
    if (sums.__rows !== h.rowsBefore + h.added) fails.push(`${tag}: ${sums.__rows} line rows, want ${h.rowsBefore} + ${h.added}`);
    if (h.lineCountTarget != null && h.rowsBefore === n(h.row.line_count) && n(row.line_count) !== sums.__rows) fails.push(`${tag}: line_count ${row.line_count} != ${sums.__rows} line rows`);
  }
  return fails;
}

// ── run ────────────────────────────────────────────────────────────────────
const { splits, bad } = parseSplits(process.env.SPLITS);
if (bad.length || !splits.length) {
  for (const b of bad) errorLine(`REFUSED ${b}`);
  if (!splits.length) errorLine("REFUSED no split given (SPLITS is empty)");
  process.exit(1);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
let state;
let refused = false;
try {
  await sql.begin(async (tx) => {
    state = await plan(tx, splits);
    if (state.refusals.length) { refused = true; throw new Error("REFUSED_ROLLBACK"); }
    const inTx = await check(tx, state);
    if (inTx.length) { for (const f of inTx) errorLine(`CHECK ${f}`); refused = true; throw new Error("REFUSED_ROLLBACK"); }
    notice(`in-transaction check OK: ${state.results.length} split(s), ${state.results.reduce((a, r) => a + r.nodes.length, 0)} rows split, ${state.headerSnap.length} header(s) consistent`);
    if (!APPLY) throw new Error("PLAN_ROLLBACK");
  }).catch((e) => { if (e.message !== "PLAN_ROLLBACK" && e.message !== "REFUSED_ROLLBACK") throw e; });
} catch (e) { console.error(e); await sql.end(); process.exit(1); }
await sql.end();
if (refused) { notice(`REFUSED — ${state.refusals?.length ?? 0} refusal(s); nothing written for any split.`); process.exit(1); }
if (!APPLY) { notice(`PLAN — rolled back, nothing written. Apply with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`); process.exit(0); }
if (!state.results.length) { notice("APPLY — nothing to do (every split already done)."); process.exit(0); }

// Fresh connection: re-read and assert the SHAPE and the values.
const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
let fails;
try { fails = await check(fresh, state); } finally { await fresh.end(); }
if (fails.length) { for (const f of fails) errorLine(`VERIFY ${f}`); notice(`VERIFY FAILED (${fails.length})`); process.exit(1); }
for (const r of state.results) for (const x of r.nodes) say(`   VERIFIED ${r.split.doc}:${r.split.lineNo} ${x.table} kept ${x.row.id} (${r.split.q1} × ${r.split.c1}) + new ${x.newId} (${r.split.q2} × ${r.split.c2})`);
notice(`VERIFY OK (fresh connection): ${state.results.length} split(s); quantities and money sum to the originals, per-unit and copied columns unchanged, new children link to new parents, variants are jsonb objects with the right fabricCode, headers unchanged apart from line_count/version, header line sums unchanged`);
