// ----------------------------------------------------------------------------
// acc/settlement-rematch — decide a merchant's OPEN report lines again.
//
// A report is matched once, at upload, and the decision is stored: the report
// list's counts and the "Confirm all" button read the stored bucket. When what
// decides a match changes — a merchant's other names (owner 2026-10-21:
// 「Pinelabs=AEON，Public=PBB」), how many days a line may drift, whether its
// reference is unique — every report already uploaded still carries the old
// rule's answer. 「已经上传的报告也重新对一次」 is this module.
//
// What it may touch, and what it never does:
//   • OPEN lines only — not confirmed, not set aside. A confirmed line is the
//     ledger's; IGNORED is a person's decision. Neither is read as movable.
//   • An open line's links were written by the machine at upload: nothing else
//     writes a link without confirming (confirmSettlementRow writes and posts
//     in one go). So they are released and decided again with everything else.
//   • Nothing posts. Matching is a proposal the "Confirm all" button or a
//     person turns into an entry.
//
// One pool for every open report of the merchant, decided oldest report first,
// with what each report takes removed for the next — the same promise the
// upload makes inside one file, kept across files.
// ----------------------------------------------------------------------------

import { loadAcquirer, loadPaymentCandidates, loadSettledKeys } from './settlement';
import { matchStatement, type MatchBucket, type PaymentCandidate } from './settlement-match';
import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { mapBounded } from '../scm/lib/concurrency';

type BatchRow = { id: number; period_from: string | null; period_to: string | null };
type LineRow = {
  id: number; batch_id: number; line_no: number; txn_date: string; ref: string | null;
  gross_sen: number; fee_sen: number; net_sen: number;
  bucket: string; match_reason: string | null; notes: string | null; confirmed_at: string | null;
};
type LinkRow = { settlement_row_id: number; payment_source: string; payment_id: string };

export type RematchResult =
  | {
    ok: true;
    acquirerCode: string;
    /** Reports with at least one open line. */
    reports: number;
    /** Open lines decided again. */
    lines: number;
    /** Open lines matched by reference after the run — what "Confirm all" posts. */
    matched: number;
    /** Lines that became matched, or now match a different payment. */
    newlyMatched: number;
    /** Lines that were matched and are not any more — their payment released. */
    released: number;
    /** Lines whose stored answer could not be written; named, never hidden. */
    failed: Array<{ rowId: number; reason: string }>;
  }
  | { ok: false; reason: string };

const keyOf = (p: { source: string; id: string }) => `${p.source}:${p.id}`;
const day = (v: unknown) => String(v ?? '').slice(0, 10);

