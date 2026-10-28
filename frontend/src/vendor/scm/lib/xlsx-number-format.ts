/* How a money or rate NUMBER is shown in an exported sheet — the way AutoCount
   prints it (owner 2026-09-15): an amount #,##0.00, a unit price up to four
   decimals. No imports: the SheetJS module is passed in by the lazy caller.
   docs/bugs/0928-datagrid-export-wrote-money-as-rm-text-or-blank-cells-and-ha.md */

export type SheetNumberFormat = 'money' | 'rate';

export const SHEET_NUMBER_FORMATS: Readonly<Record<SheetNumberFormat, string>> = {
  money: '#,##0.00',
  rate: '#,##0.00##',
};

type SheetUtils = { utils: { encode_cell: (a: { r: number; c: number }) => string } };

/** Stamp the format on the numeric cells of each formatted column (row 0 is the header). */
export function stampNumberFormats(
  XLSX: SheetUtils,
  ws: unknown,
  formats: ReadonlyArray<SheetNumberFormat | undefined>,
  rowCount: number,
): void {
  const sheet = ws as Record<string, { t?: string; z?: string } | undefined>;
  formats.forEach((f, c) => {
    if (!f) return;
    for (let r = 1; r <= rowCount; r += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') cell.z = SHEET_NUMBER_FORMATS[f];
    }
  });
}
