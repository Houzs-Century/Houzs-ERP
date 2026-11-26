import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Truck } from 'lucide-react';
import type { DataTableChildRow } from '../../components/DataTable';
import type { MrpLine, MrpSku } from '../../vendor/scm/lib/mrp-queries';
import { fmtDate } from '../../../../shared/src/vendor/shared/format';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { rowKey, type AccessoryRider, type ModelGroup } from './mrp-model-pipeline';
import styles from './Mrp.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

export type MrpTreeShape = 'sofa' | 'bedframe' | 'model';

export interface MrpLineControls {
  selected: Set<string>;
  onToggleLine: (soItemId: string) => void;
  onSetLinesSelected: (ids: string[], on: boolean) => void;
  lineSupplier: Partial<Record<string, string>>;
  onLineSupplierChange: (soItemId: string, supplierId: string) => void;
}

export interface MrpTreeOptions extends MrpLineControls {
  shape: MrpTreeShape;
  expandedVariants: Set<string>;
  onToggleVariant: (key: string) => void;
  isEveryVariantOpen: boolean;
  accessoryRiders: AccessoryRider[];
  poMode: 'combined' | 'per-so';
}

interface VaryingHeaderFacts {
  hasManySalesOrders: boolean;
  hasManySoDates: boolean;
  hasManyCustomers: boolean;
  hasManyStates: boolean;
}

type Cells = Partial<Record<string, ReactNode>>;

const isShortageLine = (line: MrpLine): boolean =>
  line.source === 'shortage' && line.shortageQty > 0 && Boolean(line.soItemId);

export const shortageLineIdsOf = (sku: MrpSku): string[] =>
  sku.lines.filter(isShortageLine).map((line) => line.soItemId);

const linesOf = (group: ModelGroup): MrpLine[] => group.variants.flatMap((sku) => sku.lines);

