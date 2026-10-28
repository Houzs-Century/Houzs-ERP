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
 * over its size ceiling. It is also the ONE place this rule is written, so both
 * surfaces import it rather than keeping a second hand-written copy of "42 days,
 * but not the past".
 *
 * MOBILE JOINED ON 2026-09-09, and the paragraph above used to end "mobile does
 * not derive a Processing Date at all … if that ever becomes a shared
 * affordance, this is the module both surfaces import". It became one: a rep
 * reported 「那个日期 proceed date 之前是有 auto detect 的，现在的需要自己填」
 * (`docs/bugs/0755-*`). Desktop had always derived it; mobile's field is seeded
 * from a scan path no call site supplies, so it was always blank and always
 * typed by hand — a rule built on one surface only, which is the class CLAUDE.md
 * names as recurring.
 *
 * Both callers fire this from the DELIVERY date's onChange, and both apply the
 * same two limits, which are the reason this is a courtesy and not a policy:
 *   · it fills a BLANK Processing Date only. A date already on the order, or one
 *     the rep just typed, is theirs and is not overwritten.
 *   · CLEARING Delivery leaves Processing alone. Each field has its own Clear
 *     control, and the both-or-neither pairing is a SERVER save gate
 *     (`processing_delivery_must_pair`) that names the problem — guessing here
 *     would only make the refusal harder to read.
 */
export const deriveProcessingDate = (deliveryDate: string): string => {
  const today = todayMyt();
  const d = new Date(`${deliveryDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return today;
  d.setDate(d.getDate() - PROCESSING_LEAD_DAYS);
  const lead = d.toLocaleDateString('en-CA');
  return lead < today ? today : lead;
};
