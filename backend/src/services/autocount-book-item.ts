// ----------------------------------------------------------------------------
// autocount-book-item — a line's Item Code, Item Description, Item Group and
// UOM the way the account book spells them, for the document list exports
// (owner 2026-09-15: "match AutoCount's listing 100%").
//
// SHARED by every document export (SO, DO, GR, PI, SI, PO). One home, so the
// six files cannot come to spell one item six ways.
//
// ITEM CODE is resolveAcItemCode's answer — the write-back's own resolver, not a
// copy. A line it cannot resolve prints its ERP code: an export is a reading,
// not a write, and a blank cell would hide the line's item entirely.
//
// ITEM GROUP, UOM and DESCRIPTION are properties of the AutoCount ITEM. Measured
// against the live book 2026-09-15 by AutoCount item code: Item.ItemGroup equals
// the line's listed group on 61,818 / 61,818 SO lines and 47,928 / 47,928 DO
// lines; BaseUOM equals the line UOM on 61,795 / 61,818 and 47,906 / 47,928.
// The snapshot is autocount-item-master.ts (generated from
// scripts/data/ac-item-master.tsv). An item the snapshot does not know falls
// back to the ERP's own values (category and UOM in capitals).
// ----------------------------------------------------------------------------

import { AC_ITEM_MASTER_TSV } from './autocount-item-master';
import { resolveAcItemCode } from './autocount-item-code';

export type AcBookItem = { description: string; itemGroup: string; baseUom: string };

let index: Map<string, AcBookItem> | null = null;

/** The book's item master, keyed by UPPERCASED AutoCount ItemCode. */
export function acBookItemIndex(): Map<string, AcBookItem> {
  if (index) return index;
  const out = new Map<string, AcBookItem>();
  for (const line of AC_ITEM_MASTER_TSV.split('\n')) {
    const f = line.split('\t');
    if (f.length !== 4 || !f[0]) continue;
    out.set(f[0].trim().toUpperCase(), { description: f[1]!, itemGroup: f[2]!, baseUom: f[3]! });
  }
  index = out;
  return out;
}

const up = (v: string | null | undefined): string => String(v ?? '').trim().toUpperCase();
const tidy = (v: string | null | undefined): string | null => String(v ?? '').trim() || null;

export type BookLineItem = {
  /** The write-back resolver's AutoCount ItemCode, else the ERP code. */
  itemCode: string | null;
  /** True when the resolver answered (its code may be the ERP code itself, for
   *  a product opened in the book under that name). */
  resolved: boolean;
  /** True when the book's item master knows that code. */
  inBook: boolean;
  description: string | null;
  itemGroup: string | null;
  uom: string | null;
};

/**
 * One ERP line's item as the book lists it. `supplierCode` disambiguates a
 * purchase line; a sales line names no supplier, so it passes null.
 */
export function bookLineItem(
  erp: {
    itemCode: string | null | undefined;
    description: string | null | undefined;
    category: string | null | undefined;
    uom: string | null | undefined;
  },
  supplierCode: string | null,
): BookLineItem {
  const code = String(erp.itemCode ?? '').trim();
  const r = code ? resolveAcItemCode(code, { supplierCode }) : null;
  const acCode = r && r.ok ? r.acItemCode : null;
  const book = acCode ? acBookItemIndex().get(up(acCode)) : undefined;
  return {
    itemCode: acCode ?? (code || null),
    resolved: acCode !== null,
    inBook: book !== undefined,
    description: tidy(book?.description) ?? tidy(erp.description),
    itemGroup: tidy(book?.itemGroup) ?? (up(erp.category) || null),
    uom: tidy(book?.baseUom) ?? (up(erp.uom) || null),
  };
}
