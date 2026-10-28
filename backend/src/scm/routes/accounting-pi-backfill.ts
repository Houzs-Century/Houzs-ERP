// ----------------------------------------------------------------------------
// accounting-pi-backfill — bring every posted PI's ledger entry into the
// periodic shape (GL redesign item 3, owner 2026-09-05: 33 张漏账按新记法补,
// 19 张 Dr 330 反转重开,一次过弄干净).
//
// Two debts this pays, both measured on production before the design round:
//   • 33 POSTED invoices (RM 92,110.60) have NO journal at all — confirmed in
//     the era before the confirm transition posted the GL (zero audit FAILs:
//     the hook did not exist yet, docs/bugs/0640 has the timeline).
//   • 19 invoices posted the old perpetual shape (Dr 330-0000 STOCK); under
//     the periodic rule (item 2) their debit belongs on the group's own
//     purchase account.
//
// HOW: nothing here re-implements posting. Each invoice goes through the SAME
// two doors every live document uses — reversePiAccounting for the old entry
// (a contra JE, never a delete) and postPiAccounting for the new one (engine
// idempotency, group bindings, the named group_unbound refusal, entry dated by
// the INVOICE date so the money lands back in its own month). Running it
// twice is a no-op: a re-shaped invoice reads as 'current' the second time.
//
// dryRun=1 answers first — the owner sees the list (invoice, kind, amount)
// before anything writes; the write pass reports per-invoice outcomes so an
// unbound group surfaces as itself, not as a silent skip.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { postPiAccounting, reversePiAccounting } from './accounting';

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');

type PiRow = {
  id: string; invoice_number: string; status: string; total_sen: number | null;
  migrated_no_stock: boolean | null;
};
type JeRow = { id: string; source_doc_no: string; reversed: boolean | null; entry_date: string | null };
type JeLineRow = { journal_entry_id: string; account_code: string; debit_sen: number | null };

export type BackfillItem = {
  invoiceNumber: string;
  totalSen: number;
  kind: 'missing' | 'reshape' | 'current';
  /** The ACTIVE journal's own date — a reshape's contra takes it, so the
      invoice's month cancels within itself (bug 0647). Null when missing. */
  jeDate: string | null;
};

/** What each posted, non-migrated PI needs: no JE → 'missing'; an active JE
    debiting 330-0000 → 'reshape'; anything else → 'current'. */
export async function classifyPiBackfill(
  sb: any,
  companyId: number,
): Promise<{ ok: true; items: BackfillItem[] } | { ok: false; reason: string }> {
  const { data: pisRaw, error: piErr } = await sb
    .from('purchase_invoices')
    .select('id, invoice_number, status, total_sen, migrated_no_stock')
    .eq('company_id', companyId)
    .neq('status', 'DRAFT')
    .neq('status', 'CANCELLED');
  if (piErr) return { ok: false, reason: `PIs: ${piErr.message}` };
  const pis = ((pisRaw ?? []) as PiRow[]).filter((p) => p.migrated_no_stock !== true);

  const { data: jesRaw, error: jeErr } = await sb
    .from('journal_entries')
    .select('id, source_doc_no, reversed, entry_date')
    .eq('company_id', companyId)
    .eq('source_type', 'PI');
  if (jeErr) return { ok: false, reason: `JEs: ${jeErr.message}` };
  const activeJeByDoc = new Map<string, JeRow>();
  for (const je of (jesRaw ?? []) as JeRow[]) {
    if (!je.reversed) activeJeByDoc.set(String(je.source_doc_no), je);
  }

  const jeIds = [...activeJeByDoc.values()].map((j) => j.id);
  const dr330 = new Set<string>();
  if (jeIds.length > 0) {
    const { data: linesRaw, error: lnErr } = await sb
      .from('journal_entry_lines')
      .select('journal_entry_id, account_code, debit_sen')
      .in('journal_entry_id', jeIds);
    if (lnErr) return { ok: false, reason: `JE lines: ${lnErr.message}` };
    for (const l of (linesRaw ?? []) as JeLineRow[]) {
      if (l.account_code === '330-0000' && Number(l.debit_sen ?? 0) > 0) dr330.add(String(l.journal_entry_id));
    }
  }

  const items: BackfillItem[] = pis.map((p) => {
    const je = activeJeByDoc.get(p.invoice_number);
    const kind: BackfillItem['kind'] = !je ? 'missing' : dr330.has(je.id) ? 'reshape' : 'current';
    return { invoiceNumber: p.invoice_number, totalSen: Number(p.total_sen ?? 0), kind, jeDate: je?.entry_date ?? null };
  }).sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
  return { ok: true, items };
}

/* ── POST /accounting/backfill/pi-periodic[?dryRun=1&limit=N] ─────────────── */
export const piPeriodicBackfill = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const dryRun = c.req.query('dryRun') === '1';
  /* Batched: each invoice is a handful of reads and up to two engine posts,
     and the Workers subrequest budget is finite. The caller repeats until
     `remaining` is 0 — every pass is idempotent. */
  const limit = Math.min(25, Math.max(1, Number(c.req.query('limit') ?? 20) || 20));

  const cls = await classifyPiBackfill(sb, co.companyId);
  if (!cls.ok) return c.json({ error: 'load_failed', reason: cls.reason }, 500);
  const pending = cls.items.filter((i) => i.kind !== 'current');

  if (dryRun) {
    return c.json({
      dryRun: true,
      missing: pending.filter((i) => i.kind === 'missing'),
      reshape: pending.filter((i) => i.kind === 'reshape'),
      current: cls.items.length - pending.length,
    });
  }

  const results: Array<{ invoiceNumber: string; kind: string; outcome: string; jeNo?: string; reason?: string }> = [];
  for (const item of pending.slice(0, limit)) {
    if (item.kind === 'reshape') {
      /* The contra carries the ORIGINAL's date, not today's — the month the
         invoice lives in cancels within itself (bug 0647). */
      const rev = await reversePiAccounting(sb, item.invoiceNumber, item.jeDate ? { entryDate: item.jeDate } : {});
      if (!rev.ok) {
        results.push({ invoiceNumber: item.invoiceNumber, kind: item.kind, outcome: 'failed', reason: `reverse: ${rev.reason ?? rev.status}` });
        continue;
      }
    }
    const post = await postPiAccounting(sb, item.invoiceNumber);
    if (post.ok && (post.status === 'posted' || post.status === 'already_posted')) {
      results.push({ invoiceNumber: item.invoiceNumber, kind: item.kind, outcome: item.kind === 'reshape' ? 'reshaped' : 'posted', jeNo: post.jeNo });
    } else {
      results.push({
        invoiceNumber: item.invoiceNumber, kind: item.kind, outcome: 'failed',
        reason: (post as { reason?: string; status?: string }).reason ?? (post as { status?: string }).status,
      });
    }
  }

  const done = results.filter((r) => r.outcome !== 'failed').length;
  return c.json({
    dryRun: false,
    processed: results,
    remaining: Math.max(0, pending.length - results.length),
    summary: { attempted: results.length, done, failed: results.length - done },
  });
};
