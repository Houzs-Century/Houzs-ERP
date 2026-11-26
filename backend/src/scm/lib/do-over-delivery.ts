export function findOverDeliveredSoItems(
  linkedQty: Map<string, number>,
  remaining: Map<string, number>,
): string[] {
  return [...linkedQty.entries()]
    .filter(([soItemId, qty]) => qty > (remaining.get(soItemId) ?? 0))
    .map(([soItemId]) => soItemId);
}

import { itemCodeKey } from './do-unlinked-so-lines';

export function findOverDeliveredUnlinkedItems(
  unlinkedByItemCode: Map<string, number>,
  openByItemCode: Map<string, number>,
): string[] {
  const open = new Map<string, number>();
  for (const [code, qty] of openByItemCode) open.set(itemCodeKey(code), qty);

  const over: string[] = [];
  for (const [rawCode, qty] of unlinkedByItemCode) {
    const code = itemCodeKey(rawCode);
    if (!code || !open.has(code)) continue;
    if (qty > (open.get(code) as number)) over.push(rawCode);
  }
  return over;
}