export async function rematchOpenLines(sb: any, companyId: number, acquirerCode: string): Promise<RematchResult> {
  const acq = await loadAcquirer(sb, companyId, acquirerCode);
  if (!acq.ok) return { ok: false, reason: acq.reason };
  const none = { ok: true as const, acquirerCode, reports: 0, lines: 0, matched: 0, newlyMatched: 0, released: 0, failed: [] };

  const batches = await paginateAll<BatchRow>((f, t) => sb
    .from('acc_settlement_batches').select('id, period_from, period_to')
    .eq('company_id', companyId).eq('acquirer_code', acquirerCode)
    .order('id').range(f, t));
  if (batches.error) return { ok: false, reason: `reports: ${batches.error.message}` };
  const batchIds = (batches.data ?? []).map((b) => Number(b.id));
  if (batchIds.length === 0) return none;

  const lines = await chunkIn<LineRow, number>(batchIds, (batch, f, t) => sb
    .from('acc_settlement_rows')
    .select('id, batch_id, line_no, txn_date, ref, gross_sen, fee_sen, net_sen, bucket, match_reason, notes, confirmed_at')
    .eq('company_id', companyId).in('batch_id', batch)
    .order('id').range(f, t));
  if (lines.error) return { ok: false, reason: `report lines: ${lines.error.message}` };
  const open = lines.data.filter((r) => r.confirmed_at == null && r.bucket !== 'IGNORED');
  if (open.length === 0) return none;

  /* What the open lines hold now — released below if the answer changes. */
  const links = await chunkIn<LinkRow, number>(open.map((r) => Number(r.id)), (batch, f, t) => sb
    .from('acc_settlement_matches').select('settlement_row_id, payment_source, payment_id')
    .eq('company_id', companyId).in('settlement_row_id', batch)
    .order('id').range(f, t));
  if (links.error) return { ok: false, reason: `links: ${links.error.message}` };
  const heldBy = new Map<number, string[]>();
  for (const l of links.data) {
    const id = Number(l.settlement_row_id);
    heldBy.set(id, [...(heldBy.get(id) ?? []), `${l.payment_source}:${l.payment_id}`]);
  }

  /* Taken = every claimed payment EXCEPT what these open lines hold: they are
     the ones being decided, so their payments are back on the table. */
  const settled = await loadSettledKeys(sb, companyId);
  if (!settled.ok) return { ok: false, reason: `settled payments: ${settled.reason}` };
  const reopened = new Set(links.data.map((l) => `${l.payment_source}:${l.payment_id}`));
  const taken = new Set([...settled.keys].filter((k) => !reopened.has(k)));

  const openBatchIds = new Set(open.map((r) => Number(r.batch_id)));
  const openBatches = (batches.data ?? [])
    .filter((b) => openBatchIds.has(Number(b.id)))
    .sort((a, b) => day(a.period_from).localeCompare(day(b.period_from)) || Number(a.id) - Number(b.id));
  /* One window covering every open report: the matcher measures each line's
     own distance, so a wider pool changes nothing but how often it is read. */
  const span = [
    ...open.map((r) => day(r.txn_date)),
    ...openBatches.flatMap((b) => [day(b.period_from), day(b.period_to)]),
  ].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const from = span[0];
  const to = span.at(-1);
  if (!from || !to) return { ok: false, reason: 'the open lines carry no dates' };
  const cands = await loadPaymentCandidates(sb, companyId, acq.acquirer, from, to,
    open.map((r) => r.ref).filter((r): r is string => typeof r === 'string' && r.trim() !== ''));
  if (!cands.ok) return { ok: false, reason: cands.reason };

  const cfg = { code: acq.acquirer.code, has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days };
  type Change = { row: LineRow; bucket: MatchBucket; matchReason: string | null; notes: string; link: PaymentCandidate[]; held: string[] };
  const changes: Change[] = [];
  let matched = 0;
  for (const b of openBatches) {
    const rowsOf = open.filter((r) => Number(r.batch_id) === Number(b.id)).sort((x, y) => x.line_no - y.line_no);
    const byLine = new Map(rowsOf.map((r) => [Number(r.line_no), r]));
    const decided = matchStatement(cfg, rowsOf.map((r) => ({
      lineNo: Number(r.line_no), txnDate: day(r.txn_date), ref: r.ref,
      grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen),
    })), cands.payments, taken);
    for (const d of decided) {
      const row = byLine.get(d.row.lineNo);
      if (!row) continue;
      const want = d.bucket === 'MATCHED' ? d.matched : [];
      /* A report decided earlier in this run has taken these. */
      for (const p of want) taken.add(keyOf(p));
      if (d.bucket === 'MATCHED') matched += 1;
      const held = heldBy.get(Number(row.id)) ?? [];
      const wantKeys = want.map(keyOf).sort();
      const sameLinks = held.length === wantKeys.length && [...held].sort().every((k, i) => k === wantKeys[i]);
      if (sameLinks && row.bucket === d.bucket) continue;
      changes.push({ row, bucket: d.bucket, matchReason: d.matchReason, notes: d.clue, link: want, held });
    }
  }

  /* A line confirmed while this ran is the ledger's now — left exactly as it is. */
  const recheck = await chunkIn<{ id: number; confirmed_at: string | null }, number>(changes.map((c) => Number(c.row.id)), (batch, f, t) => sb
    .from('acc_settlement_rows').select('id, confirmed_at')
    .eq('company_id', companyId).in('id', batch)
    .order('id').range(f, t));
  if (recheck.error) return { ok: false, reason: `report lines: ${recheck.error.message}` };
  const confirmedMeanwhile = new Set(recheck.data.filter((r) => r.confirmed_at != null).map((r) => Number(r.id)));
  const todo = changes.filter((c) => !confirmedMeanwhile.has(Number(c.row.id)));

  /* Release first, link after: the payment-once index would refuse a payment
     moving from one open line to another while the first still held it. */
  const releaseIds = todo.filter((c) => c.held.length > 0).map((c) => Number(c.row.id));
  for (let i = 0; i < releaseIds.length; i += 150) {
    const { error } = await sb.from('acc_settlement_matches').delete()
      .eq('company_id', companyId).in('settlement_row_id', releaseIds.slice(i, i + 150));
    if (error) return { ok: false, reason: `releasing links: ${error.message}` };
  }

  const failed: Array<{ rowId: number; reason: string }> = [];
  let newlyMatched = 0;
  let released = 0;
  await mapBounded(todo, 6, async (c) => {
    let bucket = c.bucket;
    let notes = c.notes;
    if (bucket === 'MATCHED') {
      const { error } = await sb.from('acc_settlement_matches').insert(c.link.map((p) => ({
        settlement_row_id: c.row.id,
        company_id: companyId,
        payment_source: p.source,
        payment_id: p.id,
        doc_no: p.docNo,
        amount_sen: p.amountSen,
      })));
      if (error) {
        /* The same race the upload guards: another line took the payment
           between the read and this write. It goes to a person, never twice. */
        bucket = 'NEEDS_CONFIRM';
        notes = 'That payment was cleared by another settlement while this report was being matched again — check it by hand.';
      }
    }
    const { error: upErr } = await sb.from('acc_settlement_rows')
      .update({ bucket, match_reason: c.matchReason, notes, updated_at: new Date().toISOString() })
      .eq('id', c.row.id).eq('company_id', companyId).is('confirmed_at', null);
    if (upErr) { failed.push({ rowId: Number(c.row.id), reason: upErr.message }); return; }
    if (bucket === 'MATCHED') newlyMatched += 1;
    else if (c.row.bucket === 'MATCHED' || c.held.length > 0) released += 1;
    if (c.bucket === 'MATCHED' && bucket !== 'MATCHED') matched -= 1;
  });

  return { ok: true, acquirerCode, reports: openBatches.length, lines: open.length, matched, newlyMatched, released, failed };
}
