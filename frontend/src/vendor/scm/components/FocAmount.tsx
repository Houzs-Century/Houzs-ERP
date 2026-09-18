/* FocAmount — the Amount cell of a document line, showing FOC where the line
   charges nothing.

   Owner 2026-09-12: the free-of-charge marker belongs on every document, not
   just the sales side. The sales order, delivery order and sales invoice carry
   it in their Discount column, which those three have and the purchase side does
   not: `purchase_order_items`, `grn_items` and `purchase_invoice_items` all
   store a discount, but none of the three detail grids reads it, and widening
   three row types and three selects to print a column nobody asked for is not
   what was asked for.

   So on the purchase side the badge goes where the reader's question already
   is. "Did we pay for this?" is asked at the Amount cell, and RM 0.00 there is
   exactly the line that needs a word: a supplier freebie, a replacement sent at
   no charge, a sample. An amount of zero printed as money reads as a data
   problem; FOC reads as a fact.

   The rule is NOT re-derived here. `isFocLine` is the one answer every surface
   uses (vendor/scm/lib/foc-line.ts), written because four surfaces had grown
   four different ones and the same line read FOC on the delivery order and Sale
   on the invoice for the same goods. */

import type { ReactNode } from 'react';
import { Badge } from '../../../components/Badge';
import { isFocLine, type FocLineInput } from '../lib/foc-line';

export type FocAmountProps = {
  line: FocLineInput;
  /* The money already formatted by the host page, because each page formats in
     its OWN document currency and this component must not guess which. */
  amount: ReactNode;
  /* Rendered under the amount when the line is NOT free — the goods receipt
     prints its allocated freight there. Omitted on a free line: a freebie that
     carries allocated freight still cost nothing to BUY, which is what the
     badge claims. */
  sub?: ReactNode;
};

export function FocAmount({ line, amount, sub }: FocAmountProps) {
  if (isFocLine(line)) {
    return (
      <Badge tone="warning" size="xs">
        FOC
      </Badge>
    );
  }
  if (sub) {
    return (
      <span className="inline-flex flex-col items-end">
        <span className="font-money text-[13px] font-semibold text-ink">{amount}</span>
        {sub}
      </span>
    );
  }
  return <span className="font-money text-[13px] font-semibold text-ink">{amount}</span>;
}
