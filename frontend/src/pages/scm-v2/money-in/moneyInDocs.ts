// ----------------------------------------------------------------------------
// moneyInDocs — where a Money-in document opens, and the list it belongs to
// (the owner's Claude Design, batch 5 §1 and §8). ONE home: every number on a
// Money-in page links through moneyInDocHref, so when a list folds into
// another (Official receipts into Receipts, Deposit invoices into Invoices)
// the links and the documents' Back move at once.
// ----------------------------------------------------------------------------

/** The Money-in documents that have a page of their own (§8.3). */
export type MoneyInDocKind =
  | 'official'        // an official receipt — one per customer payment
  | 'sundry'          // a sundry-income (general) receipt
  | 'debtorReceipt'   // an other debtor's receipt (ODR)
  | 'salesInvoice'    // a sales invoice, read from Sales
  | 'depositInvoice'  // a deposit invoice
  | 'debtorBill'      // an other debtor's bill or debit note
  | 'note'            // a customer or other-debtor credit / debit note
  | 'debtor';         // an other debtor in the registry

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
 *  receipts are Receipts' first kind since batch 5 step 4; deposit invoices
 *  keep their own list until it folds into Invoices (step 5). */
export const moneyInListOf = (kind: MoneyInDocKind): { href: string; label: string } => {
  switch (kind) {
    case 'official': return { href: '/scm/receipts?kind=official', label: 'Receipts' };
    case 'sundry':
    case 'debtorReceipt': return { href: '/scm/receipts', label: 'Receipts' };
    case 'depositInvoice': return { href: '/scm/deposit-invoices', label: 'Deposit invoices' };
    case 'salesInvoice':
    case 'debtorBill': return { href: '/scm/ar-invoices', label: 'AR invoices' };
    case 'note': return { href: '/scm/credit-notes', label: 'Credit / debit notes' };
    case 'debtor': return { href: '/scm/other-debtors', label: 'Debtor maintenance' };
  }
};
