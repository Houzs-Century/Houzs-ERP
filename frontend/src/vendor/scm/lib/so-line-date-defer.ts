/* A line's delivery date that the HEADER save will stamp — so the line write
   must not carry it.

   BUG-39 (#4361, 2026-09-30) refuses a line delivery date while the order has
   no STORED Processing Date (`soLineDateRefusal`). The phone editor writes the
   lines BEFORE the header, and it copies the header Delivery Date onto every
   line the operator has not hand-edited. So a save that PROCEEDS the order —
   Processing + Delivery Date filled in the same save — sent each line its new
   date while the stored Processing Date was still empty, and every line was
   refused ("2 lines could not be saved — Set the Processing Date first").

   Such a date needs no line write at all: the header PATCH's server cascade
   (`apply_so_header_cas`, p_apply_delivery_date) stamps every line's date once
   the Processing Date is on the order. Desktop already skips these lines
   (SalesOrderDetail `lineEntries`, 2990 PR #718); this is the phone's copy of
   the rule. A HAND-EDITED line date is the operator's own and is still sent. */

/** True when this line's date is the header cascade's to write, not the line write's. */
export function deferLineDateToHeader(i: { storedProcessingDate: string | null | undefined; overridden: boolean }): boolean {
  return (i.storedProcessingDate ?? '').trim() === '' && !i.overridden;
}

/** The line body without its delivery date, for a line whose date is deferred. */
export function withoutLineDate<T extends Record<string, unknown>>(body: T): Omit<T, 'lineDeliveryDate'> {
  const { lineDeliveryDate: _dropped, ...rest } = body;
  return rest;
}
