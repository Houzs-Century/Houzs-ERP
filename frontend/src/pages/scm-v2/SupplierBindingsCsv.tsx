// ----------------------------------------------------------------------------
// Supplier bindings — CSV / Excel export + import.
//
// Extracted from SupplierDetail.tsx (2026-09-17, B3) so the importer could grow
// an auto-create path without pushing that file past its size ceiling. Exports
// exportBindingsCsv + ImportBindingsDialog, plus the pure parsers/builders (used
// by both the dialog and the unit test).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../components/Button';
import {
  useUpdateBinding,
  useCreateBindingsBatch,
  type BindingRow,
  type NewBinding,
  type SofaPriceMatrix,
  type BedframePriceMatrix,
} from '../../vendor/scm/lib/suppliers-queries';
import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { composeSupplierSku } from '../../vendor/scm/lib/supplier-sku-helpers';
import styles from './SupplierDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* ════════════════════════════════════════════════════════════════════════
   Bindings CSV Export + Import (Commander 2026-05-28).

   EXPORT is tidy LONG format — header:
     internal_code, supplier_sku, category, height, tier, price_rm,
     lead_time_days, moq, is_main_supplier

   Per binding kind:
     • other (mattress/accessory/service) → ONE row: category=other, blank
       height/tier, price_rm = unit_price.
     • bedframe → one row per tier present (P1/P2): category=bedframe, blank
       height, tier=P1|P2.
     • sofa → one row per (height × tier) present: category=sofa, height=24…,
       tier=P1|P2|P3.
   A binding with no price set still emits ONE row (blank price) so it round-
   trips and stays editable. The per-binding scalars (supplier_sku / lead /
   moq / main) repeat on every row for that binding — standard long-format
   redundancy; import reads them from the binding's rows (last non-blank wins).

   Sofa seat-heights come from the master maintenance config (same source the
   sofa SKU mappings table reads), so the export always reflects the current
   pool. Long format means adding a seat-height no longer changes the column
   set — it just adds rows.

   IMPORT accepts BOTH formats (back-compat): the new LONG layout AND the old
   WIDE matrix. We sniff the header — a `price_rm` column ⇒ long; any
   `sofa_<h>_<t>` / `bedframe_P1` / `unit_price_rm` column ⇒ wide. Suppliers'
   previously-exported wide CSVs still load unchanged.

   Import (B3, 2026-09-17): rows matching an existing binding are PATCHed; rows
   whose internal_code is NOT yet bound are CREATED via the company-scoped
   `POST /suppliers/:id/bindings/batch` endpoint (which skips any code already
   bound and stamps the active company). A dry-run PREVIEW lists exactly what
   will be created and updated before any write — money-sensitive, so nothing
   is written until the operator confirms.
   ════════════════════════════════════════════════════════════════════════ */

const SOFA_TIERS_FOR_EXPORT: readonly ('P1' | 'P2' | 'P3')[] = ['P1', 'P2', 'P3'];

/** RFC4180 quote when a cell contains comma / quote / newline. */
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Sen → RM (2dp). Treat `0`/`null` as blank so the CSV doesn't write
 *  "0.00" into every cell that's never been filled. */
function fmtRmCell(centi: number | null | undefined): string {
  if (centi == null || centi === 0) return '';
  return (centi / 100).toFixed(2);
}

/** Read centi from a parsed CSV cell. Empty string / "—" → null (skip).
 *  Anything else gets coerced through Number; non-finite → null. */
function parseRmCell(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t === '—' || t === '-') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Classify a binding's underlying mfg_product so we know which optional
 *  matrix columns it should populate. Mirrors SupplierOverviewPanel.classify
 *  but returns the smaller set the CSV cares about. */
function bindingKindForCsv(
  binding: BindingRow,
  productByCode: Map<string, MfgProductRow>,
): 'sofa' | 'bedframe' | 'other' {
  const p = productByCode.get(binding.item_code);
  if (!p) return 'other';
  if (p.category === 'SOFA') return 'sofa';
  if (p.category === 'BEDFRAME') return 'bedframe';
  return 'other';
}

