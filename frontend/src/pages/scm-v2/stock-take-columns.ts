import type { CSSProperties } from 'react';

export const COUNT_SHEET_COLUMN_KEYS = [
  'sku', 'name', 'variant', 'systemQty', 'countedQty', 'rack', 'notes', 'variance', 'value', 'countedBy',
] as const;

export type CountSheetColumnKey = typeof COUNT_SHEET_COLUMN_KEYS[number];

export const COUNT_SHEET_ORDER_STORAGE_KEY = 'stock-take-count-sheet-column-order';

export interface CountSheetHeader {
  label: string;
  style: CSSProperties;
}

export const COUNT_SHEET_HEADERS: Record<CountSheetColumnKey, CountSheetHeader> = {
  sku: { label: 'SKU', style: { width: '18%' } },
  name: { label: 'Name', style: {} },
  variant: { label: 'Variant', style: {} },
  systemQty: { label: 'System Qty', style: { width: 110, textAlign: 'right' } },
  countedQty: { label: 'Counted Qty', style: { width: 130, textAlign: 'right' } },
  rack: { label: 'Rack', style: { width: 120 } },
  notes: { label: 'Notes', style: { width: 160 } },
  variance: { label: 'Variance', style: { width: 110, textAlign: 'right' } },
  value: { label: 'Value (RM)', style: { width: 110, textAlign: 'right' } },
  countedBy: { label: 'Counted By', style: { width: 130 } },
};

const BLIND_HIDDEN_COLUMNS: ReadonlySet<CountSheetColumnKey> = new Set(['systemQty', 'variance', 'value']);

export function visibleCountSheetColumns(
  order: readonly CountSheetColumnKey[],
  isBlind: boolean,
): CountSheetColumnKey[] {
  return isBlind ? order.filter((key) => !BLIND_HIDDEN_COLUMNS.has(key)) : [...order];
}
