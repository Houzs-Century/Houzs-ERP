// A sofa set is one model on one order: one dye lot, one supplier, one batch
// (owner 2026-11-11, HC-SO-2610-104 widened it from "one order"). Two models on
// one order are two sets, so they may come from two suppliers once the operator
// confirms. Every set check (PO convert, MRP plan, stock allocator, DO pick and
// split gate) keys on sofaSetKey. The browser copy in
// frontend/src/vendor/shared must stay byte-identical.
import { splitSofaCode } from './sofa-combo-pricing';

export interface SofaModulePick {
  soDocNo: string;
  itemCode: string;
  supplierId: string;
}

export interface SofaSetSupplierSplits {
  sameModel: string[];
  crossModel: string[];
}

export function sofaSetKey(soDocNo: string, itemCode: string): string {
  return `${soDocNo}|${splitSofaCode(itemCode).baseModel.trim().toUpperCase()}`;
}

const docsWithManySuppliers = (
  picks: readonly SofaModulePick[],
  keyOf: (pick: SofaModulePick) => string,
): Set<string> => {
  const suppliersByKey = new Map<string, { soDocNo: string; suppliers: Set<string> }>();
  for (const pick of picks) {
    const key = keyOf(pick);
    const entry = suppliersByKey.get(key) ?? { soDocNo: pick.soDocNo, suppliers: new Set<string>() };
    entry.suppliers.add(pick.supplierId);
    suppliersByKey.set(key, entry);
  }
  return new Set([...suppliersByKey.values()].filter(({ suppliers }) => suppliers.size > 1).map(({ soDocNo }) => soDocNo));
};

export function findSofaSetSupplierSplits(picks: readonly SofaModulePick[]): SofaSetSupplierSplits {
  const sameModel = docsWithManySuppliers(picks, ({ soDocNo, itemCode }) => sofaSetKey(soDocNo, itemCode));
  const crossModel = [...docsWithManySuppliers(picks, ({ soDocNo }) => soDocNo)].filter((soDocNo) => !sameModel.has(soDocNo));
  return { sameModel: [...sameModel], crossModel };
}