/** Long-format header — fixed column set regardless of the seat-height pool. */
const BINDINGS_LONG_HEADER: readonly string[] = [
  'internal_code',
  'supplier_sku',
  'category',
  'height',
  'tier',
  'price_rm',
  'lead_time_days',
  'moq',
  'is_main_supplier',
];

export function exportBindingsCsv(
  bindings: BindingRow[],
  supplierCode: string,
  sofaHeights: string[],
  products: MfgProductRow[],
): void {
  if (bindings.length === 0) return;
  const productByCode = new Map<string, MfgProductRow>(
    products.map((p) => [p.code, p]),
  );

  // Tidy LONG format — one row per binding × price-point. Adding a seat-height
  // adds rows, never columns, so the file shape is stable across pool edits.
  const lines: string[] = [BINDINGS_LONG_HEADER.map(csvCell).join(',')];
  const scalar = (b: BindingRow) => ({
    internal_code: b.item_code,
    supplier_sku: b.supplier_sku,
    lead_time_days: b.lead_time_days || '',
    moq: b.moq || '',
    is_main_supplier: b.is_main_supplier ? 'true' : 'false',
  });
  const emit = (
    b: BindingRow,
    category: string,
    height: string,
    tier: string,
    priceRm: string,
  ) => {
    const row: Record<string, unknown> = {
      ...scalar(b), category, height, tier, price_rm: priceRm,
    };
    lines.push(BINDINGS_LONG_HEADER.map((col) => csvCell(row[col])).join(','));
  };

  for (const b of bindings) {
    const kind = bindingKindForCsv(b, productByCode);
    if (kind === 'sofa') {
      const matrix = (b.price_matrix ?? {}) as SofaPriceMatrix;
      let emitted = 0;
      for (const h of sofaHeights) {
        const inner = matrix[h] ?? {};
        for (const t of SOFA_TIERS_FOR_EXPORT) {
          const cell = fmtRmCell(inner[t]);
          if (cell) { emit(b, 'sofa', h, t, cell); emitted += 1; }
        }
      }
      // No prices set yet → still emit one anchor row so the binding round-trips.
      if (emitted === 0) emit(b, 'sofa', '', '', '');
    } else if (kind === 'bedframe') {
      const matrix = (b.price_matrix ?? {}) as BedframePriceMatrix;
      let emitted = 0;
      for (const t of ['P1', 'P2'] as const) {
        const cell = fmtRmCell(matrix[t]);
        if (cell) { emit(b, 'bedframe', '', t, cell); emitted += 1; }
      }
      if (emitted === 0) emit(b, 'bedframe', '', '', '');
    } else {
      // mattress / accessory / service — a single flat unit price.
      emit(b, 'other', '', '', fmtRmCell(b.unit_price_sen));
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `supplier-${supplierCode}-bindings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Minimal CSV parser — handles RFC4180 quoting + escaped quotes. Doesn't
 *  try to be clever about UTF-8 BOM or CRLF / mixed line endings; commander's
 *  workflow is "Export → edit in Excel → save → Import" which produces
 *  comma-separated UTF-8 with quoted strings. */
/** Read the first sheet of an uploaded Excel workbook (.xlsx/.xls) into rows of
 *  string cells — so an exported CSV that the operator edited and let Excel
 *  re-save as a workbook still imports. CSV stays on parseCsv below. */
async function readXlsxGrid(file: File): Promise<string[][]> {
  const XLSX = await import('../../lib/xlsx-runtime');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const first = wb.SheetNames[0];
  const sheet = first ? wb.Sheets[first] : undefined;
  if (!sheet) return [];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
  return aoa
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
    .filter((r) => r.some((c) => c.trim().length > 0));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; continue; }
    cell += ch;
  }
  // Flush trailing cell + row (no final newline).
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/* ── Import format detection + per-format patch builders (#6 back-compat) ──
   Both builders accumulate into a Map<bindingId, AccumPatch>, so the executor
   below is format-agnostic. A binding's scalar fields take the last non-blank
   value seen; the price matrix is layered cell-by-cell onto the binding's
   CURRENT matrix (wholesale send) so a partial sheet never wipes other cells. */

export type ImportFormat = 'long' | 'wide';
type AccumPatch = { binding: BindingRow; patch: Partial<NewBinding> };
type CsvKind = 'sofa' | 'bedframe' | 'other';

/** Sniff the format from the header. A `price_rm` column ⇒ the new long
 *  layout; any wide price column (`unit_price_rm` / `sofa_*` / `bedframe_*`)
 *  ⇒ the legacy wide matrix. Defaults to long (the current export). */
export function detectImportFormat(header: string[]): ImportFormat {
  if (header.includes('price_rm')) return 'long';
  if (
    header.includes('unit_price_rm') ||
    header.includes('bedframe_P1') ||
    header.includes('bedframe_P2') ||
    header.some((h) => /^sofa_.+_(P1|P2|P3)$/.test(h))
  ) return 'wide';
  return 'long';
}

function csvKindForProduct(product: MfgProductRow | undefined): CsvKind {
  return product?.category === 'SOFA' ? 'sofa'
    : product?.category === 'BEDFRAME' ? 'bedframe'
      : 'other';
}

/** Apply the shared scalar columns (supplier_sku / lead / moq / main) from one
 *  parsed row onto an accumulating patch. Diffs against the binding so no-op
 *  values aren't sent. Returns true if anything changed. */
function applyScalarCols(
  r: string[],
  cols: { supSku: number; lead: number; moq: number; main: number },
  binding: BindingRow,
  patch: Partial<NewBinding>,
): boolean {
  let changed = false;
  if (cols.supSku >= 0) {
    const v = (r[cols.supSku] ?? '').trim();
    if (v && v !== binding.supplier_sku && patch.supplierSku !== v) { patch.supplierSku = v; changed = true; }
  }
  if (cols.lead >= 0) {
    const raw = (r[cols.lead] ?? '').trim();
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n !== binding.lead_time_days) { patch.leadTimeDays = Math.round(n); changed = true; }
    }
  }
  if (cols.moq >= 0) {
    const raw = (r[cols.moq] ?? '').trim();
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n !== binding.moq) { patch.moq = Math.round(n); changed = true; }
    }
  }
  if (cols.main >= 0) {
    const raw = (r[cols.main] ?? '').trim().toLowerCase();
    if (raw === 'true' || raw === '1') {
      if (!binding.is_main_supplier) { patch.isMainSupplier = true; changed = true; }
    } else if (raw === 'false' || raw === '0') {
      if (binding.is_main_supplier) { patch.isMainSupplier = false; changed = true; }
    }
  }
  return changed;
}

/** WIDE parser — one row per binding, per-height matrix columns. Mirrors the
 *  legacy import exactly (kept for back-compat with previously-exported CSVs). */
export function buildWidePatches(
  dataRows: string[][],
  header: string[],
  bindingByCode: Map<string, BindingRow>,
  productByCode: Map<string, MfgProductRow>,
  sofaHeights: string[],
): { patches: Map<string, AccumPatch>; skippedUnknown: number } {
  const idx = (col: string) => header.indexOf(col);
  const colCode = idx('internal_code');
  const sofaColIndex = new Map<string, Map<'P1' | 'P2' | 'P3', number>>();
  for (const h of sofaHeights) {
    const inner = new Map<'P1' | 'P2' | 'P3', number>();
    for (const t of SOFA_TIERS_FOR_EXPORT) {
      const i = idx(`sofa_${h}_${t}`);
      if (i >= 0) inner.set(t, i);
    }
    sofaColIndex.set(h, inner);
  }
  const colBedP1 = idx('bedframe_P1');
  const colBedP2 = idx('bedframe_P2');
  const colUnitPriceRm = idx('unit_price_rm');
  const scalarCols = { supSku: idx('supplier_sku'), lead: idx('lead_time_days'), moq: idx('moq'), main: idx('is_main_supplier') };

  const patches = new Map<string, AccumPatch>();
  let skippedUnknown = 0;

  for (const r of dataRows) {
    const code = (r[colCode] ?? '').trim();
    if (!code) continue;
    const binding = bindingByCode.get(code);
    if (!binding) { skippedUnknown += 1; continue; }
    const kind = csvKindForProduct(productByCode.get(code));

    const patch: Partial<NewBinding> = {};
    applyScalarCols(r, scalarCols, binding, patch);
    if (kind === 'other' && colUnitPriceRm >= 0) {
      const sen = parseRmCell(r[colUnitPriceRm]);
      if (sen != null && sen !== binding.unit_price_sen) patch.unitPriceSen = sen;
    }

    // Price matrix updates are wholesale (send the merged matrix) so a partial
    // sheet doesn't wipe other categories' data.
    if (kind === 'sofa') {
      const next: SofaPriceMatrix = { ...((binding.price_matrix ?? {}) as SofaPriceMatrix) };
      let changed = false;
      for (const h of sofaHeights) {
        const inner = { ...(next[h] ?? {}) } as { P1?: number; P2?: number; P3?: number };
        let innerChanged = false;
        const indices = sofaColIndex.get(h);
        if (!indices) continue;
        for (const t of SOFA_TIERS_FOR_EXPORT) {
          const colIdx = indices.get(t);
          if (colIdx == null) continue;
          const sen = parseRmCell(r[colIdx]);
          if (sen == null) {
            if (inner[t] !== undefined) { delete inner[t]; innerChanged = true; }
          } else if (inner[t] !== sen) { inner[t] = sen; innerChanged = true; }
        }
        if (innerChanged) {
          if (Object.keys(inner).length === 0) delete next[h];
          else next[h] = inner;
          changed = true;
        }
      }
      if (changed) patch.priceMatrix = Object.keys(next).length === 0 ? null : next;
    } else if (kind === 'bedframe') {
      const next: BedframePriceMatrix = { ...((binding.price_matrix ?? {}) as BedframePriceMatrix) };
      let changed = false;
      if (colBedP1 >= 0) {
        const sen = parseRmCell(r[colBedP1]);
        if (sen == null) { if (next.P1 !== undefined) { delete next.P1; changed = true; } }
        else if (next.P1 !== sen) { next.P1 = sen; changed = true; }
      }
      if (colBedP2 >= 0) {
        const sen = parseRmCell(r[colBedP2]);
        if (sen == null) { if (next.P2 !== undefined) { delete next.P2; changed = true; } }
        else if (next.P2 !== sen) { next.P2 = sen; changed = true; }
      }
      if (changed) patch.priceMatrix = Object.keys(next).length === 0 ? null : next;
    }

    if (Object.keys(patch).length > 0) patches.set(binding.id, { binding, patch });
  }
  return { patches, skippedUnknown };
}

/** LONG parser — one row per binding × price-point. Multiple rows for the same
 *  internal_code merge: scalars take last non-blank; each row layers ONE matrix
 *  cell (sofa height×tier, or bedframe tier, or the flat unit price) onto the
 *  binding's current matrix. Blank price clears that cell. */
export function buildLongPatches(
  dataRows: string[][],
  header: string[],
  bindingByCode: Map<string, BindingRow>,
  productByCode: Map<string, MfgProductRow>,
): { patches: Map<string, AccumPatch>; skippedUnknown: number } {
  const idx = (col: string) => header.indexOf(col);
  const colCode = idx('internal_code');
  const colCategory = idx('category');
  const colHeight = idx('height');
  const colTier = idx('tier');
  const colPriceRm = idx('price_rm');
  const scalarCols = { supSku: idx('supplier_sku'), lead: idx('lead_time_days'), moq: idx('moq'), main: idx('is_main_supplier') };

  const patches = new Map<string, AccumPatch>();
  // Track the running merged matrix per binding so successive long rows layer
  // onto the SAME object (not the binding's pristine matrix each time).
  const sofaMatrices = new Map<string, SofaPriceMatrix>();
  const bedMatrices = new Map<string, BedframePriceMatrix>();
  const sofaTouched = new Set<string>();
  const bedTouched = new Set<string>();
  const skippedCodes = new Set<string>();

  for (const r of dataRows) {
    const code = (r[colCode] ?? '').trim();
    if (!code) continue;
    const binding = bindingByCode.get(code);
    if (!binding) { skippedCodes.add(code); continue; }

    const acc = patches.get(binding.id) ?? { binding, patch: {} as Partial<NewBinding> };
    patches.set(binding.id, acc);
    applyScalarCols(r, scalarCols, binding, acc.patch);

    // Prefer the row's own `category` column; fall back to the product's kind
    // (lets a hand-written sheet omit category for non-matrix items).
    const catCell = colCategory >= 0 ? (r[colCategory] ?? '').trim().toLowerCase() : '';
    const kind: CsvKind =
      catCell === 'sofa' ? 'sofa'
        : catCell === 'bedframe' ? 'bedframe'
          : catCell === 'other' ? 'other'
            : csvKindForProduct(productByCode.get(code));

    const sen = colPriceRm >= 0 ? parseRmCell(r[colPriceRm]) : null;
    const tier = (colTier >= 0 ? (r[colTier] ?? '').trim().toUpperCase() : '');
    const height = colHeight >= 0 ? (r[colHeight] ?? '').trim() : '';

    if (kind === 'other') {
      // Flat unit price. Blank price on an "other" row = no change (don't zero
      // a price just because an anchor row carried no value).
      if (sen != null && sen !== binding.unit_price_sen) acc.patch.unitPriceSen = sen;
    } else if (kind === 'bedframe') {
      if (tier === 'P1' || tier === 'P2') {
        const m = bedMatrices.get(binding.id) ?? { ...((binding.price_matrix ?? {}) as BedframePriceMatrix) };
        if (sen == null) delete m[tier]; else m[tier] = sen;
        bedMatrices.set(binding.id, m);
        bedTouched.add(binding.id);
      }
      // tier blank → anchor row for an empty binding; nothing to layer.
    } else { // sofa
      if (height && (tier === 'P1' || tier === 'P2' || tier === 'P3')) {
        const m = sofaMatrices.get(binding.id) ?? { ...((binding.price_matrix ?? {}) as SofaPriceMatrix) };
        const inner = { ...(m[height] ?? {}) } as { P1?: number; P2?: number; P3?: number };
        if (sen == null) delete inner[tier]; else inner[tier] = sen;
        if (Object.keys(inner).length === 0) delete m[height];
        else m[height] = inner;
        sofaMatrices.set(binding.id, m);
        sofaTouched.add(binding.id);
      }
    }
  }

  // Fold the merged matrices into each binding's patch (wholesale send).
  for (const id of sofaTouched) {
    const acc = patches.get(id);
    if (!acc) continue;
    const m = sofaMatrices.get(id)!;
    acc.patch.priceMatrix = Object.keys(m).length === 0 ? null : m;
  }
  for (const id of bedTouched) {
    const acc = patches.get(id);
    if (!acc) continue;
    const m = bedMatrices.get(id)!;
    acc.patch.priceMatrix = Object.keys(m).length === 0 ? null : m;
  }

  // Drop bindings whose accumulated patch ended up empty (anchor-only rows).
  for (const [id, acc] of patches) {
    if (Object.keys(acc.patch).length === 0) patches.delete(id);
  }
  return { patches, skippedUnknown: skippedCodes.size };
}

/* A blank binding for an unknown code — the empty BASE the shared builders
   layer a create's prices/sku onto, so the create parse reuses the exact same
   money/matrix logic as the update parse (no second, divergent parser). */
const NEW_ID_PREFIX = 'NEW::';
function blankBinding(code: string, product: MfgProductRow | undefined): BindingRow {
  return {
    id: `${NEW_ID_PREFIX}${code}`,
    supplier_id: '',
    material_kind: 'mfg_product',
    item_code: code,
    ac_item_code: null,
    material_name: product?.name ?? '',
    supplier_sku: '',
    unit_price_sen: 0,
    currency: 'MYR',
    lead_time_days: 0,
    payment_terms_override: null,
    moq: 0,
    price_valid_from: null,
    price_valid_to: null,
    is_main_supplier: false,
    notes: null,
    price_matrix: null,
    is_cost_anchor: false,
    created_at: '',
    updated_at: '',
  };
}

/* B3 (2026-09-17) — build CREATE rows for internal_codes in the sheet that this
   supplier is NOT yet bound to. Runs the SAME builder over a blank base binding
   per unknown code, then converts the resulting patch to a NewBinding. A create
   always carries a non-empty materialName + supplierSku (batch create requires
   them): fall back to the catalogue name / composed sku, else the code itself.
   Exported for the unit test. */
export function buildCreates(
  dataRows: string[][],
  header: string[],
  format: ImportFormat,
  bindingByCode: Map<string, BindingRow>,
  productByCode: Map<string, MfgProductRow>,
  sofaHeights: string[],
): NewBinding[] {
  const colCode = header.indexOf('internal_code');
  if (colCode < 0) return [];
  const unknownCodes: string[] = [];
  const seen = new Set<string>();
  for (const r of dataRows) {
    const code = (r[colCode] ?? '').trim();
    if (!code || bindingByCode.has(code) || seen.has(code)) continue;
    seen.add(code);
    unknownCodes.push(code);
  }
  if (unknownCodes.length === 0) return [];

  const blankByCode = new Map<string, BindingRow>();
  for (const code of unknownCodes) blankByCode.set(code, blankBinding(code, productByCode.get(code)));

  const { patches } = format === 'long'
    ? buildLongPatches(dataRows, header, blankByCode, productByCode)
    : buildWidePatches(dataRows, header, blankByCode, productByCode, sofaHeights);

  return unknownCodes.map((code) => {
    const patch = patches.get(`${NEW_ID_PREFIX}${code}`)?.patch ?? {};
    const product = productByCode.get(code);
    const materialName = (product?.name ?? '').trim() || code;
    const supplierSku = (patch.supplierSku ?? '').trim()
      || (product ? (composeSupplierSku(code, product) || '') : '').trim()
      || code;
    return {
      materialKind: 'mfg_product',
      itemCode: code,
      materialName,
      supplierSku,
      unitPriceSen: patch.unitPriceSen ?? 0,
      leadTimeDays: patch.leadTimeDays,
      moq: patch.moq,
      isMainSupplier: patch.isMainSupplier,
      priceMatrix: patch.priceMatrix,
    };
  });
}

type ImportPreview = {
  format: ImportFormat;
  updates: { binding: BindingRow; patch: Partial<NewBinding> }[];
  creates: NewBinding[];
};

export const ImportBindingsDialog = ({
  supplierId,
  bindings,
  products,
  sofaHeights,
  onClose,
}: {
  supplierId: string;
  bindings: BindingRow[];
  products: MfgProductRow[];
  sofaHeights: string[];
  onClose: () => void;
}) => {
  const update = useUpdateBinding();
  const batch = useCreateBindingsBatch();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const productByCode = useMemo(
    () => new Map<string, MfgProductRow>(products.map((p) => [p.code, p])),
    [products],
  );

  const bindingByCode = useMemo(
    () => new Map<string, BindingRow>(bindings.map((b) => [b.item_code, b])),
    [bindings],
  );

  const fmtRm = (sen: number | undefined) => `RM ${((sen ?? 0) / 100).toFixed(2)}`;

  // Parse + classify WITHOUT writing anything — money-sensitive, so the operator
  // sees exactly what will be created and updated before committing.
  const doPreview = async () => {
    if (!file || parsing || running) return;
    setParsing(true);
    setSummary(null);
    setPreview(null);
    try {
      const fname = file.name.toLowerCase();
      let rows: string[][];
      if (fname.endsWith('.xlsx') || fname.endsWith('.xls')) {
        rows = await readXlsxGrid(file);
      } else {
        let text = await file.text();
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip Excel UTF-8 BOM
        rows = parseCsv(text);
      }
      if (rows.length < 2) { setSummary('File has no data rows.'); return; }
      const header = rows[0]!.map((h) => h.trim());
      if (header.indexOf('internal_code') < 0) { setSummary('Missing required column: internal_code'); return; }
      const dataRows = rows.slice(1);

      const format = detectImportFormat(header);
      const { patches } = format === 'long'
        ? buildLongPatches(dataRows, header, bindingByCode, productByCode)
        : buildWidePatches(dataRows, header, bindingByCode, productByCode, sofaHeights);
      const creates = buildCreates(dataRows, header, format, bindingByCode, productByCode, sofaHeights);
      setPreview({ format, updates: Array.from(patches.values()), creates });
    } finally {
      setParsing(false);
    }
  };

  const apply = async () => {
    if (!preview || running) return;
    setRunning(true);
    try {
      let created = 0;
      let createFailed = 0;
      // Auto-create the missing bindings via the company-scoped batch endpoint
      // (it skips any code already bound and stamps the active company).
      if (preview.creates.length > 0) {
        try {
          const res = await batch.mutateAsync({ supplierId, bindings: preview.creates });
          created = (res as { inserted?: number }).inserted ?? preview.creates.length;
        } catch {
          createFailed = preview.creates.length;
        }
      }

      let updated = 0;
      let failed = 0;
      const accs = preview.updates;
      setProgress({ done: 0, total: accs.length });
      for (let i = 0; i < accs.length; i++) {
        const { binding, patch } = accs[i]!;
        try {
          await update.mutateAsync({ supplierId, bindingId: binding.id, ...patch });
          updated += 1;
        } catch {
          failed += 1;
        }
        setProgress({ done: i + 1, total: accs.length });
      }

      const parts: string[] = [];
      parts.push(`Created ${created} · updated ${updated}`);
      parts.push(`${preview.format} format`);
      if (createFailed > 0) parts.push(`${createFailed} create${createFailed === 1 ? '' : 's'} failed`);
      if (failed > 0) parts.push(`${failed} update${failed === 1 ? '' : 's'} failed`);
      setSummary(parts.join(' · '));
      setPreview(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div
        className={styles.modal}
        style={{ width: 'min(560px, 95vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>Import Bindings (CSV / Excel)</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close">
            <X {...ICON} />
          </button>
        </header>
        <div className={styles.modalBody}>
          <p style={{ fontSize: 'var(--fs-12)', color: '#767b6e', marginBottom: 'var(--space-3)' }}>
            Upload a CSV or Excel file (exported via <strong>Export Bindings</strong>, or the
            worklist columns <code>internal_code / supplier_sku / price_rm</code>). Both the
            <strong> long</strong> and legacy <strong>wide</strong> layouts are detected
            automatically. Rows matching an existing binding are <strong>updated</strong>;
            unknown <code>internal_code</code>s are <strong>created</strong>. Preview shows
            exactly what will be created and updated before anything is written.
          </p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            disabled={parsing || running}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setSummary(null); }}
            style={{ marginBottom: 'var(--space-3)' }}
          />
          {preview && (
            <div style={{
              fontSize: 'var(--fs-13)', color: '#11140f', padding: 'var(--space-2) var(--space-3)',
              background: '#fff', border: '1px solid #d6d9d2', borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {preview.format} format · {preview.creates.length} to create · {preview.updates.length} to update
              </div>
              {preview.creates.length > 0 && (
                <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 4 }}>
                  <div style={{ fontSize: 'var(--fs-11)', color: '#767b6e', marginBottom: 2 }}>New bindings:</div>
                  {preview.creates.map((c) => (
                    <div key={c.itemCode} style={{ fontSize: 'var(--fs-12)', fontFamily: 'var(--font-mono, monospace)' }}>
                      {c.itemCode} → {c.supplierSku} · {fmtRm(c.unitPriceSen)}{c.priceMatrix ? ' · matrix' : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {progress.total > 0 && running && (
            <p style={{ fontSize: 'var(--fs-12)', color: '#767b6e' }}>
              Updating {progress.done} / {progress.total}…
            </p>
          )}
          {summary && (
            <p style={{
              fontSize: 'var(--fs-13)',
              color: '#11140f',
              padding: 'var(--space-2) var(--space-3)',
              background: '#fff',
              border: '1px solid #d6d9d2',
              borderRadius: 'var(--radius-md)',
              marginTop: 'var(--space-2)',
            }}>
              {summary}
            </p>
          )}
        </div>
        <footer className={styles.modalFooter}>
          <Button variant="ghost" onClick={onClose} disabled={parsing || running}>
            {summary ? 'Close' : 'Cancel'}
          </Button>
          {preview ? (
            <Button variant="primary" onClick={apply} disabled={running}>
              {running ? 'Applying…' : `Apply (${preview.creates.length} + ${preview.updates.length})`}
            </Button>
          ) : (
            <Button variant="primary" onClick={doPreview} disabled={!file || parsing}>
              {parsing ? 'Reading…' : 'Preview'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
};
