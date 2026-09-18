// ----------------------------------------------------------------------------
// so-list-approval-codes — the Sales Order list's "Approval Code" column and
// the search behind it (owner 2026-09-15, docs/bugs/0909: sales order 这边我可以
// 加一个 column 是显示 approval code 的吗 … 我要的就是这个 payment 的 approval code).
//
// The code lives on each PAYMENT (mfg_sales_order_payments.approval_code —
// the value the SO detail's Payments card prints), never on the order header,
// whose legacy approval_code is the New-SO form's single field. An order with
// several card payments shows every code, in the order the money was paid,
// joined " + " the way the Payment Method column joins its methods.
//
// Two halves, both pure: what a page of payment rows becomes per order, and
// the one `.or()` term that lets the list's free-text search find an order by
// a code — a term that must be added to BOTH the page query and the money-KPI
// aggregate, which have to filter the same set (docs/modules/sales-order.md,
// docs/bugs/0755).
// ----------------------------------------------------------------------------

export type PaymentCodeRow = {
  so_doc_no: string;
  approval_code?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
};

const codeOf = (r: PaymentCodeRow): string => String(r.approval_code ?? '').trim();

/** Per order: the approval codes of its payments, by payment date (then by
    the moment they were keyed), joined " + ". Payments with no code — cash,
    online — contribute nothing; an order with none is absent from the map. */
export function approvalCodesByOrder(rows: ReadonlyArray<PaymentCodeRow>): Map<string, string> {
  const byDoc = new Map<string, PaymentCodeRow[]>();
  for (const r of rows) {
    if (!codeOf(r)) continue;
    const list = byDoc.get(r.so_doc_no) ?? [];
    list.push(r);
    byDoc.set(r.so_doc_no, list);
  }
  const out = new Map<string, string>();
  for (const [doc, list] of byDoc) {
    const ordered = [...list].sort((a, b) =>
      String(a.paid_at ?? '').localeCompare(String(b.paid_at ?? ''))
      || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    out.set(doc, ordered.map(codeOf).join(' + '));
  }
  return out;
}

/** How many orders a code search may admit at once — one URL carries the
    doc numbers (the list's chunked reads carry 500 without trouble). */
export const APPROVAL_CODE_SEARCH_CAP = 500;

/** The `.or()` term admitting the orders whose payments carried the searched
    code: `doc_no.in.("A","B")`. Null when no payment matched — an empty
    in-list is a PostgREST syntax error, and a term that admits nothing must
    not be sent at all. Doc numbers are double-quoted, which is how PostgREST
    takes a value inside an in-list, and de-duplicated: several payments on
    one order are one order. */
export function approvalCodeOrPart(docNos: ReadonlyArray<string>): string | null {
  const unique = [...new Set(docNos.map((d) => String(d ?? '').trim()).filter((d) => d !== ''))];
  if (unique.length === 0) return null;
  return `doc_no.in.(${unique.map((d) => `"${d.replace(/"/g, '')}"`).join(',')})`;
}
