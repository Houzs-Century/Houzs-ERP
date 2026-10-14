// Read-only probe for the SO -> SI (no DO) service-only guard. SELECT only.
// Lists SERVICE products, and every SO-sourced invoice with no DO since
// 2026-10-14 with its SO's live lines and whether each is a service line.
// Exits 0 on any answer; only a DB error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

// Mirrors backend/src/scm/shared/service-sku.ts isServiceLine (group/code signals).
const isSvc = (code, group) => {
  const g = (group ?? "").trim().toUpperCase(); const c = (code ?? "").trim().toUpperCase();
  return g.includes("SERVICE") || (c.length > 4 && c.startsWith("SVC-"));
};

try {
  const prods = await pg`
    select code, name, category, company_id from scm.mfg_products
    where category::text = 'SERVICE' or upper(code) like 'SVC-%'
    order by code`;
  console.log(`(a) SERVICE products: ${prods.length}`);
  for (const p of prods) console.log(`  ${p.code} | ${p.name} | cat=${p.category} | co=${p.company_id}`);

  const grp = await pg`
    select l.company_id, l.item_code, l.item_group, count(*)::int as n, max(l.created_at) as last
    from scm.mfg_sales_order_items l
    join scm.mfg_products p on p.code = l.item_code and p.company_id = l.company_id and p.category::text = 'SERVICE'
    where not l.cancelled
    group by 1,2,3 order by 1,2,3`;
  console.log(`(a2) live SO lines on SERVICE products, by item_group:`);
  for (const g of grp) console.log(`  co=${g.company_id} ${g.item_code} | group=${g.item_group} | n=${g.n} | last=${g.last?.toISOString?.() ?? g.last} | serviceByGroupOrCode=${isSvc(g.item_code, g.item_group)}`);

  const sis = await pg`
    select si.id, si.invoice_number, si.so_doc_no, si.status, si.created_at, si.company_id
    from scm.sales_invoices si
    where si.so_doc_no is not null and si.delivery_order_id is null
      and si.created_at >= '2026-10-14'
      and not exists (select 1 from scm.sales_invoice_items it where it.sales_invoice_id = si.id and it.do_item_id is not null)
    order by si.created_at`;
  console.log(`(b) SO-sourced, no-DO invoices since 2026-10-14: ${sis.length}`);
  for (const s of sis) {
    console.log(`  ${s.invoice_number} <- ${s.so_doc_no} status=${s.status} created=${s.created_at.toISOString()} co=${s.company_id}`);
    const lines = await pg`
      select l.item_code, l.item_group, l.cancelled, (select p.category from scm.mfg_products p where p.code = l.item_code and p.company_id = l.company_id limit 1) as category from scm.mfg_sales_order_items l
      where l.doc_no = ${s.so_doc_no} and l.company_id = ${s.company_id} order by l.item_code`;
    for (const l of lines) {
      console.log(`    ${l.item_code} | group=${l.item_group} | cancelled=${l.cancelled} | productCategory=${l.category} | service=${isSvc(l.item_code, l.item_group)}`);
    }
    const goods = lines.filter((l) => !l.cancelled && !isSvc(l.item_code, l.item_group));
    console.log(`    VERDICT: ${goods.length ? `WOULD BE BLOCKED (goods: ${goods.map((g) => g.item_code).join(", ")})` : "passes"}`);
  }
} finally {
  await pg.end();
}
