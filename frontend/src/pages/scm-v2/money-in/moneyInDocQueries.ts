// ----------------------------------------------------------------------------
// moneyInDocQueries — what a Money-in document's page reads beyond the
// document itself (the owner's Claude Design, batch 5 §8.3): the journals it
// booked, for the Books line and the trail. Read from the ledger, never
// assumed — the Books line names the accounts the entry actually hit.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { fmtSen } from '../../../vendor/shared/format';
import type { DebtorReceipt, OtherDebtor } from '../../../vendor/scm/lib/accounting-queries';

export type DocJournalLine = {
  line_no: number; account_code: string; debit_sen: number; credit_sen: number; party_name: string | null; notes: string | null;
};
export type DocJournal = {
  id: string; je_no: string; entry_date: string; source_type: string; reversed: boolean; created_at: string;
  lines?: DocJournalLine[];
};
export type DocJournals = { booked: DocJournal[]; contras: DocJournal[] };

/** The entries a document booked under its source type (an edit re-posts, so
 *  there may be several) and the contras that reversed them (`<type>_REVERSAL`,
 *  the same document number). Keyed under 'journal-entries' so every write that
 *  refreshes the journal refreshes this too. */
export const useDocJournals = (sourceType: string, docNo: string | null | undefined) => useQuery({
  queryKey: ['journal-entries', 'document', sourceType, docNo ?? null],
  enabled: Boolean(docNo),
  queryFn: async (): Promise<DocJournals> => {
    const read = (type: string) => authedFetch<{ journalEntries: DocJournal[] }>(
      `/accounting/journal-entries?sourceType=${encodeURIComponent(type)}&sourceDocNo=${encodeURIComponent(String(docNo))}&withLines=1`,
    );
    const [booked, contras] = await Promise.all([read(sourceType), read(`${sourceType}_REVERSAL`)]);
    return { booked: booked.journalEntries, contras: contras.journalEntries };
  },
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** The entry that stands: the newest one not reversed. */
export const liveJournal = (j: DocJournals | undefined): DocJournal | null =>
  j?.booked.filter((e) => !e.reversed).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;

type Named = (code: string) => string | null;
const side = (lines: DocJournalLine[], dr: boolean, named: Named): string => {
  const seen = new Map<string, string>();
  for (const l of lines) {
    if ((dr ? l.debit_sen : l.credit_sen) <= 0 || seen.has(l.account_code)) continue;
    const name = named(l.account_code);
    seen.set(l.account_code, `${l.account_code}${name ? ` ${name}` : ''}${l.party_name ? ` (${l.party_name})` : ''}`);
  }
  return [...seen.values()].join(', ') || '—';
};

/** The Books line of a posted document: `Dr … · Cr … · RM x`, from its journal. */
export function booksSentence(je: DocJournal, named: Named): string {
  const lines = je.lines ?? [];
  const total = lines.reduce((s, l) => s + Number(l.debit_sen), 0);
  return `Dr ${side(lines, true, named)} · Cr ${side(lines, false, named)} · ${fmtSen(total)}`;
}

/* ── The receipts' pages (batch 5 §8.3 c7, c4) ────────────────────────────── */

export type OfficialReceiptRow = {
  id: number; or_number: string; status: string; payment_source: string; payment_id: string; doc_no: string | null;
  customer_name: string | null; method: string | null; amount_sen: number; paid_at: string | null; channel_account_code: string | null;
  issued_at: string | null; issued_by: string | null; created_at: string; created_by: string | null;
  cancelled_at: string | null; cancelled_by: string | null; cancel_reason: string | null; replaced_by_id: number | null;
  /** RECEIVED FROM on the print — the order's phone and address (owner 2026-11-09: 为甚没有name 这些). */
  phone?: string | null; address_lines?: string[];
};
type ReceiptRef = { id: number; orNumber: string; status: string };
export type OfficialReceiptDetail = {
  receipt: OfficialReceiptRow;
  replacedBy: ReceiptRef | null;
  replaces: ReceiptRef | null;
  paymentJournal: { id: string; jeNo: string; reversed: boolean } | null;
  /** What the payment says now; null when it was deleted. */
  payment: { amountSen: number; paidAt: string | null; method: string | null; soDocNo: string | null; salesInvoiceId: string | null } | null;
  salesOrder: string | null;
  salesInvoice: { id: string; number: string } | null;
  salesperson: string | null;
};

/** One official receipt with its replacement, its payment and that payment's
 *  journal (GET /accounting/receipts/:id). Under 'official-receipts', so the
 *  list's refreshes reach it. */
export const useOfficialReceipt = (id: string | null) => useQuery({
  queryKey: ['official-receipts', 'detail', id],
  enabled: Boolean(id),
  queryFn: () => authedFetch<OfficialReceiptDetail>(`/accounting/receipts/${encodeURIComponent(String(id))}`),
  staleTime: 0,
  retry: retryUnlessClientError,
});

/** Confirm money, one receipt: the draft turns formal and takes its official
 *  number (no journal; the payment posted). Receipts' batch calls it in
 *  payment-date order and refreshes once at the end. */
export const formaliseReceiptRequest = (id: number) =>
  authedFetch<{ ok: boolean; orNumber: string; already?: boolean }>(`/accounting/receipts/${id}/formalise`, { method: 'POST', body: '{}' });

/** Confirm money: the draft turns formal and takes its official number — the
 *  same door as the Receipts list (no journal; the payment posted). */
export const useFormaliseReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: formaliseReceiptRequest,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['official-receipts'] });
      void qc.invalidateQueries({ queryKey: ['official-receipts-check'] });
      /* To do's transfers job counts the draft non-card receipts. */
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
  });
};

