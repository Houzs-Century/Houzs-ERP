/* "Add line" — the handoff from a document's DETAIL page to its EDITOR's add row.
 *
 * Owner, 2026-09-13, on a goods receipt converted from a purchase order:
 * 「我用 convert 过来，怎么我不能用 manually 加？这个也是扩散到全部地方了吗？」
 *
 * He could. Measured on staging the same day: the goods receipt's detail page
 * offers GRNs / History / Print PDF / Cancel / Transfer, and NOTHING about
 * adding a line. Press Edit — which reads as "change what is here", not "add
 * something" — and a button called **"Add manual item"** appears at the bottom
 * of the line list. So the feature was there and unfindable, which for the
 * person using it is the same as absent.
 *
 * And it HAD spread: every V2 detail page forwards `?edit=1` to a separate
 * editor, and each editor named the affordance differently — "Add manual item"
 * on the goods receipt, "Add item" on the purchase invoice and the purchase
 * order, "+ Add Line Item" on the sales order. Four names for one action, none
 * of them visible from the page you start on.
 *
 * THIS MODULE IS THE CONTRACT, not the button. The detail page sends the
 * operator to the editor with `#add-line` on the URL; the editor opens its add
 * row and scrolls to it. A hash rather than a query parameter on purpose: it is
 * a one-shot INTENT, not page state, so it must not survive a reload or be
 * restored by the back button into a form that is already open.
 */

/** The fragment a detail page appends to hand the operator to the add row. */
export const ADD_LINE_HASH = '#add-line';

/** The ONE name for this action. Four pages spelled it four ways. */
export const ADD_LINE_LABEL = 'Add line';

/**
 * The editor URL that opens straight at the add row.
 *
 * `base` is the document's own path (`/scm/grns/<id>`). Any existing query is
 * kept, because a detail page can carry one (a tab, a return-to) and dropping
 * it would lose the operator's place.
 */
export const addLineHref = (base: string): string => {
  const [path, query = ''] = base.split('#')[0].split('?');
  const params = new URLSearchParams(query);
  params.set('edit', '1');
  return `${path}?${params.toString()}${ADD_LINE_HASH}`;
};

/**
 * Does this location ask the editor to open its add row?
 *
 * Accepts a full location string or just the hash, so a caller can pass
 * `window.location.hash` or react-router's `location`.
 */
export const wantsAddLine = (location: string | null | undefined): boolean => {
  const s = String(location ?? '');
  const at = s.indexOf('#');
  const hash = at === -1 ? (s.startsWith('#') ? s : '') : s.slice(at);
  return hash === ADD_LINE_HASH;
};

/**
 * Strip the fragment once the editor has acted on it.
 *
 * Returned as a path+query the caller can `replace()` into history. The intent
 * must be consumed: leaving it on the URL re-opens the add row every time the
 * component remounts, which on a page that remounts after a save is a form that
 * will not stay shut.
 */
export const consumedAddLine = (location: string): string => location.split('#')[0];
