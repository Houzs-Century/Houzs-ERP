/* MRP Sofa tab, before Proceed PO: a sofa set is one model on one order
   (backend shared/sofa-set-identity.ts). One model on two suppliers, or a set
   that already has part of it on a PO, is refused. Two models on two suppliers
   asks the operator to confirm first (owner 2026-11-11, HC-SO-2610-104). */
import { findSofaSetSupplierSplits, sofaSetKey } from '../../vendor/shared/sofa-set-identity';
import { splitSofaCode } from '../../vendor/shared/sofa-combo-pricing';

export interface SofaModuleOrderLine {
  soDocNo: string;
  itemCode: string;
  supplierId: string | null;
  poNumber: string | null;
}

export type SofaSetGate =
  | { kind: 'ok' }
  | { kind: 'blocked'; title: string; body: string }
  | { kind: 'confirmSuppliers'; body: string };

const modelOf = (itemCode: string): string => splitSofaCode(itemCode).baseModel.trim().toUpperCase();

const describeSuppliersPerModel = (
  lines: readonly SofaModuleOrderLine[],
  soDocNo: string,
  supplierNameOf: (supplierId: string) => string,
): string => {
  const supplierByModel = new Map<string, string>();
  for (const line of lines) {
    if (line.soDocNo !== soDocNo) continue;
    supplierByModel.set(modelOf(line.itemCode), supplierNameOf(line.supplierId ?? ''));
  }
  const models = [...supplierByModel.entries()].map(([model, supplier]) => `${model} from ${supplier}`);
  return `• ${soDocNo}: ${models.join(', ')}`;
};

export function checkSofaSetsBeforePo(
  lines: readonly SofaModuleOrderLine[],
  supplierNameOf: (supplierId: string) => string,
): SofaSetGate {
  const { sameModel, crossModel } = findSofaSetSupplierSplits(
    lines.map(({ soDocNo, itemCode, supplierId }) => ({ soDocNo, itemCode, supplierId: supplierId ?? '' })),
  );
  if (sameModel.length > 0) {
    return {
      kind: 'blocked',
      title: 'One supplier per sofa model',
      body: `A sofa model is one dye lot, so every module of one model on an order goes on ONE purchase order (pillows and stools may use their own supplier). Pick the same supplier for each model of:\n${sameModel.map((soDocNo) => `• ${soDocNo}`).join('\n')}`,
    };
  }
  const onOrderBySet = new Map<string, string>();
  for (const line of lines) {
    if (line.poNumber) onOrderBySet.set(sofaSetKey(line.soDocNo, line.itemCode), `• ${line.soDocNo} ${modelOf(line.itemCode)} → ${line.poNumber}`);
  }
  if (onOrderBySet.size > 0) {
    return {
      kind: 'blocked',
      title: 'Set already on a purchase order',
      body: `These sofa models already have part of their set on order. A second PO would be a second batch, and the set must ship from one. Amend the named PO to add the missing module instead:\n${[...onOrderBySet.values()].join('\n')}`,
    };
  }
  if (crossModel.length > 0) {
    return {
      kind: 'confirmSuppliers',
      body: `These orders put different sofa models on different suppliers, so each supplier gets its own purchase order:\n${crossModel.map((soDocNo) => describeSuppliersPerModel(lines, soDocNo, supplierNameOf)).join('\n')}\n\nDo you really want more than one supplier for these sofas?`,
    };
  }
  return { kind: 'ok' };
}
