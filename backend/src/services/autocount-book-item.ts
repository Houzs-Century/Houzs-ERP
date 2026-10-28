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
import { splitSofaCode } from './autocount-sofa-collapse';

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
  /** True when the book's item master supplied Description, Group and UOM —
   *  for the resolved code, (with bindings) for the unbound resolver's code, or
   *  for a sofa piece the model's set item. */
  inBook: boolean;
  description: string | null;
  itemGroup: string | null;
  uom: string | null;
};

/**
 * One ERP line's item as the book lists it. `supplierCode` disambiguates a
 * purchase line; a sales line names no supplier, so it passes null.
 * `opts.bindings` is the write-back's live binding map (`bindingsFor`, keyed by
 * UPPERCASED ERP code), forwarded to resolveAcItemCode so an export resolves a
 * line exactly as the write-back does. Absent, the resolver runs without it —
 * the answer the caller got before the option existed.
 */
export function bookLineItem(
  erp: {
    itemCode: string | null | undefined;
    description: string | null | undefined;
    category: string | null | undefined;
    uom: string | null | undefined;
  },
  supplierCode: string | null,
  opts: { bindings?: Map<string, string> | null } = {},
): BookLineItem {
  const code = String(erp.itemCode ?? '').trim();
  const r = code ? resolveAcItemCode(code, { supplierCode, bindings: opts.bindings ?? null }) : null;
  const acCode = r && r.ok ? r.acItemCode : null;
  let book = acCode ? acBookItemIndex().get(up(acCode)) : undefined;
  /* A BINDING NAMES THE SUPPLIER'S SKU, which need not be a book item — a sofa
     piece binds to e.g. 'DSL-9028 SOFA 1A(RHF)' while the book holds the piece
     under its own code. The Item Code stays the bound answer (what the
     write-back sends); Description, Group and UOM come from the item the
     unbound resolver names, when THAT is in the book. Measured by the GR / PI /
     SI exports 2026-09-15 (run 34951676357): with bindings and no such fallback
     Item Group matched fewer lines than without — GR 730 vs 760, PI 418 vs 423,
     IV 209 vs 221. */
  if (!book && code && opts.bindings) {
    const unbound = resolveAcItemCode(code, { supplierCode });
    if (unbound.ok) book = acBookItemIndex().get(up(unbound.acItemCode));
  }
  /* A SOFA PIECE is listed by the book under the model's SET item (group SOFA,
     UOM SET): the book holds a sofa as one line (sofa-is-one-book-line). The
     book's own piece items (5530-2A(LHF), 9028-1A(RHF), AMN-SF9050 SOFA
     1A(LHF) ...) are group OTHER — 34 of the 37 piece-shaped items in the item
     master, 2026-09-15 — and printing their group mis-lists every sofa line.
     So for a piece: never an OTHER item; the set item `{model}-1S` resolved
     exactly as the line was (same supplier, same bindings) when it is a SOFA
     item; otherwise our own values. Measured on the GR/PI/SI lines
     GR-004037#128 ... HC-SI-2609-007#16 (PR body). */
  const piece = code ? splitSofaCode(code) : null;
  if (piece && book?.itemGroup.toUpperCase() === 'OTHER') book = undefined;
  if (piece && !book) {
    const set = resolveAcItemCode(`${piece.model}-1S`, { supplierCode, bindings: opts.bindings ?? null });
    const setItem = set.ok ? acBookItemIndex().get(up(set.acItemCode)) : undefined;
    if (setItem?.itemGroup.toUpperCase() === 'SOFA') book = setItem;
  }
  return {
    itemCode: acCode ?? (code || null),
    resolved: acCode !== null,
    inBook: book !== undefined,
    description: tidy(book?.description) ?? tidy(erp.description),
    itemGroup: tidy(book?.itemGroup) ?? (up(erp.category) || null),
    uom: tidy(book?.baseUom) ?? (up(erp.uom) || null),
  };
}
