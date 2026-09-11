// ----------------------------------------------------------------------------
// The header -> line delivery-date cascade, in ONE place.
//
// The owner's rule, stated twice in one day: 「我开 DO 之前我改 SO 就行 …… 当我开
// DO 的时候，你就跟着 default 这个 date 来开」 and, looking at a delivery order
// whose header read 24/09 while all ten of its lines read 19/09,
// 「如果我上面customer delivery date 更改下面不能自动跟吗」.
//
// One date is edited — the header's — and every line follows, EXCEPT a line
// somebody typed on purpose. That exception is what makes this a rule rather
// than an assignment, and it is the half a hand-written copy forgets.
//
// WHY IT IS A MODULE. The same effect was written inline in SalesOrderNew
// (PR-E) and NOT in DeliveryOrderNewV2, which is exactly how the owner found
// it: the sales order followed and the delivery order did not, on a screen that
// looks the same. Meanwhile DeliveryOrderNewV2's own payload builder carried a
// comment promising "a header-change cascade skips lines they typed by hand"
// since 0807 — describing a cascade that did not exist on that page. A rule
// hand-copied per form is a rule that will disagree with itself; both forms now
// call in here. Enumerate the callers rather than trusting a count written
// here:
//   grep -rl "lib/line-delivery-date-cascade" frontend/src
//
// RETURNS null WHEN NOTHING MOVES, on purpose. Both callers run this inside a
// `setLines(prev => ...)` in a `useEffect`, so returning a fresh array every
// render would re-render the whole line list — and, where a line card holds
// staged File uploads, remount it. `null` means "keep the array you have".
// ----------------------------------------------------------------------------

/** The only two fields the cascade reads or writes. */
export interface CascadableLine {
  lineDeliveryDate?: string | null;
  lineDeliveryDateOverridden?: boolean;
}

/**
 * Push `headerDate` onto every line that is still following the header.
 *
 * A line with `lineDeliveryDateOverridden` is never moved — SoLineCard sets
 * that flag the moment its own date field is edited, so "the operator typed
 * this one" is a stored fact and not a guess.
 *
 * @param lines      the current draft lines
 * @param headerDate the header's delivery date, ISO `YYYY-MM-DD`; `''`/null
 *                   both mean "no date", and CLEARING the header does clear the
 *                   followers. That is deliberate: the alternative leaves lines
 *                   holding a date the document no longer claims.
 * @returns a new array, or `null` when no line changed.
 */
export function cascadeLineDeliveryDate<T extends CascadableLine>(
  lines: readonly T[],
  headerDate: string | null | undefined,
): T[] | null {
  const target = headerDate || null;
  const next = lines.map((l) => {
    if (l.lineDeliveryDateOverridden) return l;
    if ((l.lineDeliveryDate ?? null) === target) return l;
    return { ...l, lineDeliveryDate: target };
  });
  /* "Did anything move" is asked by IDENTITY, not by a flag the map sets. The
     flag version is what the two inline copies used, and the linter is right to
     call it out: TypeScript cannot see that a `.map` callback runs, so it
     narrows the flag to `false` and the ternary reads as dead. Identity says the
     same thing, and says it in a way the compiler can follow. */
  return next.some((l, i) => l !== lines[i]) ? next : null;
}
