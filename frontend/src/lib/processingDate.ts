import { todayMyt } from '../vendor/scm/lib/dates';

/** Weeks of procurement lead time the Processing Date is meant to buy. */
export const PROCESSING_LEAD_DAYS = 42;

/**
 * Given a Delivery date, when procurement should start: `PROCESSING_LEAD_DAYS`
 * before delivery, but never before today — don't buy stock too soon, and never
 * author a past date. Returns a local YYYY-MM-DD in the same shape a
 * `<input type="date">` reads and writes.
 *
 * The caller only invokes this when a Delivery date exists. With no Delivery
 * date BOTH dates stay empty (the order is un-proceeded) — that pairing is a
 * SAVE GATE on the server (`processing_delivery_must_pair`), not a courtesy
 * here, so do not "helpfully" return a date for an empty input.
 *
 * An unparseable date returns today rather than throwing or returning NaN: the
 * input is a date picker, so the only way to reach that branch is a value the
 * form did not author, and a real date the operator can see and change beats an
 * empty field that silently fails the pairing gate on save.
 *
 * WHY IT LIVES HERE. It was a private const inside SalesOrderNew.tsx, which is
 * over its size ceiling. It is also the ONE place this rule is written: mobile
 * does not derive a Processing Date at all (its `procDate` is seeded from the
 * scanned slip and otherwise typed by hand), so if that ever becomes a shared
 * affordance, this is the module both surfaces import rather than the second
 * hand-written copy of "42 days, but not the past".
 */
export const deriveProcessingDate = (deliveryDate: string): string => {
  const today = todayMyt();
  const d = new Date(`${deliveryDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return today;
  d.setDate(d.getDate() - PROCESSING_LEAD_DAYS);
  const lead = d.toLocaleDateString('en-CA');
  return lead < today ? today : lead;
};
