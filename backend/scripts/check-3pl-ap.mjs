#!/usr/bin/env node
// check-3pl-ap.mjs — READ-ONLY. Owner 2026-10-21 (先确定): 「这边的3pl invoice，
// 可以从我的ap invoice 接进来吗？」 What there is to join: the 3PL carriers and
// their keyed DO charges (Delivery Rate Cards › 3PL invoices), the suppliers
// whose name looks like a carrier, and those suppliers' AP invoices — how many,
// how big, and whether their lines name delivery orders at all. Writes nothing.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const norm = (s) => String(s ?? '').toUpperCase().replace(/\b(SDN|BHD|ENTERPRISE|TRADING|SERVICES?|LOGISTICS?|TRANSPORT(ATION)?|AND|&|PLT|M)\b/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();
try {
  const carriers = await sql`SELECT company_id, id, code, name, registration_no, is_active FROM scm.threepl_companies ORDER BY company_id, name`;
  console.log(`3PL carriers: ${carriers.length}`);
  for (const c of carriers) console.log(`  co ${c.company_id} ${c.code ?? '—'} "${c.name}" ssm ${c.registration_no ?? '—'} ${c.is_active ? '' : '(inactive)'}`);
  const charges = await sql`SELECT company_id, count(*)::int AS n, sum(billed_sen)::bigint AS sen FROM scm.threepl_do_charges GROUP BY 1`;
  console.log(`3PL DO charges keyed: ${charges.map((c) => `co ${c.company_id} ${c.n} rows RM ${rm(c.sen)}`).join(', ') || 'none'}`);

  const suppliers = await sql`SELECT company_id, id, code, name FROM scm.suppliers`;
  const carrierKeys = carriers.map((c) => ({ ...c, key: norm(c.name) })).filter((c) => c.key.length >= 3);
  const looksLike = suppliers.filter((s) => {
    const k = norm(s.name);
    return k.length >= 3 && carrierKeys.some((c) => c.company_id === s.company_id && (k.includes(c.key) || c.key.includes(k)));
  });
  const transportish = suppliers.filter((s) => /TRANSPORT|LOGISTIC|LORRY|DELIVER|FREIGHT|EXPRESS|COURIER|MOVER|HAULAGE/i.test(String(s.name)));
  const ids = [...new Set([...looksLike, ...transportish].map((s) => s.id))];
  console.log(`\nSuppliers whose name matches a carrier: ${looksLike.length}; transport-sounding suppliers: ${transportish.length}`);
  for (const s of suppliers.filter((x) => ids.includes(x.id))) console.log(`  co ${s.company_id} ${s.code ?? '—'} "${s.name}"${looksLike.some((l) => l.id === s.id) ? '  ← matches a carrier' : ''}`);

  if (ids.length > 0) {
    const inv = await sql`
      SELECT i.company_id, s.name AS supplier, i.status, count(*)::int AS n, sum(i.total_sen)::bigint AS sen, min(i.invoice_date) AS first, max(i.invoice_date) AS last
        FROM scm.ap_invoices i JOIN scm.suppliers s ON s.id = i.supplier_id
       WHERE i.supplier_id IN ${sql(ids)} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    console.log('\nTheir AP invoices:');
    for (const r of inv) console.log(`  co ${r.company_id} "${r.supplier}" ${r.status}: ${r.n} invoices RM ${rm(r.sen)} ${r.first}→${r.last}`);
    const lines = await sql`
      SELECT l.description, l.amount_sen, l.debit_account_code, i.invoice_number, i.supplier_invoice_ref, s.name AS supplier
        FROM scm.ap_invoice_lines l JOIN scm.ap_invoices i ON i.id = l.invoice_id JOIN scm.suppliers s ON s.id = i.supplier_id
       WHERE i.supplier_id IN ${sql(ids)} AND i.status <> 'CANCELLED' ORDER BY i.invoice_date DESC LIMIT 400`;
    const doLike = /\b(HC-?DO|2990-?DO|DO[-\s]?\d{3,}|D\/O|DO NO|DO#)/i;
    const naming = lines.filter((l) => doLike.test(String(l.description ?? '')));
    const perInv = new Map();
    for (const l of lines) perInv.set(l.invoice_number, (perInv.get(l.invoice_number) ?? 0) + 1);
    console.log(`  lines read: ${lines.length} on ${perInv.size} invoices; lines naming a DO: ${naming.length}; lines per invoice: max ${Math.max(0, ...perInv.values())}`);
    for (const l of lines.slice(0, 12)) console.log(`    ${l.invoice_number} [${l.supplier_invoice_ref ?? '—'}] ${l.debit_account_code} RM ${rm(l.amount_sen)} — ${String(l.description ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
    for (const l of naming.slice(0, 6)) console.log(`    DO named: ${l.invoice_number} — ${String(l.description ?? '').replace(/\s+/g, ' ').slice(0, 110)}`);
    const pv = await sql`
      SELECT count(*)::int AS n FROM scm.payment_vouchers v WHERE v.supplier_id IN ${sql(ids)}`.catch(() => [{ n: 'n/a' }]);
    console.log(`  payment vouchers to them: ${pv[0].n}`);
  }
  const outsourced = await sql`SELECT count(*)::int AS n FROM scm.mfg_delivery_orders WHERE threepl_company_id IS NOT NULL`.catch((e) => [{ n: `n/a (${e.message.slice(0, 60)})` }]);
  console.log(`\nDelivery orders carrying a 3PL carrier: ${outsourced[0].n}`);
} finally { await sql.end(); }
