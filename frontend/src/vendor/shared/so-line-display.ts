// ----------------------------------------------------------------------------
// so-line-display — CUSTOMER-FACING display folding of SO lines.
//
// Loo 2026-06-05: on customer-facing surfaces (POS SalesOrderPrint, Backend
// sales-order-pdf, POS order drawer) a configured sofa should read as ONE line
// per Model with the combined price ("SOFA BOOQIT — MYR 3,115.00"), while the
// persisted per-module SKU lines (P3 sofa split, so-sofa-split.ts) stay
// untouched and keep driving Backend SO Details, reports, DO picking and
// inventory. This module is a pure RENDER-TIME fold — it never mutates lines.
//
// Grouping key: variants.buildKey (written by the SO create path per build,
// e.g. "build-1"). In-group order is the LEFT-TO-RIGHT walk of the build's
// persisted geometry (variants x/y/rot — Loo 2026-06-12: compartment codes
// always read leftmost arm → rightmost arm, so SOs booked before the create
// path ordered its lines still display correctly), falling back to
// variants.cellIndex when geometry is missing. Lines without a buildKey
// (legacy pre-P3 SOs, services, bedframes, mattresses) pass through 1:1 —
// legacy multi-row sofas CANNOT be grouped reliably (SO-2606-010 holds
// three different Models as separate single-module purchases), so we never
// guess.
//
// Money: the P3 split floors every share and puts the rounding residue on the
// last line, so summing unit_price_centi / total_centi across a buildKey group
// reconstructs the build total EXACTLY (discount is netted on the lead line's
// total already).
//
// PWP notes (same ask): pwp_codes always intended the unused voucher to print
// on the SO (schema.ts: "printed on the SO, redeemable cross-order") — this is
// the render half. The reward line carries variants.pwpCode/pwpTriggerLabel;
// the trigger line is matched via pwp_codes.trigger_item_code at print time.
// ----------------------------------------------------------------------------

import { orderSofaCellsLeftToRight, type Rot } from './sofa-build';

/** Minimal raw SO line shape (snake_case = the API row verbatim). Callers pass
 *  their richer row type; the fold preserves it via the generic. */
export interface RawSoDisplayLine {
  item_code: string;
  description?: string | null;
  description2?: string | null;
  qty?: number | null;
  unit_price_centi?: number | null;
  discount_centi?: number | null;
  total_centi?: number | null;
  variants?: unknown;
  /** Per-line operator remark (mfg_sales_order_items.remark). Optional —
   *  legacy callers that don't select it simply fold without remarks. */
  remark?: string | null;
}

/** One display row after folding: either a single original line, or a sofa
 *  build folded to one Model-level row. `lines` always holds the originals. */
export interface SoDisplayGroup<T extends RawSoDisplayLine> {
  kind: 'single' | 'sofa-build';
  lines: T[];
  /** Folded presentation — only for kind 'sofa-build'. */
  display?: {
    /** Model token, e.g. 'BOOQIT' (item_code prefix before the module code). */
    itemCode: string;
    /** 'SOFA BOOQIT' — module suffix dropped. */
    description: string;
    /** '1B(LHF) + CNR + 2A(RHF)' — module codes in left-to-right walk order. */
    composition: string | null;
    /** Shared per-line variant summary (e.g. 'EZ-003 / SEAT 28 / LEG 4"'). */
    description2: string | null;
    qty: number;
    unitPriceCenti: number;
    discountCenti: number;
    totalCenti: number;
    /** First non-empty remark in display order across the group; null if none. */
    remark: string | null;
  };
}

const readVariants = (line: RawSoDisplayLine): Record<string, unknown> | null =>
  line.variants && typeof line.variants === 'object' && !Array.isArray(line.variants)
    ? (line.variants as Record<string, unknown>)
    : null;

const readBuildKey = (line: RawSoDisplayLine): string | null => {
  const v = readVariants(line);
  const k = v?.buildKey;
  return typeof k === 'string' && k.trim() !== '' ? k : null;
};

const readCellIndex = (line: RawSoDisplayLine): number => {
  const v = readVariants(line);
  const idx = v?.cellIndex;
  return typeof idx === 'number' && Number.isFinite(idx) ? idx : Number.MAX_SAFE_INTEGER;
};

/** Model token from a module SKU: everything before the LAST '-'.
 *  'BOOQIT-2A(RHF)' → 'BOOQIT'. Compartment codes are parens-vocabulary
 *  (1A(LHF) — the dash vocabulary was eliminated 2026-06-04) so the module
 *  suffix itself never contains '-'. */
