/* Spreadsheet-style arrow keys on every document's line editor (owner
 * 2026-10-06: "全系统都需要这样，可以上下左右" — typing a count, then reaching for
 * the mouse to get to the next line's Qty, on every line).
 *
 * ONE document-level listener, installed once by <LineGridNav/> in App, so a
 * page gets it without wiring anything:
 *   - a TABLE line editor (<tbody><tr><td>) works as-is — the column is the
 *     cell's visual column;
 *   - a CARD line editor (SO / PO / GRN / PI / PV cards) marks each line's root
 *     `data-grid-row`; the column is the field's `data-grid-col`, else its
 *     label text, else its aria-label with the line number taken out.
 *   - `data-grid-off` on any ancestor switches it off for that subtree.
 *
 * Keys and what they leave alone:
 *   Up/Down     next / previous line, same column; the content is selected so a
 *               typed number replaces it. A native <select> moves too (open it
 *               with Space / Alt+Down, or type a letter); a number input stops
 *               stepping. NOT taken from a datalist input (the browser walks its
 *               suggestions with them), a <textarea>, an open combobox
 *               (aria-expanded="true"), or a key a component already handled
 *               (defaultPrevented — SearchCombo's own list).
 *   Left/Right  previous / next field on the same line, only once the caret is
 *               already at the start / end of the text, so editing still moves
 *               the caret.
 *   Any modifier (Shift / Ctrl / Alt / Meta) → untouched.
 */

const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="color"])',
  'select',
  'textarea',
].join(', ');

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const isField = (el: EventTarget | null): el is Field =>
  el instanceof HTMLElement && el.matches(FIELD_SELECTOR);

const usable = (el: Element): el is Field =>
  isField(el) && !el.disabled && !el.closest('[hidden], [data-grid-off]');

const fieldsIn = (root: Element): Field[] =>
  Array.from(root.querySelectorAll(FIELD_SELECTOR)).filter(usable);

/* ── Where the focused field sits ─────────────────────────────────────── */

type Spot =
  | { kind: 'table'; row: HTMLTableRowElement; col: number; span: number; within: number }
  | { kind: 'card'; row: HTMLElement; key: string; index: number };

/** A cell's visual column: the col-spans of the cells before it, summed. */
const visualCol = (cell: HTMLTableCellElement): number => {
  let col = 0;
  for (let c = cell.previousElementSibling; c; c = c.previousElementSibling) {
    col += (c as HTMLTableCellElement).colSpan || 1;
  }
  return col;
};

const cellAtCol = (row: HTMLTableRowElement, col: number): HTMLTableCellElement | null => {
  let at = 0;
  for (const cell of Array.from(row.cells)) {
    const span = cell.colSpan || 1;
    if (col >= at && col < at + span) return cell;
    at += span;
  }
  return null;
};

const labelOf = (el: Field): string | null => {
  const label = el.closest('label');
  const text = label?.querySelector('span')?.textContent.trim();
  return text ? `label:${text}` : null;
};

/** A card field's column identity — the same field on another line has the same key. */
export const cardColumnKey = (el: Field, row: Element): string => {
  const tagged = el.closest('[data-grid-col]');
  if (tagged && row.contains(tagged)) return `col:${tagged.getAttribute('data-grid-col') ?? ''}`;
  const label = labelOf(el);
  if (label) return label;
  const aria = el.getAttribute('aria-label');
  // "Line 3 debit" and "Line 4 debit" are one column: drop the line number.
  if (aria) return `aria:${aria.replace(/\d+/g, '#')}`;
  return `idx:${fieldsIn(row).indexOf(el)}`;
};

const spotOf = (el: Field): Spot | null => {
  if (el.closest('[data-grid-off]')) return null;
  const card = el.closest<HTMLElement>('[data-grid-row]');
  if (card) {
    return { kind: 'card', row: card, key: cardColumnKey(el, card), index: fieldsIn(card).indexOf(el) };
  }
  const cell = el.closest('td');
  const row = cell?.parentElement;
  if (!cell || !(row instanceof HTMLTableRowElement) || row.parentElement?.tagName !== 'TBODY') return null;
  const inCell = fieldsIn(cell);
  return { kind: 'table', row, col: visualCol(cell), span: cell.colSpan || 1, within: Math.max(0, inCell.indexOf(el)) };
};

