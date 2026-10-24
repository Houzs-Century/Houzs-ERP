// check-3pl-from-ap-live.ts — READ-ONLY. Before the 3PL-from-AP read ships
// (owner 2026-10-23 「先做」): the SHIPPING prompt and matching rules
// (src/scm/lib/threepl-bill-read.ts + threepl-bill-match.ts, copied from branch
// acc/3pl-from-ap) run on real bills attached to prod AP invoices, numbers
// resolved against prod the way the route does. Writes nothing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { readTransportBill } from '../src/scm/lib/threepl-bill-read';
import { chargesPerDo, foldTrips, lineTotals, matchLines, orderKeys, pickDo, type DoCandidate, type OrderKeys } from '../src/scm/lib/threepl-bill-match';
import { extractRefTokens } from '../src/scm/shared/sales-report-parse';

const INVOICES = ['HC-API-2610-009', 'HC-API-2610-004', 'HC-API-2610-018', 'HC-API-2610-017', 'HC-API-2609-009', 'HC-API-2609-031'];
const rm = (sen: number | null | undefined) => (Number(sen ?? 0) / 100).toFixed(2);
const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } } as never });

async function resolve(keys: OrderKeys[]) {
  const soNos = [...new Set(keys.flatMap((k) => k.soNos))];
  const doNos = [...new Set(keys.flatMap((k) => k.doNos))];
  const slips = [...new Set(keys.flatMap((k) => k.slips))];
  const sos = soNos.length ? await sql`SELECT doc_no, status FROM scm.mfg_sales_orders WHERE doc_no = ANY(${soNos})` : [];
  const soKnown = new Set(sos.filter((s) => s.status !== 'CANCELLED').map((s) => String(s.doc_no)));
  const soBySlip = new Map<string, string[]>();
  for (const t of slips) {
    const d = t.replace(/\D/g, '');
    if (d.length < 4) continue;
    const rows = await sql`SELECT doc_no, status, customer_so_no, ref FROM scm.mfg_sales_orders WHERE customer_so_no ILIKE ${'%' + d + '%'} OR ref ILIKE ${'%' + d + '%'}`;
    for (const so of rows) {
      if (so.status === 'CANCELLED') continue;
      const tokens = new Set([...extractRefTokens(so.customer_so_no), ...extractRefTokens(so.ref)]);
      if (tokens.has(t)) soBySlip.set(t, [...new Set([...(soBySlip.get(t) ?? []), String(so.doc_no)])]);
    }
  }
  const doOf = (d: Record<string, unknown>): DoCandidate => ({ id: String(d.id), doNumber: String(d.do_number), doDate: d.do_date ? String(d.do_date).slice(0, 10) : null, soDocNo: d.so_doc_no ? String(d.so_doc_no) : null, companyId: Number(d.company_id), customer: d.debtor_name ? String(d.debtor_name) : null });
  const byNo = doNos.length ? await sql`SELECT id, do_number, do_date, so_doc_no, company_id, debtor_name, status FROM scm.delivery_orders WHERE do_number = ANY(${doNos})` : [];
  const allSos = [...new Set([...soKnown, ...[...soBySlip.values()].flat()])];
  const bySo = allSos.length ? await sql`SELECT id, do_number, do_date, so_doc_no, company_id, debtor_name, status FROM scm.delivery_orders WHERE so_doc_no = ANY(${allSos})` : [];
  const dosByNumber = new Map(byNo.filter((d) => d.status !== 'CANCELLED').map((d) => [String(d.do_number), doOf(d)] as const));
  const dosBySo = new Map<string, DoCandidate[]>();
  for (const d of bySo) { if (d.status === 'CANCELLED') continue; const k = String(d.so_doc_no); dosBySo.set(k, [...(dosBySo.get(k) ?? []), doOf(d)]); }
  return (k: OrderKeys, lineDate: string | null): DoCandidate[] => {
    const exact = k.doNos.map((n) => dosByNumber.get(n)).filter((d): d is DoCandidate => !!d);
    if (exact.length) return exact;
    const orders = [...new Set([...k.soNos.filter((s) => soKnown.has(s)), ...k.slips.flatMap((s) => soBySlip.get(s) ?? [])])];
    return orders.map((so) => pickDo(dosBySo.get(so) ?? [], lineDate)).filter((d): d is DoCandidate => !!d);
  };
}

try {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap3pl-'));
  for (const no of INVOICES) {
    const [inv] = await sql`SELECT i.id, i.invoice_number, i.total_sen, s.name AS supplier FROM scm.ap_invoices i JOIN scm.suppliers s ON s.id = i.supplier_id WHERE i.invoice_number = ${no}`;
    if (!inv) { console.log(`ROW|${no}: not found`); continue; }
    const files = await sql`SELECT file_key, file_name, mime FROM scm.acc_ap_invoice_files WHERE ap_invoice_id = ${inv.id} ORDER BY sort_no`;
    const bill = [];
    for (const [i, f] of files.entries()) {
      const local = path.join(dir, `${no}-${i}`);
      const g = spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `houzs-erp/${f.file_key}`, '--remote', '--file', local], { encoding: 'utf8' });
      if (g.status !== 0) { console.log(`ROW|${no}: R2 read failed`); continue; }
      bill.push({ name: String(f.file_name), mime: String(f.mime), dataBase64: readFileSync(local).toString('base64') });
    }
    const t0 = Date.now();
    const read = await readTransportBill(process.env.ANTHROPIC_API_KEY!, bill, null);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (!read.ok) { console.log(`ROW|${no}: read failed ${read.reason}`); continue; }
    const resolver = await resolve(read.lines.flatMap((l) => l.orders.map(orderKeys)));
    const lines = foldTrips(matchLines(read.lines, resolver));
    const charges = chargesPerDo(lines, () => null);
    const t = lineTotals(lines);
    console.log(`ROW|== ${no} ${inv.supplier} RM ${rm(inv.total_sen)} | read ${read.lines.length} lines in ${secs}s → ${charges.length} DOs | matched RM ${rm(t.matched)} · not found RM ${rm(t.not_found)} · no number RM ${rm(t.no_number)} · service RM ${rm(t.service_case)} · not delivery RM ${rm(t.not_delivery)} · all RM ${rm(t.all)}`);
    for (const l of lines) console.log(`ROW|   ${l.status.padEnd(12)} RM ${rm(l.amountSen).padStart(8)} ${l.kind.padEnd(9)} [${l.printed.join(', ')}] → ${l.dos.map((d) => d.doNumber + '/co' + d.companyId).join(', ') || '-'} | ${l.text.slice(0, 60)}`);
  }
} finally { await sql.end(); }
