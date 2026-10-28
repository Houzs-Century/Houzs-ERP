#!/usr/bin/env node
/* check-houzs-pi-groups.mjs — READ ONLY. Why a POSTED purchase invoice has no
   journal: postPiAccounting refuses a line with no product group
   (line_ungrouped) and a group with no purchase account for the company
   (group_unbound). Prints each named invoice's lines with their group and that
   group's purchase account, and the verdict the posting door would give.
   Env: DATABASE_URL, COMPANY_ID (1), DOCS (comma list). Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!DOCS.length) { console.error('DOCS is empty'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const binds = new Map((await sql`SELECT upper(trim(group_code)) AS g, purchase_account FROM scm.acc_item_group_accounts WHERE company_id = ${CO}`).map((b) => [b.g, b.purchase_account]));
    for (const p of await sql`SELECT id, invoice_number, total_sen FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number = ANY(${DOCS}::text[]) ORDER BY invoice_number`) {
      const items = await sql`SELECT item_code, material_name, item_group, line_total_sen FROM scm.purchase_invoice_items WHERE purchase_invoice_id = ${p.id}`;
      const lines = items.map((i) => { const g = String(i.item_group ?? '').trim().toUpperCase(); return { item: i.item_code ?? i.material_name, group: g || null, account: g ? binds.get(g) ?? null : null, sen: Number(i.line_total_sen ?? 0) }; });
      const verdict = lines.some((l) => !l.group) ? 'line_ungrouped' : lines.some((l) => !l.account) ? `group_unbound: ${[...new Set(lines.filter((l) => !l.account).map((l) => l.group))].join(', ')}` : 'would post';
      out('PI', { no: p.invoice_number, total: Number(p.total_sen), verdict, lines });
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
