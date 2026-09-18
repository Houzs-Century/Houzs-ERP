/* Sofa Accessory on the MRP Sofa tab (owner 2026-09-14: 「sofa accessory 就 park
   under sofa 在 MRP 的地方 然后 under same SO 的 这样就可以开一样 PO 了」).

   A Sofa Accessory SKU (category FABRIC_ACCESSORY — custom pillows, back cushions,
   arm rests sewn in the order's fabric) is made per order, like the sofa. So on
   the MRP page it does not get a tab of its own and does not land in Others: it
   is split per SO and handed to the Sofa tab, where groupBySo puts each line
   under its own order's row. Selecting that order selects it too, and Proceed
   PO sends it in the same batch, where po-grouping.ts keys it as the sofa.

   The engine pools a SKU's lines per (warehouse, code, colour); the Sofa tab's
   rows are per SO, so each pooled SKU is cut into one row per SO here. */
import type { MrpSku } from '../../vendor/scm/lib/mrp-queries';

export const SOFA_TAB_CATEGORIES: ReadonlySet<string> = new Set(['FABRIC_ACCESSORY']);

export const isSofaAccessory = (category: string | null | undefined): boolean =>
  SOFA_TAB_CATEGORIES.has((category ?? '').trim().toUpperCase());

export function sofaAccessoryRowsPerSo(skus: readonly MrpSku[]): MrpSku[] {
  const out: MrpSku[] = [];
  for (const s of skus) {
    if (!isSofaAccessory(s.category)) continue;
    const bySo = new Map<string, MrpSku['lines']>();
    for (const l of s.lines) {
      const arr = bySo.get(l.soDocNo) ?? [];
      arr.push(l);
      bySo.set(l.soDocNo, arr);
    }
    for (const [soDocNo, lines] of bySo) {
      const sum = (pick: (l: MrpSku['lines'][number]) => number) => lines.reduce((a, l) => a + pick(l), 0);
      const colour = s.variantLabel && s.variantLabel !== s.itemCode ? s.variantLabel : '';
      out.push({
        ...s,
        variantKey: `${soDocNo}::${s.variantKey}`,
        variantLabel: colour ? `${s.itemCode} · ${colour}` : s.itemCode,
        qtyNeeded: sum((l) => l.qty),
        stock: sum((l) => (l.source === 'stock' ? l.qty : 0)),
        poOutstanding: sum((l) => (l.source === 'po' ? l.qty : 0)),
        shortage: sum((l) => (l.source === 'shortage' ? l.shortageQty : 0)),
        lines,
      });
    }
  }
  return out;
}