/* ── Finding the destination ──────────────────────────────────────────── */

const verticalTarget = (spot: Spot, dir: 1 | -1): Field | null => {
  if (spot.kind === 'table') {
    const rows = Array.from((spot.row.parentElement as HTMLTableSectionElement).rows);
    for (let i = rows.indexOf(spot.row) + dir; i >= 0 && i < rows.length; i += dir) {
      const cell = cellAtCol(rows[i]!, spot.col);
      // A full-width detail row (one cell spanning the table) is not this column.
      if (!cell || (cell.colSpan || 1) !== spot.span) continue;
      const fields = fieldsIn(cell);
      if (fields.length) return fields[Math.min(spot.within, fields.length - 1)]!;
    }
    return null;
  }
  // Card lines: every top-level line root on the page, in reading order.
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-grid-row]'))
    .filter((r) => !r.parentElement?.closest('[data-grid-row]'));
  for (let i = rows.indexOf(spot.row) + dir; i >= 0 && i < rows.length; i += dir) {
    const fields = fieldsIn(rows[i]!);
    const same = fields.find((f) => cardColumnKey(f, rows[i]!) === spot.key);
    if (same) return same;
    if (spot.key.startsWith('idx:') && fields[spot.index]) return fields[spot.index]!;
  }
  return null;
};

const horizontalTarget = (el: Field, spot: Spot, dir: 1 | -1): Field | null => {
  const fields = fieldsIn(spot.row);
  const at = fields.indexOf(el);
  return at < 0 ? null : fields[at + dir] ?? null;
};

/* ── Key policy ───────────────────────────────────────────────────────── */

const TEXTLIKE = new Set(['text', 'search', 'tel', 'url', 'email', 'password', '']);

/** The caret can still move that way inside the field, so the key is the field's. */
const caretCanMove = (el: Field, dir: 1 | -1): boolean => {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if (el instanceof HTMLInputElement && !TEXTLIKE.has(el.type)) return false;
  const { selectionStart: start, selectionEnd: end } = el;
  if (start == null || end == null) return false;
  if (start !== end) return true; // a selection: let the key collapse it
  return dir < 0 ? start > 0 : end < el.value.length;
};

const keepsVerticalKeys = (el: Field): boolean =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && el.hasAttribute('list')) ||
  el.getAttribute('aria-expanded') === 'true';

const focusField = (el: Field) => {
  el.focus();
  if (el instanceof HTMLInputElement && TEXTLIKE.has(el.type)) {
    try { el.select(); } catch { /* not selectable — focus is enough */ }
  } else if (el instanceof HTMLInputElement && el.type === 'number') {
    try { el.select(); } catch { /* number inputs may refuse select() */ }
  }
};

/** The whole decision for one keydown. Returns true when it moved focus. */
export const handleLineGridKey = (e: KeyboardEvent): boolean => {
  if (e.defaultPrevented || e.isComposing) return false;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (!vertical && !horizontal) return false;
  const el = e.target;
  if (!isField(el)) return false;
  if (el instanceof HTMLInputElement && el.type === 'checkbox' && horizontal) return false;

  const spot = spotOf(el);
  if (!spot) return false;
  const dir: 1 | -1 = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;

  let dest: Field | null;
  if (vertical) {
    if (keepsVerticalKeys(el)) return false;
    dest = verticalTarget(spot, dir);
  } else {
    if (caretCanMove(el, dir)) return false;
    dest = horizontalTarget(el, spot, dir);
  }

  // In a grid a select / number input never changes value on an arrow key,
  // even at the edge with nowhere to go — that silent change was the trap.
  const ownsArrows = el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === 'number');
  if (!dest) {
    if (ownsArrows) e.preventDefault();
    return false;
  }
  e.preventDefault();
  focusField(dest);
  return true;
};

export const installLineGridNav = (doc: Document = document): (() => void) => {
  // Bubble phase: a component's own handler (an open picker) runs first and
  // can claim the key with preventDefault.
  const onKey = (e: KeyboardEvent) => { handleLineGridKey(e); };
  doc.addEventListener('keydown', onKey);
  return () => doc.removeEventListener('keydown', onKey);
};