/** The official receipts of a month by their payment day ('' = the whole book,
 *  newest first — c2), for Money in › Receipts. Under 'official-receipts', so a
 *  formalise, an ensure or a payment's edit refreshes it. */
export const useOfficialReceipts = <R>(month: string, enabled: boolean) => useQuery({
  queryKey: ['official-receipts', 'list', month || 'all'],
  enabled,
  queryFn: () => authedFetch<{ receipts: R[] }>(`/accounting/receipts?${month ? `month=${encodeURIComponent(month)}` : 'all=1'}`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** One month of customer payments against its official receipts (owner
 *  2026-09-16: or 我如何查看 amount 是对的) — the totals, the difference and every
 *  row behind it (GET /accounting/receipts/check). */
export type ReceiptsCheck = {
  month: string;
  payments: { count: number; totalSen: number };
  receipts: { count: number; totalSen: number };
  diffSen: number;
  missing: Array<{ source: string; paymentId: string; docNo: string | null; paidAt: string; method: string; amountSen: number }>;
  mismatched: Array<{ orNumber: string; source: string; paymentId: string; docNo: string | null; paidAt: string; receiptSen: number; paymentSen: number }>;
  orphans: Array<{ orNumber: string; docNo: string | null; paidAt: string; amountSen: number }>;
};
export const useReceiptsCheck = (month: string, enabled: boolean) => useQuery({
  queryKey: ['official-receipts-check', month],
  enabled: enabled && Boolean(month),
  queryFn: () => authedFetch<ReceiptsCheck>(`/accounting/receipts/check?month=${encodeURIComponent(month)}`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** Issue receipt (the month check's `Payments without a receipt`): find or make
 *  the receipt for one payment — the print button's own door, nothing posts. A
 *  cash payment's comes back formal at once. */
export const useEnsureReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { source: string; paymentId: string }) =>
      authedFetch<{ receipt: OfficialReceiptRow }>('/accounting/receipts/ensure', { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['official-receipts'] });
      void qc.invalidateQueries({ queryKey: ['official-receipts-check'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
  });
};

export type DebtorReceiptAllocation = {
  billId: string; amountSen: number; billNumber: string | null; billDate: string | null; description: string | null;
  totalSen: number | null; receivedSen: number | null; status: string | null; docKind: 'INV' | 'DN';
};
export type DebtorReceiptDetail = {
  receipt: DebtorReceipt & { debtor_id: string; created_at?: string | null; created_by?: string | null };
  debtor: OtherDebtor | null;
  allocations: DebtorReceiptAllocation[];
};

/** One debtor receipt with its debtor and the bills it knocks off
 *  (GET /other-debtors/receipts/:id). Under 'other-debtor-detail', so every
 *  debtor write (the four layers, void) refreshes it. */
export const useDebtorReceipt = (id: string | null) => useQuery({
  queryKey: ['other-debtor-detail', 'receipt', id],
  enabled: Boolean(id),
  queryFn: () => authedFetch<DebtorReceiptDetail>(`/other-debtors/receipts/${encodeURIComponent(String(id))}`),
  staleTime: 0,
  retry: retryUnlessClientError,
});