export function distinctLineValues(group: ModelGroup, pick: (line: MrpLine) => string | null): string[] {
  const values = linesOf(group).map(pick).filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

export function rollupLabel(values: string[]): string | null {
  const first = values.at(0);
  if (first === undefined) return null;
  return values.length === 1 ? first : `${first} +${values.length - 1}`;
}

function chosenSupplierIdOf(line: MrpLine, controls: MrpLineControls): string | null {
  return controls.lineSupplier[line.soItemId] ?? line.ruleSupplierId ?? null;
}

function supplierNameOf(sku: MrpSku, line: MrpLine, controls: MrpLineControls): string | null {
  if (line.source === 'po') return line.poSupplierName;
  if (!isShortageLine(line)) return null;
  const chosenId = chosenSupplierIdOf(line, controls);
  const chosen = sku.suppliers.find((supplier) => supplier.supplierId === chosenId)
    ?? sku.suppliers.find((supplier) => supplier.isMain)
    ?? sku.suppliers.at(0);
  return chosen?.name ?? null;
}

export function supplierRollup(group: ModelGroup, controls: MrpLineControls): string | null {
  const names = group.variants.flatMap((sku) => sku.lines.map((line) => supplierNameOf(sku, line, controls)));
  const distinct = [...new Set(names.filter((name): name is string => Boolean(name)))];
  const first = distinct.at(0);
  if (first === undefined) return null;
  return distinct.length === 1 ? first : `${distinct.length} suppliers`;
}

/* A missing delivery date is NOT the same fact as a missing debtor name, so it
   gets a word instead of the em-dash. Undated lines are planned LAST and cannot
   take supply from a dated line; since the page-level undated banner was removed
   (owner, 2026-08-20) this tag is the ONLY place an undated line announces
   itself. Do not fold it back into fmtDate's em-dash. */
function DeliveryDate({ iso }: { iso: string | null }) {
  if (iso) return <>{fmtDate(iso)}</>;
  return (
    <span
      className="inline-flex items-center rounded border border-warning-text/30 bg-warning-bg px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-warning-text"
      title="No delivery date on this line or its Sales Order — planned last, not ready to order">
      No date
    </span>
  );
}

function LineSupplierSelect({ suppliers, chosenSupplierId, onSupplierChange }: {
  suppliers: MrpSku['suppliers'];
  chosenSupplierId: string | null;
  onSupplierChange: (supplierId: string) => void;
}) {
  const defaultSupplier = suppliers.find((supplier) => supplier.isMain) ?? suppliers.at(0);
  if (!defaultSupplier) return <span className={styles.noSupplier}>— none —</span>;
  return (
    <select
      className={styles.supplierSelect}
      value={chosenSupplierId ?? defaultSupplier.supplierId}
      onChange={(event) => onSupplierChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      title="Supplier for this SO line — defaults to the SKU's main supplier (NB FURNITURE for Hydraulic / NB fabric, and for the other bedframes of that SO)"
    >
      {sortByText(suppliers).map((supplier) => (
        <option key={supplier.supplierId} value={supplier.supplierId}>
          {supplier.name}{supplier.isMain ? ' ★' : ''} · {supplier.code}
        </option>
      ))}
    </select>
  );
}

function ReadOnlySupplier({ name, title }: { name: string; title: string }) {
  return <span className={styles.poSupplierRO} title={title}><Truck {...ICON} /> {name}</span>;
}

function ShortTag({ quantity }: { quantity: number }) {
  return <span className={`${styles.tag} ${styles.tagShort}`}>SHORT{quantity > 1 ? ` ×${quantity}` : ''}</span>;
}

function lineSupplierCell(sku: MrpSku, line: MrpLine, controls: MrpLineControls): ReactNode {
  if (isShortageLine(line)) {
    return (
      <LineSupplierSelect
        suppliers={sku.suppliers}
        chosenSupplierId={chosenSupplierIdOf(line, controls)}
        onSupplierChange={(supplierId) => controls.onLineSupplierChange(line.soItemId, supplierId)}
      />
    );
  }
  if (line.source === 'po') {
    return (
      <ReadOnlySupplier
        name={line.poSupplierName ?? '—'}
        title="This PO covers the line in the current allocation. Supplier is read-only because the PO is already raised."
      />
    );
  }
  return null;
}

function coverageCells(line: MrpLine): Cells {
  return {
    stock: line.source === 'stock'
      ? <span className={`${styles.tag} ${styles.tagStock}`} title={line.batchNo ? `Whole set from batch ${line.batchNo}` : undefined}>stock</span>
      : null,
    poOutstanding: line.source === 'po' && line.poNumber
      ? <span className={`${styles.tag} ${styles.tagPo}`}>{line.poNumber}{line.poEta ? ` · ETA ${fmtDate(line.poEta)}` : ''}</span>
      : null,
    shortage: isShortageLine(line) ? <ShortTag quantity={line.shortageQty} /> : null,
  };
}

function headerFactCells(line: MrpLine, facts: VaryingHeaderFacts): Cells {
  return {
    soNo: facts.hasManySalesOrders ? <span className={styles.codeCell}>{line.soDocNo}</span> : null,
    soDate: facts.hasManySoDates ? fmtDate(line.soDate) : null,
    customer: facts.hasManyCustomers ? (line.debtorName ?? '—') : null,
    state: facts.hasManyStates ? (line.customerState ?? '—') : null,
  };
}

function orderLineRow(sku: MrpSku, line: MrpLine, index: number, description: ReactNode, facts: VaryingHeaderFacts, controls: MrpLineControls): DataTableChildRow {
  const isShort = isShortageLine(line);
  return {
    key: `${rowKey(sku)}|${line.soItemId || line.soDocNo}|${index}`,
    className: isShort ? styles.childShort : undefined,
    cells: {
      select: isShort ? (
        <input
          type="checkbox"
          checked={controls.selected.has(line.soItemId)}
          onChange={() => controls.onToggleLine(line.soItemId)}
          aria-label={`Select ${sku.variantLabel ?? sku.itemCode} on ${line.soDocNo} to order`}
        />
      ) : null,
      description,
      qtyNeeded: line.qty,
      processingDate: fmtDate(line.processingDate),
      deliveryDate: <DeliveryDate iso={line.deliveryDate} />,
      supplier: lineSupplierCell(sku, line, controls),
      ...coverageCells(line),
      ...headerFactCells(line, facts),
    },
  };
}

function variantTag(sku: MrpSku): ReactNode {
  return <span className={styles.variantTag}>{sku.variantLabel ?? sku.itemCode}</span>;
}

function variantRow(sku: MrpSku, isOpen: boolean, options: MrpTreeOptions): DataTableChildRow {
  const key = rowKey(sku);
  const lineIds = shortageLineIdsOf(sku);
  const selectedCount = lineIds.filter((id) => options.selected.has(id)).length;
  const isAllSelected = lineIds.length > 0 && selectedCount === lineIds.length;
  const isShort = sku.shortage > 0;
  return {
    key: `variant|${key}`,
    className: `${styles.variantRow} ${isShort ? styles.variantRowShort : ''}`,
    lead: (
      <button
        type="button"
        aria-label={isOpen ? 'Collapse variant' : 'Expand variant'}
        aria-expanded={isOpen}
        onClick={() => options.onToggleVariant(key)}
        className="inline-flex items-center justify-center rounded text-ink-muted transition-colors hover:text-primary"
      >
        {isOpen ? <ChevronDown {...ICON} /> : <ChevronRight {...ICON} />}
      </button>
    ),
    cells: {
      select: lineIds.length > 0 ? (
        <input
          type="checkbox"
          checked={isAllSelected}
          ref={(element) => { if (element) element.indeterminate = selectedCount > 0 && !isAllSelected; }}
          onChange={(event) => options.onSetLinesSelected(lineIds, event.target.checked)}
          aria-label={`Select all shortage lines under ${sku.variantLabel ?? sku.itemCode}`}
        />
      ) : null,
      description: <span className={styles.variantDescCell}><span className={styles.variantBranch}>↳</span>{variantTag(sku)}</span>,
      qtyNeeded: sku.qtyNeeded,
      stock: sku.stock,
      poOutstanding: sku.poOutstanding || '—',
      shortage: isShort ? <span className={styles.shortNum}>{sku.shortage}</span> : '—',
    },
  };
}

function accessoryRows(riders: AccessoryRider[], facts: VaryingHeaderFacts, poMode: MrpTreeOptions['poMode']): DataTableChildRow[] {
  if (riders.length === 0) return [];
  const caption: DataTableChildRow = {
    key: 'accessory-caption',
    cells: {},
    caption: (
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {poMode === 'combined'
          ? 'Accessories on this order (sofa cover / pillow) — ride on the sofa PO when a supplier matches, else their own PO'
          : 'Accessories on this order (sofa cover / pillow) — ordered on their own PO (Per-SO); switch to Combined to ride on the sofa PO'}
      </span>
    ),
  };
  return [caption, ...riders.map(({ sku, line }, index): DataTableChildRow => {
    const mainSupplier = sku.suppliers.find((supplier) => supplier.isMain) ?? sku.suppliers.at(0);
    return {
      key: `accessory|${sku.itemCode}|${line.soItemId}|${index}`,
      className: styles.childShort,
      cells: {
        select: <span className={styles.variantBranch} title="Rides with the sofa — selected together">↳</span>,
        description: (
          <span><span className={styles.variantTag}>Accessory</span> {sku.itemCode}{sku.description ? ` · ${sku.description}` : ''}</span>
        ),
        qtyNeeded: line.qty,
        shortage: <ShortTag quantity={line.shortageQty} />,
        processingDate: fmtDate(line.processingDate),
        deliveryDate: <DeliveryDate iso={line.deliveryDate} />,
        supplier: (
          <ReadOnlySupplier
            name={mainSupplier?.name ?? '— none —'}
            title="The cover's main supplier. In Combined it joins the sofa PO only when this matches the sofa's supplier."
          />
        ),
        ...headerFactCells(line, facts),
      },
    };
  })];
}

const varies = (group: ModelGroup, pick: (line: MrpLine) => string | null): boolean =>
  new Set(linesOf(group).map(pick)).size > 1;

function varyingHeaderFacts(group: ModelGroup): VaryingHeaderFacts {
  return {
    hasManySalesOrders: varies(group, (line) => line.soDocNo),
    hasManySoDates: varies(group, (line) => line.soDate),
    hasManyCustomers: varies(group, (line) => line.debtorName),
    hasManyStates: varies(group, (line) => line.customerState),
  };
}

const orderLineRows = (sku: MrpSku, description: ReactNode, facts: VaryingHeaderFacts, controls: MrpLineControls): DataTableChildRow[] =>
  sku.lines.map((line, index) => orderLineRow(sku, line, index, description, facts, controls));

export function buildMrpChildRows(group: ModelGroup, options: MrpTreeOptions): DataTableChildRow[] {
  const facts = varyingHeaderFacts(group);
  if (options.shape === 'sofa') {
    return [
      ...group.variants.flatMap((sku) => orderLineRows(sku, variantTag(sku), facts, options)),
      ...accessoryRows(options.accessoryRiders, facts, options.poMode),
    ];
  }
  const onlyVariant = group.variants.at(0);
  if (group.variants.length === 1 && onlyVariant !== undefined) {
    const showsSpec = options.shape !== 'bedframe' && Boolean(onlyVariant.variantLabel);
    return orderLineRows(onlyVariant, showsSpec ? variantTag(onlyVariant) : null, facts, options);
  }
  return group.variants.flatMap((sku) => {
    const isOpen = options.isEveryVariantOpen || options.expandedVariants.has(rowKey(sku));
    return [variantRow(sku, isOpen, options), ...(isOpen ? orderLineRows(sku, null, facts, options) : [])];
  });
}
