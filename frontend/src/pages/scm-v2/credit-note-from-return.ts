/* A new customer credit note filled from a delivery return (backlog A1): the
   customer's order, the return's number as the reference, and one line per
   returned line still uncredited, priced at what the invoice charged — never
   the SKU's list price. The server holds every line to the same rule. */

import type { ReturnCreditLine, ReturnCreditPrefill } from '../../vendor/scm/lib/credit-note-queries';
import { emptyForm, type FormValues } from './CreditNotes';

const creditable = (l: ReturnCreditLine): boolean => l.unitSen !== null && l.remainingQty > 0;

export function fromReturnValues(p: ReturnCreditPrefill): FormValues {
  const base = emptyForm('CN');
  const lines = p.lines.filter(creditable).map((l, i) => ({
    rid: i + 1,
    description: [l.itemCode, l.description].filter(Boolean).join(' ').toUpperCase(),
    accountCode: '',
    amountRm: ((l.capSen ?? 0) / 100).toFixed(2),
    projectId: null,
    ret: { itemId: l.returnItemId, qty: l.remainingQty, maxQty: l.remainingQty, unitSen: l.unitSen },
  }));
  return {
    ...base,
    soDocNo: p.soDocNo ?? '',
    partyName: p.soDocNo ? '' : p.deliveryReturn.customer ?? '',
    sourceDocNo: p.deliveryReturn.returnNumber,
    reason: `GOODS RETURNED ${p.deliveryReturn.returnNumber}`,
    lines: lines.length > 0 ? lines : base.lines,
    deliveryReturnId: p.deliveryReturn.id,
    returnNumber: p.deliveryReturn.returnNumber,
    invoiceNumber: p.invoice?.number ?? null,
  };
}

/** Why the return has nothing left to credit, in the words the page shows — null when it has. */
export function nothingToCredit(p: ReturnCreditPrefill): string | null {
  const no = p.deliveryReturn.returnNumber;
  if (String(p.deliveryReturn.status).toUpperCase() === 'CANCELLED') return `${no} is cancelled — nothing came back to credit.`;
  if (p.lines.some(creditable)) return null;
  if (p.lines.every((l) => l.unitSen === null)) return `${no}'s goods were never invoiced, so no credit note is needed.`;
  return `Every invoiced unit of ${no} is already on a credit note${p.notes.length > 0 ? ` (${p.notes.map((n) => n.number).join(', ')})` : ''}.`;
}

/** Returned lines left off the note, and why — shown under the banner. */
export function skippedReturnLines(p: ReturnCreditPrefill): string[] {
  return p.lines.filter((l) => !creditable(l)).map((l) => {
    const name = l.itemCode ?? l.description ?? 'A line';
    return l.unitSen === null ? `${name}: never invoiced` : `${name}: all ${l.qtyReturned} already credited`;
  });
}
