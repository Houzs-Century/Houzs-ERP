/* TEMPORARY READ-ONLY PROBE (removed before merge). Two questions:
   A. Every text column in scm/public whose name looks like it holds a product
      code, whether it has company_id / material_kind, and how many rows hold a
      value equal to a live mfg_products code of the same company.
   B. Every Sofa Accessory line (item_group fabric_accessory) carrying
      variants.fabricCode, in the six line tables — variants + stored text —
      written as JSON for the renderer tests.
   SELECT only, READ ONLY transaction. RE-RUN: stateless. */
import postgres from "postgres";
import fs from "node:fs";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const say = (m = "") => console.log(m);
const OUT = process.env.OUT || "probe-out";
fs.mkdirSync(OUT, { recursive: true });

await sql.begin(async (tx) => {
  await tx`SET TRANSACTION READ ONLY`;
  await tx`SET LOCAL statement_timeout = '120s'`;

  say("=== A. code-like text columns ===");
  const cols = await tx`
    SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS col, c.data_type AS dt,
           cls.relkind::text AS kind,
           EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema=c.table_schema AND x.table_name=c.table_name AND x.column_name='company_id') AS has_company,
           EXISTS (SELECT 1 FROM information_schema.columns x WHERE x.table_schema=c.table_schema AND x.table_name=c.table_name AND x.column_name='material_kind') AS has_kind
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.table_schema
      JOIN pg_class cls ON cls.relname = c.table_name AND cls.relnamespace = n.oid
     WHERE c.table_schema IN ('scm','public')
       AND c.data_type IN ('text','character varying','character')
       AND (c.column_name ~* '(code|sku)' OR c.column_name IN ('ref','item','product','model'))
     ORDER BY 1,2,3`;
  const result = [];
  for (const c of cols) {
    if (c.s === "scm" && c.t === "mfg_products" && c.col === "code") continue;
    const rel = `"${c.s}"."${c.t}"`;
    const col = `"${c.col}"`;
    let hits = null, sample = null, err = null;
    if (c.kind === "r" || c.kind === "p") {
      try {
        const q = c.has_company
          ? `SELECT count(*)::int AS n, (array_agg(DISTINCT t.${col}))[1:3] AS sample FROM ${rel} t JOIN scm.mfg_products p ON p.code = t.${col} AND p.company_id = t.company_id`
          : `SELECT count(*)::int AS n, (array_agg(DISTINCT t.${col}))[1:3] AS sample FROM ${rel} t WHERE t.${col} IN (SELECT code FROM scm.mfg_products)`;
        await tx`SAVEPOINT sp`;
        const [r] = await tx.unsafe(q);
        await tx`RELEASE SAVEPOINT sp`;
        hits = r.n; sample = r.sample;
      } catch (e) { err = e.message; await tx`ROLLBACK TO SAVEPOINT sp`; }
    }
    result.push({ ...c, hits, sample, err });
    say(`${c.s}.${c.t}.${c.col} [${c.dt}] kind=${c.kind} company=${c.has_company} material_kind=${c.has_kind} product_code_rows=${hits ?? "-"}${sample?.length ? ` e.g. ${JSON.stringify(sample)}` : ""}${err ? ` ERR ${err}` : ""}`);
  }
  fs.writeFileSync(`${OUT}/code-columns.json`, JSON.stringify(result, null, 2));

  say("\n=== A2. foreign keys / triggers touching mfg_products ===");
  for (const r of await tx`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype='f' AND confrelid='scm.mfg_products'::regclass`)
    say(`FK ${r.tbl} ${r.conname} ${r.def}`);
  for (const r of await tx`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid='scm.mfg_products'::regclass AND NOT tgisinternal`)
    say(`TRIGGER ${r.tgname} ${r.def}`);

  say("\n=== B. Sofa Accessory lines with fabricCode ===");
  const LINES = [
    ["so", "mfg_sales_order_items", "doc_no", null, "description2, remark"],
    ["po", "purchase_order_items", "purchase_order_id", "purchase_orders", "description2, notes"],
    ["grn", "grn_items", "grn_id", "grns", "description2, notes"],
    ["do", "delivery_order_items", "delivery_order_id", "delivery_orders", "description2, notes"],
    ["pi", "purchase_invoice_items", "purchase_invoice_id", "purchase_invoices", "description2, notes"],
    ["si", "sales_invoice_items", "sales_invoice_id", "sales_invoices", "description2, notes"],
  ];
  const lines = [];
  for (const [k, table, docCol, header, text] of LINES) {
    let rows;
    try {
      await tx`SAVEPOINT sp2`;
      rows = await tx.unsafe(`SELECT i.id::text AS id, i.company_id, i.${docCol}::text AS doc_ref, i.item_code, i.item_group, i.description, i.variants, ${text.split(", ").map((x) => `i.${x}`).join(", ")}
        ${header ? `, to_jsonb(h) AS h` : ""}
        FROM scm.${table} i ${header ? `LEFT JOIN scm.${header} h ON h.id = i.${docCol}` : ""}
        WHERE lower(coalesce(i.item_group,'')) LIKE '%fabric_accessory%' AND coalesce(i.variants->>'fabricCode','') <> ''`);
      await tx`RELEASE SAVEPOINT sp2`;
    } catch (e) { say(`${k}: ERR ${e.message}`); await tx`ROLLBACK TO SAVEPOINT sp2`; continue; }
    for (const r of rows) {
      const h = r.h || {};
      const docNo = header ? (h.po_number ?? h.do_number ?? h.grn_number ?? h.invoice_number ?? h.doc_no ?? h.pi_number ?? h.si_number ?? h.number ?? r.doc_ref) : r.doc_ref;
      delete r.h;
      lines.push({ kind: k, doc_no: docNo, ...r });
    }
    say(`${k}: ${rows.length} lines`);
  }
  fs.writeFileSync(`${OUT}/accessory-lines.json`, JSON.stringify(lines, null, 2));
  for (const l of lines.filter((x) => ["HC-SO-013503", "HC-SO-012927", "HC-SO-2609-072"].includes(x.doc_no)))
    say(`${l.kind} ${l.doc_no} ${l.item_code} fabricCode=${l.variants?.fabricCode} note=${JSON.stringify(l.variants?.extraAddonNote ?? null)} desc2=${JSON.stringify(l.description2)}`);
  const withNote = lines.filter((l) => l.variants?.extraAddonNote);
  say(`lines with both fabricCode and extraAddonNote: ${withNote.length} of ${lines.length}`);
});
say("READ-ONLY — nothing was written.");
await sql.end();
