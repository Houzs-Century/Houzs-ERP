
import { postBatchReceipt, undoBatchReceipt } from './settlement';

/** One merchant statement's share of the credit. */
export type CreditShare = { batchId: number; amountSen: number };
/** What the acquirer kept off this credit, named against one of the statements it pays. */
export type CreditCharge = { batchId: number; amountSen: number; accountCode: string; note: string };
export type PostedShare = { batchId: number; receiptId: number; jeNo?: string; outstandingSen: number; chargeSen: number };

/** The movement as this needs it: an OPEN money-in row of acc_bank_statement_lines. */
export type CreditLine = { id: number; booked_on: string; reference: string | null; statement_id: number };

export type PostBankCreditResult =
  | { ok: true; posted: PostedShare[] }
  | { ok: false; status: 409 | 500; body: Record<string, unknown> };

export async function postBankCredit(
  sb: any,
  companyId: number,
  line: CreditLine,
  allocations: CreditShare[],
  charge: CreditCharge | null,
  userName: string | null,
): Promise<PostBankCreditResult> {
  const receivedOn = String(line.booked_on).slice(0, 10);
  const bankRef = line.reference ?? null;
  const posted: PostedShare[] = [];

  /* WHICH BANK the money is in — the statement's own account, not the
     acquirer's configured one. The owner asked exactly this: 不确定 maybank 对
     其他的卡机. An acquirer set up to pay into Hong Leong whose credit turns up
     on the Maybank statement really is money in Maybank, and booking it to Hong
     Leong would leave Maybank's reconciliation permanently short by that
     amount. The statement is evidence; the configuration is a guess made before
     the money moved. */
  const { data: stmtRaw, error: stmtRdErr } = await sb.from('acc_bank_statements')
    .select('account_code').eq('id', line.statement_id).eq('company_id', companyId).maybeSingle();
  if (stmtRdErr) return { ok: false, status: 500, body: { error: 'load_failed', reason: stmtRdErr.message } };
  const bankAccountCode = (stmtRaw as { account_code?: string } | null)?.account_code ?? null;

  for (const a of allocations) {
    const r = await postBatchReceipt(sb, companyId, a.batchId, {
      receivedOn, amountSen: a.amountSen, bankRef, bankAccountCode, userName,
      charge: charge && charge.batchId === a.batchId ? { amountSen: charge.amountSen, accountCode: charge.accountCode, note: charge.note } : null,
    });
    if (!r.ok) {
      const undone: string[] = [];
      for (const done of posted) {
        const back = await undoBatchReceipt(sb, companyId, done.receiptId);
        if (!back.ok) undone.push(`${done.jeNo ?? done.receiptId}: ${back.reason}`);
      }
      return {
        ok: false,
        status: 409,
        body: {
          error: r.status,
          message: r.reason
            + (undone.length > 0
              ? ` — AND ${undone.length} earlier share(s) could not be taken back: ${undone.join('; ')}. Check the ledger before retrying.`
              : posted.length > 0 ? ` The other ${posted.length} share(s) were taken back, so nothing is half-booked.` : ''),
        },
      };
    }
    posted.push({ batchId: a.batchId, receiptId: r.receiptId, jeNo: r.jeNo, outstandingSen: r.outstandingSen, chargeSen: r.chargeSen });
  }

  for (const p of posted) {
    await sb.from('acc_settlement_receipts').update({ bank_line_id: line.id }).eq('id', p.receiptId);
  }

  const { error: upErr } = await sb.from('acc_bank_statement_lines').update({
    state: 'POSTED',
    posted_je_no: posted.map((p) => p.jeNo).filter(Boolean).join(', ') || null,
    updated_at: new Date().toISOString(),
  }).eq('id', line.id).eq('company_id', companyId);
  if (upErr) {
    return {
      ok: false,
      status: 500,
      body: { error: 'save_failed', reason: `${upErr.message} (the receipt(s) WERE posted — the statement line did not record it)` },
    };
  }
  return { ok: true, posted };
}
