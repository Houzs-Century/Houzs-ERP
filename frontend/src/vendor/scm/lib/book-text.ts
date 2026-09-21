// stripBookText — hide the migrated AutoCount "账本原文" book text on the
// CUSTOMER-FACING PDFs, while it stays visible on the internal ERP screen.
//
// At go-live the AutoCount source line text was copied into each migrated
// sales-order line's `remark`, prefixed with the literal `账本原文:`
// (docs/modules/sales-order.md: "AutoCount's original line text lives in
// `remark` under `账本原文: `"). It is an internal migration artefact — useful
// to staff on the ERP screen, but not something a customer's printed copy
// should carry. So the customer PDFs run their line remark through this helper;
// the on-screen line display deliberately does NOT, keeping the book text
// visible internally.
//
// Verified on production 2026-09-20: the marker lives ONLY in
// scm.mfg_sales_order_items.remark (4,320 rows) — the one field the SO PDF
// prints. The SI / DO / DR line tables carry none of it, so the guard on those
// PDFs is a no-op today; it is applied so the book text can never reach a
// customer copy through a future path, and so every customer PDF behaves
// identically.

const BOOK_TEXT_MARKER = '账本原文';

/**
 * Strip any AutoCount book-text segment from a line remark / notes value.
 *
 * The value is treated line by line (newline-separated). On each line,
 * everything from the first `账本原文` marker to the end of that line is
 * dropped — so a line that is PURELY book text disappears, while any genuine
 * text before the marker on the same line is kept. Empty lines are removed and
 * the remainder trimmed. Returns '' when nothing genuine is left.
 */
export function stripBookText(remark: string | null | undefined): string {
  if (typeof remark !== 'string' || remark === '') return '';
  return remark
    .split('\n')
    .map((line) => {
      const at = line.indexOf(BOOK_TEXT_MARKER);
      return (at === -1 ? line : line.slice(0, at)).trim();
    })
    .filter((line) => line !== '')
    .join('\n');
}
