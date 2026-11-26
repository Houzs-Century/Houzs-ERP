
/** The Money-in documents that have a page of their own (§8.3). */
export type MoneyInDocKind =
  | 'official'
  | 'sundry'
  | 'debtorReceipt'
  | 'salesInvoice'
  | 'depositInvoice'
  | 'debtorBill'
  | 'note'
  | 'debtor';

/** The document's page. */
export const moneyInDocHref = (kind: MoneyInDocKind, id: string | number): string => {
  const at = encodeURIComponent(String(id));
  switch (kind) {
    case 'official': return `/scm/receipts/official/${at}`;
    case 'sundry': return `/scm/receipts/sundry/${at}`;
    case 'debtorReceipt': return `/scm/receipts/debtor/${at}`;
    case 'salesInvoice': return `/scm/ar-invoices/sales/${at}`;
    case 'depositInvoice': return `/scm/ar-invoices/deposit/${at}`;
    case 'debtorBill': return `/scm/ar-invoices/bills/${at}`;
    case 'note': return `/scm/credit-notes/${at}`;
    case 'debtor': return `/scm/other-debtors/${at}`;
  }
};

/** The list a document's Back returns to when it was not opened from another
 *  page (an opened tab's opener wins — lib/useWorkspaceOpener). Official
 *  receipts are a kind of Receipts (batch 5 step 4), deposit invoices a kind
 *  of Invoices (step 5). */
export const moneyInListOf = (kind: MoneyInDocKind): { href: string; label: string } => {
  switch (kind) {
    case 'official': return { href: '/scm/receipts?kind=official', label: 'Receipts' };
    case 'sundry':
    case 'debtorReceipt': return { href: '/scm/receipts', label: 'Receipts' };
    case 'depositInvoice': return { href: '/scm/ar-invoices?kind=deposit', label: 'Invoices' };
    case 'salesInvoice':
    case 'debtorBill': return { href: '/scm/ar-invoices', label: 'Invoices' };
    case 'note': return { href: '/scm/credit-notes', label: 'Credit / debit notes' };
    case 'debtor': return { href: '/scm/other-debtors', label: 'Debtor maintenance' };
  }
};
