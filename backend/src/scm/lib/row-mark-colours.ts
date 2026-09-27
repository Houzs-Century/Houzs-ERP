// The fixed palette a Delivery Planning board row may be painted (owner
// 2026-09-26: 色板标记). TOKENS only — the exact tint is the frontend's
// (vendor/scm/lib/delivery-row-mark.ts), so the look can be restyled without a
// migration. The write route rejects anything off this list, so a value outside
// the palette can never reach the table.

// The tokens mirror the categories the HC Delivery sheet already colour-codes
// (owner 2026-09-26): red=Fell Delivery, orange=Supplier Pickup, yellow=Lorry
// Service, green=SERVICE Delivery, cyan=Fair Setup/Dismantle, blue=SERVICE
// Inspection, purple=Transfer PG/SG + SERVICE Pickup, grey=No Outstation.
export const ROW_MARK_COLOURS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'grey'] as const;

export type RowMarkColour = (typeof ROW_MARK_COLOURS)[number];

export function isRowMarkColour(x: string): x is RowMarkColour {
  return (ROW_MARK_COLOURS as readonly string[]).includes(x);
}
