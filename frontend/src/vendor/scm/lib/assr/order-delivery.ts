// ----------------------------------------------------------------------------
// assr/order-delivery — the ORDER's DO No + Delivery Date shown on the Customer
// card (owner 2026-09-28). One reader for desktop (ServiceCases.tsx) and mobile
// (MobileServiceCase.tsx / MobileMyCaseDetail.tsx) so the three cannot disagree.
// NO React, no I/O — same contract as ./stages.
//
// `order_dos` is the detail route's enrichment (backend services/assrOrderDos.ts).
// It is NOT `do_date`: that column is the SERVICE delivery leg's date.
// ----------------------------------------------------------------------------

export interface AssrOrderDo {
  do_number: string;
  delivery_date: string | null;
}

export interface OrderDelivery {
  doNo: string | null;
  /** yyyy-mm-dd of the most recent delivery among the order's DOs. */
  deliveryDate: string | null;
}

export function orderDeliveryOf(c: Record<string, unknown> | null | undefined): OrderDelivery {
  const raw = c?.order_dos ?? c?.orderDos;
  const dos = Array.isArray(raw) ? (raw as AssrOrderDo[]).filter((d) => d && d.do_number) : [];
  const fallback = String(c?.delivery_order || c?.deliveryOrder || c?.do_numbers || c?.doNumbers || "").trim();
  const doNo = dos.length ? dos.map((d) => d.do_number).join(" · ") : fallback || null;
  const dates = dos.map((d) => d.delivery_date).filter((d): d is string => !!d).sort();
  return { doNo, deliveryDate: dates.length ? dates[dates.length - 1] : null };
}
