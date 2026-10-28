// ----------------------------------------------------------------------------
// si-receipts — every sum received towards a sales invoice, as its printed
// "Payments received" list reads (owner 2026-10-06: the print called all of
// it "Deposit (<order>)", even money that paid the order in full).
//
// Two documents take a customer's money: the ORDER before the invoice
// (lib/si-order-deposit.ts serves its rows as `transactions`) and the INVOICE
// itself (`sales_invoice_payments`). Nothing here decides how much of the
// order's money belongs to this invoice — that is si-order-deposit's split
// rule, served as `so_deposit_applied_sen`. The print lists the rows only when
// they add up to exactly that, and falls back to one line per document when
// they do not (an order split over several invoices).
// ----------------------------------------------------------------------------

import type { OrderDepositForInvoice } from './si-order-deposit';

/** One sum received, as the printed invoice lists it. */
export type SiReceipt = { paid_at: string | null; method: string | null; amount_sen: number };
export type SiReceipts = { order: SiReceipt[]; invoice: SiReceipt[] };

type OwnRow = { paid_at?: string | null; method?: string | null; amount_sen?: number | string | null };

const byDay = (a: SiReceipt, b: SiReceipt): number => String(a.paid_at ?? '').localeCompare(String(b.paid_at ?? ''));

/** The order's rows and the invoice's own, oldest first. */
export function invoiceReceipts(deposit: OrderDepositForInvoice | null, own: readonly OwnRow[]): SiReceipts {
  return {
    order: (deposit?.transactions ?? [])
      .map((t) => ({ paid_at: t.paid_at, method: t.method, amount_sen: Number(t.amount_sen) }))
      .sort(byDay),
    invoice: own
      .map((p) => ({ paid_at: p.paid_at ?? null, method: p.method ?? null, amount_sen: Number(p.amount_sen ?? 0) }))
      .sort(byDay),
  };
}