const modelTokenOf = (itemCode: string): string | null => {
  const idx = itemCode.lastIndexOf('-');
  return idx > 0 ? itemCode.slice(0, idx) : null;
};

/** Module code = the suffix after the last '-'. */
const moduleCodeOf = (itemCode: string): string =>
  itemCode.slice(itemCode.lastIndexOf('-') + 1);

/** Composition = the module codes joined in the lines' (already left-to-right)
 *  order. The stored variants.summary first segment is only a fallback — it
 *  snapshots whatever order the POS topbar had at add time, which on
 *  pre-2026-06-12 orders is the canvas/Quick-Pick slot order, not the walk. */
const compositionOf = <T extends RawSoDisplayLine>(lines: T[]): string | null => {
  const codes = lines.map((l) => moduleCodeOf(l.item_code)).filter(Boolean);
  if (codes.length > 0) return codes.join(' + ');
  const v = readVariants(lines[0]!);
  const summary = v?.summary;
  if (typeof summary === 'string' && summary.trim() !== '') {
    const first = summary.split('·')[0]?.trim();
    if (first) return first;
  }
  return null;
};

/** Left-to-right order for one buildKey group's lines: rebuild each line's
 *  cell from the geometry the P3 split persisted on variants (x/y/rot +
 *  module code from the SKU suffix) and run the shared walk. Any line
 *  missing geometry → the whole group falls back to cellIndex order (which
 *  the create path also writes left-to-right since 2026-06-12). */
const orderSofaGroupLines = <T extends RawSoDisplayLine>(group: T[]): T[] => {
  const byCellIndex = [...group].sort((a, b) => readCellIndex(a) - readCellIndex(b));
  const wrapped: Array<{ row: T; moduleId: string; x: number; y: number; rot: Rot }> = [];
  for (const l of byCellIndex) {
    const v = readVariants(l);
    const x = typeof v?.x === 'number' && Number.isFinite(v.x) ? v.x : null;
    const y = typeof v?.y === 'number' && Number.isFinite(v.y) ? v.y : null;
    const rot = typeof v?.rot === 'number' ? ((((v.rot % 360) + 360) % 360) as Rot) : 0;
    const moduleId = moduleCodeOf(l.item_code);
    if (x === null || y === null || !moduleId) return byCellIndex;
    wrapped.push({ row: l, moduleId, x, y, rot });
  }
  // Coerce like the create-side split (String(depth)) — variants.depth is
  // string today but the API accepts numeric depth in raw payloads.
  const d = readVariants(byCellIndex[0]!)?.depth;
  const depth =
    typeof d === 'string' && d.trim() !== '' ? d
    : typeof d === 'number' && Number.isFinite(d) ? String(d)
    : '24';
  return orderSofaCellsLeftToRight(wrapped, depth)
    .map((w) => (w as (typeof wrapped)[number]).row);
};

/**
 * Fold per-module sofa lines (same variants.buildKey, >1 line, all qty 1) into
 * one Model-level display group; everything else passes through as 'single'.
 * Output preserves the input order — a folded group sits where its first line
 * was. Pure; never mutates the input lines.
 */
export function groupSoLinesForDisplay<T extends RawSoDisplayLine>(
  lines: T[],
): SoDisplayGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const line of lines) {
    const key = readBuildKey(line);
    if (!key) continue;
    const arr = byKey.get(key) ?? [];
    arr.push(line);
    byKey.set(key, arr);
  }

  const out: SoDisplayGroup<T>[] = [];
  const folded = new Set<T>();
  for (const line of lines) {
    if (folded.has(line)) continue;
    const key = readBuildKey(line);
    const group = key ? byKey.get(key) : null;

    // Fold only real multi-module builds where every line is one unit and the
    // Model token is consistent — anything irregular stays per-SKU (honest
    // fallback; never guess a grouping the data doesn't support).
    const models = group?.map((l) => modelTokenOf(l.item_code)) ?? [];
    const model = models[0] ?? null;
    const foldable =
      !!group && group.length > 1 &&
      group.every((l) => Number(l.qty ?? 0) === 1) &&
      !!model && models.every((m) => m === model);

    if (!foldable || !group) {
      out.push({ kind: 'single', lines: [line] });
      continue;
    }

    const ordered = orderSofaGroupLines(group);
    for (const l of ordered) folded.add(l);
    const lead = ordered[0]!;
    out.push({
      kind: 'sofa-build',
      lines: ordered,
      display: {
        itemCode: model!,
        description: `SOFA ${model!}`,
        composition: compositionOf(ordered),
        description2: lead.description2 ?? null,
        qty: 1,
        unitPriceCenti: ordered.reduce((s, l) => s + Number(l.unit_price_centi ?? 0), 0),
        /* Summed, not lead-read: the discount is persisted on the CREATE
           path's first line, which the left-to-right walk may no longer put
           first. Only one line ever carries it, so Σ === the build figure. */
        discountCenti: ordered.reduce((s, l) => s + Number(l.discount_centi ?? 0), 0),
        totalCenti: ordered.reduce((s, l) => s + Number(l.total_centi ?? 0), 0),
        remark: ordered.find((l) => typeof l.remark === 'string' && l.remark.trim() !== '')?.remark ?? null,
      },
    });
  }
  return out;
}

