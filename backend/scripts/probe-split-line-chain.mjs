/* READ-ONLY probe for split-colour-lines: columns, FKs, triggers and the live
   rows of the three two-colour lines' document chains. SELECT only. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1, connect_timeout: 60 });
const say = (m = "") => console.log(m);
const T = ["mfg_sales_order_items", "purchase_order_items", "grn_items", "purchase_invoice_items", "delivery_order_items", "sales_invoice_items"];
const H = { mfg_sales_order_items: "mfg_sales_orders", purchase_order_items: "purchase_orders", grn_items: "grns", purchase_invoice_items: "purchase_invoices", delivery_order_items: "delivery_orders", sales_invoice_items: "sales_invoices" };
const LINES = [["HC-SO-012927", 5], ["HC-SO-012046", 3], ["HC-SO-012046", 4]];
try {
  for (const t of T) {
    const cols = await sql`SELECT column_name::text c, data_type::text d, column_default::text def, is_generated::text g,
      col_description(('scm.'||table_name)::regclass, ordinal_position) AS cm
      FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t} ORDER BY ordinal_position`;
    say(`\n## COLUMNS scm.${t} (${cols.length})`);
    for (const c of cols) say(`  ${c.c} ${c.d}${c.g === "ALWAYS" ? " GENERATED" : ""}${c.def ? ` def=${c.def.slice(0, 40)}` : ""}${c.cm ? ` -- ${c.cm.slice(0, 160)}` : ""}`);
  }
  say("\n## HEADER TABLES");
  for (const h of Object.values(H)) {
    const r = await sql`SELECT table_schema::text s, table_name::text t FROM information_schema.tables WHERE table_name=${h}`;
    say(`  ${h}: ${r.map((x) => x.s).join(",") || "MISSING"}`);
  }
  say("\n## FKs INTO the line tables");
  const fks = await sql`SELECT conrelid::regclass::text AS src, confrelid::regclass::text AS dst, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype='f' AND confrelid::regclass::text = ANY(${T.map((t) => "scm." + t)})`;
  for (const f of fks) say(`  ${f.src} -> ${f.dst}: ${f.def}`);
  say("\n## FKs FROM the line tables");
  const fk2 = await sql`SELECT conrelid::regclass::text AS src, confrelid::regclass::text AS dst, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text = ANY(${T.map((t) => "scm." + t)})`;
  for (const f of fk2) say(`  ${f.src} -> ${f.dst}: ${f.def}`);
  say("\n## UNIQUE / CHECK constraints on line tables");
  const uq = await sql`SELECT conrelid::regclass::text AS src, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE contype IN ('u','c','x') AND conrelid::regclass::text = ANY(${T.map((t) => "scm." + t)})`;
  for (const f of uq) say(`  ${f.src} [${f.contype}] ${f.def.slice(0, 200)}`);
  const ix = await sql`SELECT tablename::text t, indexdef FROM pg_indexes WHERE schemaname='scm' AND tablename = ANY(${T}) AND indexdef ILIKE '%UNIQUE%'`;
  for (const i of ix) say(`  UNIQUE IDX ${i.t}: ${i.indexdef}`);
  say("\n## TRIGGERS on line + header tables");
  const trg = await sql`SELECT tgrelid::regclass::text AS rel, tgname::text, pg_get_triggerdef(t.oid) AS def, p.proname::text AS fn, p.prosrc AS src
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT tgisinternal
    AND tgrelid::regclass::text = ANY(${[...T, ...Object.values(H)].map((t) => "scm." + t)})`;
  for (const g of trg) say(`  ${g.rel} ${g.tgname}: ${g.def}\n    fn ${g.fn}: ${g.src.replace(/\s+/g, " ").slice(0, 900)}`);
  say("\n## Candidate id-reference columns anywhere (name like %item_id / %line_id / %_dtl%)");
  const cand = await sql`SELECT table_schema::text s, table_name::text t, column_name::text c, data_type::text d FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema') AND (column_name ILIKE '%item_id' OR column_name ILIKE '%line_id' OR column_name ILIKE '%item_ids' OR column_name ILIKE '%line_ids' OR column_name ILIKE 'source_id' OR column_name ILIKE 'ref_id' OR column_name ILIKE '%entity_id' OR column_name ILIKE 'source_line%' OR column_name ILIKE '%row_id')
    AND table_name NOT IN (SELECT table_name FROM information_schema.views) ORDER BY 1,2,3`;
  say(`  ${cand.length} columns`);

  // chain
  const ids = {};
  const add = (t, r) => { (ids[t] ||= new Map()).set(String(r.id), r); };
  for (const [doc, ln] of LINES) {
    const so = await sql`SELECT * FROM scm.mfg_sales_order_items WHERE company_id=1 AND doc_no=${doc} AND line_no=${ln}`;
    for (const r of so) add("mfg_sales_order_items", r);
    for (const s of so) {
      for (const p of await sql`SELECT * FROM scm.purchase_order_items WHERE so_item_id::text=${String(s.id)}`) {
        add("purchase_order_items", p);
        for (const g of await sql`SELECT * FROM scm.grn_items WHERE purchase_order_item_id::text=${String(p.id)}`) {
          add("grn_items", g);
          for (const pi of await sql`SELECT * FROM scm.purchase_invoice_items WHERE grn_item_id::text=${String(g.id)}`) add("purchase_invoice_items", pi);
        }
      }
      for (const d of await sql`SELECT * FROM scm.delivery_order_items WHERE so_item_id::text=${String(s.id)}`) add("delivery_order_items", d);
      for (const si of await sql`SELECT * FROM scm.sales_invoice_items WHERE so_item_id::text=${String(s.id)}`) add("sales_invoice_items", si);
    }
  }
  const allIds = [];
  for (const [t, m] of Object.entries(ids)) {
    say(`\n## ROWS scm.${t} (${m.size})`);
    for (const r of m.values()) { allIds.push(String(r.id)); say(JSON.stringify(r)); }
  }
  // doc numbers → headers
  for (const [t, m] of Object.entries(ids)) {
    const docs = [...new Set([...m.values()].map((r) => r.doc_no ?? r.po_no ?? r.grn_no ?? r.pi_no ?? r.do_no ?? r.si_no).filter(Boolean))];
    const hid = [...new Set([...m.values()].map((r) => r.purchase_order_id ?? r.grn_id ?? r.purchase_invoice_id ?? r.delivery_order_id ?? r.sales_invoice_id ?? r.sales_order_id).filter(Boolean).map(String))];
    say(`\n## HEADERS for ${t}: docs ${docs.join(",")} ids ${hid.join(",")}`);
    const h = H[t];
    const hc = (await sql`SELECT column_name::text c FROM information_schema.columns WHERE table_schema='scm' AND table_name=${h}`).map((x) => x.c);
    const key = hc.includes("doc_no") ? "doc_no" : null;
    let rows = [];
    if (hid.length) rows = await sql.unsafe(`SELECT * FROM scm.${h} WHERE id::text = ANY($1)`, [hid]);
    else if (key && docs.length) rows = await sql.unsafe(`SELECT * FROM scm.${h} WHERE doc_no = ANY($1)`, [docs]);
    for (const r of rows) say(JSON.stringify(r));
    // sibling line counts
    for (const r of rows) {
      const fkc = (await sql`SELECT column_name::text c FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t}`).map((x) => x.c);
      const link = ["purchase_order_id", "grn_id", "purchase_invoice_id", "delivery_order_id", "sales_invoice_id"].find((c) => fkc.includes(c));
      const q = link ? await sql.unsafe(`SELECT count(*)::int n, max(line_no) mx, sum(coalesce(line_total_sen,0))::text tot FROM scm.${t} WHERE ${link}::text=$1`, [String(r.id)]).catch((e) => [{ err: e.message }])
        : await sql.unsafe(`SELECT count(*)::int n, max(line_no) mx FROM scm.${t} WHERE doc_no=$1`, [r.doc_no]).catch((e) => [{ err: e.message }]);
      say(`   lines under header ${r.id} ${r.doc_no ?? ""}: ${JSON.stringify(q[0])}`);
    }
  }
  say(`\n## REFERENCES to ${allIds.length} chain ids across candidate columns`);
  for (const c of cand) {
    try {
      const [r] = await sql.unsafe(`SELECT count(*)::int n FROM "${c.s}"."${c.t}" WHERE "${c.c}"::text = ANY($1)`, [allIds]);
      if (r.n) {
        say(`  ${c.s}.${c.t}.${c.c}: ${r.n}`);
        const rows = await sql.unsafe(`SELECT * FROM "${c.s}"."${c.t}" WHERE "${c.c}"::text = ANY($1) LIMIT 12`, [allIds]);
        for (const x of rows) say(`     ${JSON.stringify(x).slice(0, 700)}`);
      }
    } catch (e) { say(`  ${c.s}.${c.t}.${c.c}: ERR ${e.message.slice(0, 80)}`); }
  }
  say("\n## jsonb/text columns in outbox/queue/log/audit tables mentioning the ids");
  const jt = await sql`SELECT table_schema::text s, table_name::text t, column_name::text c FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema') AND data_type IN ('jsonb','json') AND (table_name ILIKE '%outbox%' OR table_name ILIKE '%queue%' OR table_name ILIKE '%amend%' OR table_name ILIKE '%allocat%' OR table_name ILIKE '%movement%' OR table_name ILIKE '%lot%' OR table_name ILIKE '%return%' OR table_name ILIKE '%link%')`;
  for (const c of jt) {
    try {
      const [r] = await sql.unsafe(`SELECT count(*)::int n FROM "${c.s}"."${c.t}" WHERE "${c.c}"::text LIKE ANY($1)`, [allIds.map((i) => `%${i}%`)]);
      if (r.n) say(`  ${c.s}.${c.t}.${c.c}: ${r.n}`);
    } catch (e) { say(`  ${c.s}.${c.t}.${c.c}: ERR ${e.message.slice(0, 80)}`); }
  }
  say("\n## inventory tables");
  const inv = await sql`SELECT table_schema::text s, table_name::text t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' AND (table_name ILIKE '%inventory%' OR table_name ILIKE '%lot%' OR table_name ILIKE '%stock%' OR table_name ILIKE '%outbox%' OR table_name ILIKE '%allocation%') ORDER BY 1,2`;
  for (const i of inv) {
    const cs = (await sql`SELECT column_name::text c FROM information_schema.columns WHERE table_schema=${i.s} AND table_name=${i.t}`).map((x) => x.c);
    say(`  ${i.s}.${i.t}: ${cs.join(",")}`);
  }
  // movements by doc
  const docsAll = ["HC-SO-012927", "HC-SO-012046", "HC-PO-009676", "HC-PO-009630", "HC-PO-009629", "HC-GR-005303-PO-009676", "HC-GR-005259", "HC-PI-007921", "HC-PI-007909", "HC-DO-2609-033"];
  for (const i of inv) {
    const cs = (await sql`SELECT column_name::text c FROM information_schema.columns WHERE table_schema=${i.s} AND table_name=${i.t}`).map((x) => x.c);
    const dc = cs.filter((c) => /(doc_no|source_doc|ref_no|reference|source_ref|doc_ref)/.test(c));
    for (const c of dc) {
      try {
        const rows = await sql.unsafe(`SELECT * FROM "${i.s}"."${i.t}" WHERE "${c}"::text = ANY($1) LIMIT 40`, [docsAll]);
        if (rows.length) { say(`  -- ${i.s}.${i.t}.${c}: ${rows.length}`); for (const x of rows) say(`     ${JSON.stringify(x).slice(0, 900)}`); }
      } catch (e) { say(`  ${i.s}.${i.t}.${c}: ERR ${e.message.slice(0, 80)}`); }
    }
  }
} catch (e) { console.error(e); } finally { await sql.end(); }
