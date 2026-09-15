// ----------------------------------------------------------------------------
// autocount-book-item — a line's Item Code, Item Group and UOM the way the
// account book spells them, for the document list exports (owner 2026-09-15:
// "match AutoCount's listing 100%").
//
// SHARED by every document export (SO, DO, GR, PI, SI, PO). One home, so the
// six files cannot come to spell one item six ways.
//
// ITEM CODE is resolveAcItemCode's answer — the write-back's own resolver, not a
// copy. A line it cannot resolve prints its ERP code: an export is a reading,
// not a write, and a blank cell would hide the line's item entirely.
//
// ITEM GROUP and UOM are properties of the AutoCount ITEM, not of the line: the
// book's listings print Item.ItemGroup and the line's UOM, which is the item's
// SalesUOM. Measured against the live book 2026-09-15 by AutoCount item code:
// Item.ItemGroup equals the line's listed group on 61,818 / 61,818 SO lines and
// 47,928 / 47,928 DO lines; SalesUOM equals the line UOM on 61,795 / 61,818 and
// 47,906 / 47,928. The snapshot is autocount-item-master.ts (generated). An item
// the snapshot does not know falls back to the ERP's own category in capitals.
// ----------------------------------------------------------------------------

import { AC_ITEM_MASTER_TSV } from './autocount-item-master';
import { resolveAcItemCode } from './autocount-item-code';

export type AcBookItem = { itemGroup: string; salesUom: string; baseUom: string };

let index: Map<string, AcBookItem> | null = null;

/** The book's item master, keyed by UPPERCASED AutoCount ItemCode. */
export function acBookItemIndex(): Map<string, AcBookItem> {
  if (index) return index;
  const out = new Map<string, AcBookItem>();
  for (const line of AC_ITEM_MASTER_TSV.split('\n')) {
    if (!line) continue;
    const [code, itemGroup, salesUom, baseUom] = line.split('\t');
    if (!code) continue;
    out.set(code.trim().toUpperCase(), { itemGroup: itemGroup ?? '', salesUom: salesUom ?? '', baseUom: baseUom ?? '' });
  }
  index = out;
  return out;
}

const up = (v: string | null | undefined): string => String(v ?? '').trim().toUpperCase();

export type BookLineItem = {
  /** The AutoCount ItemCode when it resolves, else the ERP code. */
  itemCode: string | null;
  /** True when the write-back's resolver answered (its code may be the ERP
   *  code itself, for a product opened in the book under that name). */
  resolved: boolean;
  itemGroup: string | null;
  uom: string | null;
};

/**
 * One ERP line's item as the book lists it. `supplierCode` disambiguates a
 * purchase line (pass null on a sales line — it names no supplier).
 */
export function bookLineItem(
  erpItemCode: string | null | undefined,
  erpCategory: string | null | undefined,
  erpUom: string | null | undefined,
  supplierCode: string | null,
): BookLineItem {
  const code = String(erpItemCode ?? '').trim();
  const r = code ? resolveAcItemCode(code, { supplierCode }) : null;
  const acCode = r && r.ok ? r.acItemCode : null;
  const book = acCode ? acBookItemIndex().get(up(acCode)) : undefined;
  return {
    itemCode: acCode ?? (code || null),
    resolved: acCode !== null,
    itemGroup: book?.itemGroup || up(erpCategory) || null,
    uom: book?.salesUom || up(erpUom) || null,
  };
}