// ───────────────────── SO line ORDER rules (Loo 2026-06-12) ─────────────────
// Priority lines: the MAINS — sofa, mattress, bedframe — lead every SO line
// listing; accessories follow; SERVICE rows close the document. Within a rank
// the stored order is preserved (stable sort). Shared so the CREATE path (the
// persisted row order), the Backend SO PDF and the POS customer print all
// rank identically.

export const soLineGroupRank = (itemGroup: string | null | undefined): number => {
  const g = (itemGroup ?? '').toLowerCase();
  if (g.includes('sofa') || g.includes('mattress')) return 0;
  if (g.includes('bedframe')) return 1;
  if (g.includes('accessor')) return 2;
  if (g.includes('service')) return 4;
  return 3;
};

/** Stable category sort: mains → accessories → others → services. The
 *  `groupOf` getter keeps this generic over row shapes (DB rows are
 *  snake_case item_group, POS marshalling is camelCase itemGroup). */
export const sortSoLinesByGroupRank = <T>(
  lines: readonly T[],
  groupOf: (line: T) => string | null | undefined,
): T[] =>
  lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) =>
      (soLineGroupRank(groupOf(a.l)) - soLineGroupRank(groupOf(b.l))) || (a.i - b.i))
    .map((e) => e.l);

/** Re-order each buildKey group's module rows left-to-right IN PLACE of the
 *  slots the group already occupies — for per-SKU listings that don't fold
 *  (the Backend SO PDF prints one row per module). Row count and the
 *  positions of non-sofa rows are untouched; only a build's members permute
 *  among their own positions. */
export const orderSofaModuleRowsWithinBuilds = <T extends RawSoDisplayLine>(lines: T[]): T[] => {
  const byKey = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const key = readBuildKey(l);
    if (!key) return;
    const arr = byKey.get(key) ?? [];
    arr.push(i);
    byKey.set(key, arr);
  });
  const out = [...lines];
  for (const positions of byKey.values()) {
    if (positions.length <= 1) continue;
    const ordered = orderSofaGroupLines(positions.map((i) => lines[i]!));
    positions.forEach((pos, k) => { out[pos] = ordered[k]!; });
  }
  return out;
};

// ─────────────────────────────── PWP notes ──────────────────────────────────

/** pwp_codes row as returned by GET /mfg-sales-orders/:docNo (codes whose
 *  source_doc_no = this SO — i.e. vouchers THIS order's trigger items issued). */
export interface SoPwpCodeRow {
  code: string;
  status: string; // RESERVED | USED | AVAILABLE | VOID (issuing order cancelled)
  trigger_item_code?: string | null;
  redeemed_doc_no?: string | null;
  /** The POS cart line that earned this code — groups codes into per-trigger-line
   *  batches for display allocation. Null on legacy codes. */
  cart_line_key?: string | null;
}

export interface SoPwpNote {
  /** 'used' renders accented (voucher consumed), 'unused' renders muted. */
  tone: 'used' | 'unused';
  text: string;
}

