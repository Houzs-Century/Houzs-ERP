// ----------------------------------------------------------------------------
// skuImportTemplate — a blank sheet for creating SKUs through Import SKUs
// (2990-0025, Sim: "need have import template for item master create").
//
// The import already creates a SKU for a code it does not hold; what a person
// lacked was a file to start from. Export SKUs is a lean PRICE sheet with no
// description / model / branding / status, so it was the wrong start for a
// new item. Sheet 1 is the header row only — the importer reads the first
// sheet and its first row as headers — so an example row can never be imported
// by mistake. Sheet 2 says what goes in each column.
// ----------------------------------------------------------------------------
import type { SheetData } from 'write-excel-file';
import { MFG_CATEGORY_LABELS, MFG_PRODUCT_CATEGORIES } from '../../../vendor/shared/product-categories';
import type { BatchImportResult } from '../../../vendor/scm/lib/mfg-products-queries';

type TemplateCol = { key: string; required: boolean; note: string; width: number };

export function skuTemplateColumns(sofaSizes: string[]): TemplateCol[] {
  const categories = MFG_PRODUCT_CATEGORIES.map((c) => MFG_CATEGORY_LABELS[c]).join(', ');
  return [
    { key: 'code', required: true, width: 22, note: 'Product code. A code not in SKU Master creates a new SKU; a code already there edits that SKU.' },
    { key: 'name', required: true, width: 30, note: 'Name shown on SO / PO. Required for a new SKU.' },
    { key: 'category', required: true, width: 16, note: `Required for a new SKU. One of: ${categories}.` },
    { key: 'description', required: false, width: 30, note: 'Optional.' },
    { key: 'base_model', required: false, width: 16, note: 'Model code. SKUs with the same model sit under one Model. Blank = the SKU is its own Model.' },
    { key: 'size_label', required: false, width: 14, note: 'Size, for example King or Queen.' },
    { key: 'branding', required: false, width: 14, note: 'Mattress branding.' },
    { key: 'status', required: false, width: 12, note: 'ACTIVE or INACTIVE. Blank = ACTIVE.' },
    { key: 'base_price', required: false, width: 12, note: 'Not sofa: Price 2 in RM, for example 1535.00 (the Mattress tab shows it as Price).' },
    { key: 'price1', required: false, width: 12, note: 'Not sofa: Price 1 in RM.' },
    { key: 'price_tier', required: false, width: 12, note: 'Sofa only: P1, P2 or P3 — the tier the price_ columns on this row belong to. For more tiers, repeat the row with the same code and another tier.' },
    ...sofaSizes.map((s) => ({ key: `price_${s}`, required: false, width: 11, note: `Sofa only: price in RM for seat size ${s}.` })),
  ];
}

/** Both sheets as write-excel-file matrices — pure, so a test reads them without a workbook. */
export function skuTemplateSheets(cols: TemplateCol[]): [SheetData, SheetData] {
  const head = (value: string) => ({ value, type: String, fontWeight: 'bold' as const });
  const skus: SheetData = [cols.map((c) => head(c.key))];
  const guide: SheetData = [
    [head('Column'), head('Needed for a new SKU'), head('What to write')],
    ...cols.map((c) => [
      { value: c.key, type: String },
      { value: c.required ? 'Yes' : '', type: String },
      { value: c.note, type: String, wrap: true },
    ]),
    [],
    [{ value: 'Fill sheet SKUs only. A blank cell never clears a saved value. Up to 500 SKUs per file.', type: String, span: 3 }],
  ];
  return [skus, guide];
}

/** "2 new SKUs · 3 updated". An API from before the split sends only `upserted`, all of it once read as "updated". */
export function savedSummary(r: Pick<BatchImportResult, 'upserted' | 'created'>): string {
  const created = r.created ?? 0;
  const updated = r.upserted - created;
  const parts = [
    created > 0 ? `${created} new SKU${created === 1 ? '' : 's'}` : '',
    updated > 0 ? `${updated} SKU${updated === 1 ? '' : 's'} updated` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

export async function downloadSkuImportTemplate(sofaSizes: string[]): Promise<void> {
  const cols = skuTemplateColumns(sofaSizes);
  const writeXlsxFile = (await import('write-excel-file')).default;
  await writeXlsxFile(skuTemplateSheets(cols), {
    fileName: 'SKU-import-template.xlsx',
    sheets: ['SKUs', 'How to fill'],
    columns: [cols.map((c) => ({ width: c.width })), [{ width: 16 }, { width: 20 }, { width: 80 }]],
    stickyRowsCount: 1,
  });
}
