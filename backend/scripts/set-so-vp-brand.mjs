#!/usr/bin/env node
// set-so-vp-brand.mjs — "which brand is this bill for?" answered for a list of
// orders, the way PUT /mfg-sales-orders/:docNo/vp-brand does it
// (routes/mfg-so-vp-brand.ts): the brand must be one the Venture Portal pays a
// margin ladder on (loadVpBrandOptions + matchVpBrand), mfg_sales_orders.vp_brand
// is set, and the order's History gets the same line ("Brand for the Venture
// Portal"). `branding` is never touched.
//
// Owner 2026-11-13: HC-SO-2610-341, a bed-frame bill (branding BEDFRAME) with no
// answer, earns no Event Commission — an order with no fair earns at its VP
// brand when its branding has no rate card, and this one has none. His October
// commission file has the bill under AKEMI. 「你能做吗？」
//
// Setting the answer also sends the order to the Venture Portal again with
// `vpBrand` (the order's own trigger, trg_vp_outbox_so), exactly as an answer on
// the order form does.
//
// MODE=plan (default) reads the orders and says what it would do; nothing is
// written. MODE=apply with CONFIRM="SET VP BRAND" sets the brand on every listed
// order not carrying it yet, then re-reads on a fresh connection and exits 1 if
// one differs. Prints doc numbers, brands and counts only (the Actions log is
// public).
//
// RE-RUN: an order already carrying the brand is left alone, so a second run
// writes nothing.
// Env: DATABASE_URL, DOCS (comma list), BRAND, ACTOR, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { scopeToCompanyId } from '../src/scm/lib/companyScope.ts';
import { recordSoAudit } from '../src/scm/lib/so-audit.ts';
import { matchVpBrand } from '../src/scm/lib/vp-brand.ts';
import { loadVpBrandOptions } from '../src/scm/lib/vp-brand-ask.ts';

const PHRASE = 'SET VP BRAND';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = [...new Set(String(process.env.DOCS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
const WANT = String(process.env.BRAND ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? '').trim() || 'Finance (by script)';
const say = (s) => console.log(s);

const readOrders = (sql) => sql`
  SELECT doc_no, status, branding, vp_brand FROM scm.mfg_sales_orders
   WHERE company_id = ${CO} AND doc_no IN ${sql(DOCS)} ORDER BY doc_no`;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (DOCS.length === 0 || !WANT) { console.error('DOCS and BRAND are required — nothing was written.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const sb = pgrestShim(sql, 'scm');
    say(`set-so-vp-brand   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}   ${DOCS.length} order(s)`);
    /* The same choices the order form offers: this company's brands the portal pays on. */
    const options = await loadVpBrandOptions({ sb, db: d1Compat(() => sql), companySql: ` AND company_id = ${CO}` });
    const brand = matchVpBrand(WANT, options);
    say(`   brands the portal pays on: ${options.join(', ') || 'none'}`);
    if (brand == null) { console.error(`"${WANT}" is not one of them — nothing was written.`); process.exit(2); }
    const orders = await readOrders(sql);
    const found = new Map(orders.map((o) => [o.doc_no, o]));
    const missing = DOCS.filter((d) => !found.has(d));
    const todo = orders.filter((o) => (o.vp_brand ?? null) !== brand);
    say(`   not an order of this company: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);
    say(`   already ${brand}: ${orders.length - todo.length}`);
    say(`   to set to ${brand}: ${todo.length}`);
    for (const o of todo) say(`      ${o.doc_no}   status ${o.status}   branding ${o.branding ?? '-'}   VP brand now ${o.vp_brand ?? '-'}`);
    if (!APPLY) { say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`); return; }

    let done = 0;
    for (const o of todo) {
      const { error } = await scopeToCompanyId(sb.from('mfg_sales_orders').update({ vp_brand: brand }).eq('doc_no', o.doc_no), CO);
      if (error) { say(`   ${o.doc_no}: NOT set (${String(error.message ?? error).slice(0, 120)})`); continue; }
      await recordSoAudit(sb, {
        docNo: o.doc_no, action: 'UPDATE_DETAILS', actorId: null, actorName: ACTOR,
        fieldChanges: [{ field: 'vp_brand', from: o.vp_brand ?? null, to: brand }],
        note: 'Brand for the Venture Portal',
      });
      done += 1;
    }
    say(`\n   set ${done} of ${todo.length}`);

    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const now = await readOrders(check);
      const wrong = now.filter((o) => (o.vp_brand ?? null) !== brand).map((o) => o.doc_no);
      say(`Verified on a fresh connection: ${now.length - wrong.length} of ${now.length} carry VP brand ${brand}${wrong.length ? ` — NOT: ${wrong.join(', ')}` : ''}`);
      if (wrong.length > 0) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
