// The fixed palette a Delivery Planning board row may be painted (owner
// 2026-09-26: 色板标记). TOKENS only — the exact tint is the frontend's
// (vendor/scm/lib/delivery-row-mark.ts), so the look can be restyled without a
// migration. The write route rejects anything off this list, so a value outside
// the palette can never reach the table.

export const ROW_MARK_COLOURS = ['red', 'amber', 'green', 'blue', 'grey'] as const;

export type RowMarkColour = (typeof ROW_MARK_COLOURS)[number];

export function isRowMarkColour(x: string): x is RowMarkColour {
  return (ROW_MARK_COLOURS as readonly string[]).includes(x);
}