/** Notes for a REWARD line (variants.pwp === true): the voucher it consumed. */
export function pwpRewardNote(variants: unknown): SoPwpNote | null {
  const v = variants && typeof variants === 'object' && !Array.isArray(variants)
    ? (variants as Record<string, unknown>)
    : null;
  if (v?.pwp !== true) return null;
  const code = typeof v.pwpCode === 'string' && v.pwpCode.trim() !== '' ? v.pwpCode : null;
  const label = typeof v.pwpTriggerLabel === 'string' && v.pwpTriggerLabel.trim() !== ''
    ? v.pwpTriggerLabel
    : null;
  const parts = ['PWP price'];
  if (code) parts.push(`PWP: ${code}`);
  if (label) parts.push(`redeemed with ${label}`);
  return { tone: 'used', text: parts.join(' · ') };
}

const pwpTriggerNoteOf = (cd: SoPwpCodeRow): SoPwpNote => {
  if (cd.status === 'USED') return { tone: 'used', text: `PWP: ${cd.code}` };
  /* A voided voucher must never read as "not redeemed yet" — the order that
     issued it was cancelled, so it is dead, not pending (2026-07-29). */
  if (cd.status === 'VOID') {
    return { tone: 'unused', text: `PWP voucher issued: ${cd.code} · voided (order cancelled)` };
  }
  return { tone: 'unused', text: `PWP voucher issued: ${cd.code} · not redeemed yet` };
};

/** Notes for a TRIGGER line: vouchers this SO issued off this item_code.
 *  USED → short reference; otherwise → 排法 A "issued, not redeemed yet".
 *  Per-line matcher — when the SAME item_code appears on several lines this
 *  repeats the full voucher list under each; document renderers should use
 *  allocatePwpTriggerNotes instead. */
export function pwpTriggerNotes(
  itemCodes: string[],
  codes: SoPwpCodeRow[] | null | undefined,
): SoPwpNote[] {
  if (!codes || codes.length === 0) return [];
  const mine = codes.filter(
    (cd) => !!cd.trigger_item_code && itemCodes.includes(cd.trigger_item_code),
  );
  return mine.map(pwpTriggerNoteOf);
}

/**
 * Document-level trigger-note allocation: each voucher prints exactly ONCE.
 * (SO-2606-013, Loo 2026-06-12 — two lines of the same trigger SKU repeated
 * the full 8-voucher list under BOTH lines.)
 *
 * `lineItemCodes` = per display line (in render order), the item_codes it
 * covers (a folded sofa group passes all module codes). Codes are batched by
 * trigger_item_code + cart_line_key (one batch per earning cart line, in the
 * given code order — callers receive them created_at-ordered); the k-th batch
 * of a trigger SKU lands on the k-th line carrying that SKU, extra batches
 * pile on its last line, legacy null-key codes form one batch on the first.
 * Returns one SoPwpNote[] per input line.
 */
export function allocatePwpTriggerNotes(
  lineItemCodes: string[][],
  codes: SoPwpCodeRow[] | null | undefined,
): SoPwpNote[][] {
  const out: SoPwpNote[][] = lineItemCodes.map(() => []);
  if (!codes || codes.length === 0) return out;

  // Batch by trigger SKU + earning cart line, preserving code order.
  const batches = new Map<string, { trigger: string; rows: SoPwpCodeRow[] }>();
  for (const cd of codes) {
    const trigger = cd.trigger_item_code ?? '';
    if (!trigger) continue;
    const key = `${trigger}␟${cd.cart_line_key ?? ''}`;
    const batch = batches.get(key) ?? { trigger, rows: [] };
    batch.rows.push(cd);
    batches.set(key, batch);
  }

  // k-th batch of a trigger → k-th line carrying that SKU (overflow → last).
  const nextOrdinal = new Map<string, number>();
  for (const { trigger, rows } of batches.values()) {
    const matching: number[] = [];
    lineItemCodes.forEach((codesOfLine, i) => {
      if (codesOfLine.includes(trigger)) matching.push(i);
    });
    /* No line carries the trigger SKU (SO-2606-008, Loo 2026-06-12) — the
       voucher is real and redeemable, so it must still print rather than
       silently vanish. Happens when the stamped trigger drifted from the
       booked lines (the pre-fix create path stamped the POS sofa ANCHOR SKU,
       which the per-module split never books). Fall back to the first line. */
    if (matching.length === 0) {
      if (out.length > 0) out[0]!.push(...rows.map(pwpTriggerNoteOf));
      continue;
    }
    const ord = nextOrdinal.get(trigger) ?? 0;
    nextOrdinal.set(trigger, ord + 1);
    const lineIdx = matching[Math.min(ord, matching.length - 1)]!;
    out[lineIdx]!.push(...rows.map(pwpTriggerNoteOf));
  }
  return out;
}
