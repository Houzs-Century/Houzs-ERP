/* ----------------------------------------------------------------------------
   rowMenu — one SHAPE for every list's right-click menu.

   THE OWNER'S ASK (2026-08-21): 「我要做成 right click 的功能，就是可以 convert
   等等。那一些 button 要做成 right click 的」 — and, on the destination:
   「人家他们点了跳入的页面是跟正常 transfer to 的页面等等一样？」

   Yes, and it is guaranteed rather than promised: every transfer entry goes
   through `convertToLink(pair, keys)`, and `convertScope.test.tsx` walks the
   whole source tree and FAILS on any site that hand-writes a query onto a
   convert path. A right-click entry structurally cannot land somewhere the
   button would not.

   WHY A BUILDER AND NOT FIVE HAND-WRITTEN ARRAYS. Five lists were about to
   grow the same menu on the same day, and this repo has spent that day undoing
   exactly that: five copies of `brandTone` that had split into three spellings,
   sixteen copies of a status label, one status rule written as a deny-list on
   the server and an allow-list on the client. A menu assembled by hand five
   times is the next one. The builder also removes the whole class of divider
   bugs — a leading separator, a trailing one, two in a row when a group is
   empty because the row's status does not qualify.

   THE ORDER IS THE RULE, and it is the same on every list:

       open / edit / print          what you do WITH this document
       ──────────
       transfer to …                what you make FROM it
       ──────────
       status changes               what you do TO it
       ──────────
       cancel                       destructive, alone, last, red

   Cancel sits alone at the bottom for the reason every desktop application
   puts it there: the item you must not hit by accident is the one furthest
   from where the pointer lands.
   ---------------------------------------------------------------------------- */

/** One entry, matching DataTable's `contextMenu` item exactly. */
export type RowMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  divider?: boolean;
};

/** An entry, or nothing. `null` / `false` / `undefined` mean "this row does not
 *  qualify" — so a caller writes `cond && item` inline instead of building an
 *  array with `if`s, and an absent item leaves no gap behind it. */
export type MaybeItem = RowMenuItem | null | false | undefined;

const DIVIDER: RowMenuItem = { label: "", onClick: () => {}, divider: true };

/**
 * Assemble the groups into one menu, separated by dividers.
 *
 * EMPTY GROUPS VANISH, and that is the whole point: a DRAFT sales order has no
 * transfer and no status change, so it must not render two separators over
 * nothing. Pass every group unconditionally and let the row's own predicates
 * empty the ones that do not apply.
 *
 * The result is never a menu of one divider and never starts or ends with one.
 */
export function buildRowMenu(...groups: MaybeItem[][]): RowMenuItem[] {
  const kept = groups
    .map((g) => g.filter((i): i is RowMenuItem => !!i))
    .filter((g) => g.length > 0);
  return kept.flatMap((g, i) => (i === 0 ? g : [DIVIDER, ...g]));
}

/** The destructive entry, so `danger` is never forgotten on the one item where
 *  forgetting it makes a red action look like an ordinary one. */
export function dangerItem(label: string, onClick: () => void): RowMenuItem {
  return { label, onClick, danger: true };
}
