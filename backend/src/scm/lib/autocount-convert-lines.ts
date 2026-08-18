// ----------------------------------------------------------------------------
// autocount-convert-lines — the four DOWNSTREAM document shapes, and WHICH
// SOURCE LINES a conversion actually took.
//
// SPLIT OUT OF autocount-outbox.ts on 2026-08-18, when naming every source of a
// MERGED conversion pushed that file back over the 2,000-line cap. Same seam
// autocount-read.ts was cut on a few days earlier, and a seam for the same
// reason: this is one idea — what a conversion moved, and how each downstream
// document describes itself — and the rest of the outbox neither knows nor
// needs how these answer.
//
// The idea is worth finding on its own, because getting it wrong is SILENT. A
// conversion that names no lines is not refused by AutoCount: the service falls
// back to every still-outstanding line on each named source, so the account book
// moves stock the ERP never moved and the outbox row still reads `sent`.
//
// ONE-WAY BY CONSTRUCTION. autocount-outbox.ts imports the values here; this
// module takes only TYPES back from it, and a type import is erased at compile
// time, so the two cannot form a runtime cycle.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AcOp, ErpLine } from '../../services/autocount-writeback';
import { composeDescription2 } from '../../services/autocount-writeback';
import { readOrThrow } from './autocount-read';
import type { AcLineTable, AcLinkTable, AcOutboxPayload } from './autocount-outbox';

type Sb = SupabaseClient<any, any, any>;

/* Declared HERE rather than beside the other enqueue helpers: DOWNSTREAM below
   is a module-level const that references it during module evaluation, so a
   later `const soLine` would be in its temporal dead zone and every import of
   this module would throw. */
export const soLine = (r: Record<string, unknown>): ErpLine => ({
  id: r.id == null ? null : String(r.id),
  item_code: String(r.item_code ?? r.material_code ?? ''),
  item_group: (r.item_group as string) ?? null,
  /* undefined on the five tables that do not select it, which soBranding reads
     as "this line has no brand" — the same convention `cancelled` runs under. */
  branding: (r.branding as string) ?? null,
  description: (r.description as string) ?? null,
  description2: (r.description2 as string) ?? null,
  qty: Number(r.qty ?? 0),
  unit_price_centi: Number(r.unit_price_centi ?? 0),
  variants: (r.variants as Record<string, unknown> | null) ?? null,
  linked_ac_dtlkey: (r.linked_ac_dtlkey as number | null) ?? null,
  /* `line_delivery_date` on a sales-order line, `delivery_date` on a purchase
     one — the same fact under two column names. Null on the four DOWNSTREAM
     tables, whose column lists select neither, and that costs them nothing:
     those documents only ever reach `/edit`, where composeEdit drops a null
     DeliveryDate rather than blanking the date the conversion gave the book.
     Same reasoning DOWNSTREAM's header already records for DocDate. */
  delivery_date: (r.line_delivery_date as string | null) ?? (r.delivery_date as string | null) ?? null,
  /* undefined on the five tables that have no such column, which composeEdit
     reads as "live" — the same answer the column's own default gives. */
  cancelled: r.cancelled === true,
  /* Filled in by withLocations below. The raw column is a warehouse UUID and
     AutoCount wants the short code, so the line cannot carry it on its own. */
  location: null,
});

export interface AcDownstreamSpec {
  table: AcLinkTable;
  itemTable: AcLineTable;
  /** The column on the item table that points back at the header. */
  itemFk: string;
  /** The line table this document's lines were transferred FROM. */
  sourceItemTable: AcLineTable;
  /** The column on the item table naming the SOURCE line it came from. NULL
   *  there means an ad-hoc line with no counterpart to transfer. */
  sourceFk: string;
  headerCols: string;
  itemCols: string;
  /** The human document number, for the outbox row's doc_no. */
  docNoOf: (h: Record<string, unknown>) => string;
  line: (r: Record<string, unknown>) => ErpLine;
  /** NEVER `string | null`: a present-null key BLANKS the book. See `present`. */
  header: (h: Record<string, unknown>) => Record<string, string>;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * A header with every BLANK KEY REMOVED. The one rule /edit runs under.
 *
 * `AcSyncService.Edit()` is `ContainsKey`-gated and `Str` turns a present-null
 * into `""`, so `{Ref: null}` does not mean "unchanged" — it means "blank the
 * reference the account book holds". Every one of these builders emitted
 * `x ?? null` unconditionally, so an edit blanked whatever the ERP's column did
 * not answer for; on the SO that was `ref`, `address3` and `address4` on
 * essentially every ERP-created order (audit 2026-08-14, finding 10).
 *
 * Applied at the ONE place a header is built rather than per key, so the next
 * field added to one of these cannot reintroduce it.
 */
export const present = (o: Record<string, string | null>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const s = (v ?? '').trim();
    if (s) out[k] = s;
  }
  return out;
};

export const DOWNSTREAM: Record<'DO' | 'GR' | 'IV' | 'PI', AcDownstreamSpec> = {
  DO: {
    table: 'delivery_orders',
    itemTable: 'delivery_order_items',
    itemFk: 'delivery_order_id',
    sourceItemTable: 'mfg_sales_order_items',
    sourceFk: 'so_item_id',
    headerCols: 'id, do_number, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.do_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => present({
      DebtorName: str(h.debtor_name),
      Attention: str(h.debtor_name),
      Ref: str(h.ref),
      Phone1: str(h.phone),
      Note: str(h.note),
    }),
  },
  GR: {
    table: 'grns',
    itemTable: 'grn_items',
    itemFk: 'grn_id',
    sourceItemTable: 'purchase_order_items',
    sourceFk: 'purchase_order_item_id',
    headerCols: 'id, grn_number, delivery_note_ref, notes, linked_ac_docno',
    itemCols: 'id, material_code, item_group, description, description2, qty_accepted, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.grn_number ?? h.id ?? ''),
    /* qty_ACCEPTED, not qty_received. AutoCount's GR line quantity is what
       entered stock, and qty_accepted is the number this ERP posts to stock and
       rolls up onto the PO. The received/rejected split has no AutoCount
       counterpart at all, so sending qty_received would make AutoCount's PO
       outstanding disagree with the ERP's by exactly the rejected quantity. */
    line: (r) => soLine({ ...r, qty: r.qty_accepted }),
    header: (h) => present({
      Ref: str(h.delivery_note_ref),
      Description: str(h.notes),
    }),
  },
  IV: {
    table: 'sales_invoices',
    itemTable: 'sales_invoice_items',
    itemFk: 'sales_invoice_id',
    sourceItemTable: 'delivery_order_items',
    sourceFk: 'do_item_id',
    headerCols: 'id, invoice_number, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => present({
      DebtorName: str(h.debtor_name),
      Attention: str(h.debtor_name),
      Ref: str(h.ref),
      Phone1: str(h.phone),
      Note: str(h.note),
    }),
  },
  PI: {
    table: 'purchase_invoices',
    itemTable: 'purchase_invoice_items',
    itemFk: 'purchase_invoice_id',
    sourceItemTable: 'grn_items',
    sourceFk: 'grn_item_id',
    headerCols: 'id, invoice_number, supplier_invoice_ref, notes, linked_ac_docno',
    itemCols: 'id, material_code, item_group, description, description2, qty, unit_price_centi, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    header: (h) => present({
      Ref: str(h.supplier_invoice_ref),
      Description: str(h.notes),
    }),
  },
};

/** The line table each conversion's TARGET lines live in, for key capture. */
export const CONVERT_TARGET: Record<'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi', 'DO' | 'GR' | 'IV' | 'PI'> = {
  so_to_do: 'DO', po_to_gr: 'GR', do_to_iv: 'IV', gr_to_pi: 'PI',
};

/**
 * WHICH LINES OF THE PARENT THIS CONVERSION TOOK, as AutoCount DtlKeys.
 *
 * Three outcomes, and the difference between them is the whole safety argument:
 *
 *   { keys }   — every line of this document names a source line, and every one
 *                of those source lines carries an AutoCount DtlKey. The subset
 *                is expressible exactly, so send it.
 *   { refuse } — the ERP took a STRICT SUBSET of the parent's lines and cannot
 *                name it, because some source line has no DtlKey stored. Sending
 *                no DtlKeys here is the defect: AutoCount would transfer every
 *                outstanding line, shipping or receiving goods in a live book
 *                that did not move in the ERP. A visible skipped row is the
 *                correct outcome; the remedy is the line-key backfill.
 *   {}         — this document covers EVERY line of the parent, so "all
 *                outstanding" and "the lines we took" are the same set and the
 *                account book is the better authority on which are still
 *                untransferred. Also the answer when the ERP cannot read its own
 *                links at all: falling back is exactly the old behaviour, and a
 *                conversion must never be lost to a diagnostic read.
 *
 * NOT COVERED, and deliberately so: partial QUANTITY on a line. The SDK's only
 * primitive is AddPartialTransferDetail(fromType, dtlKeys, bool) — it takes line
 * keys, not quantities, so a DO shipping 2 of a 5-unit line still produces an
 * AutoCount DO of 5 on that line. Naming the right lines does not fix the wrong
 * number on them. See docs/modules/autocount-writeback.md.
 */
export async function readConvertSourceKeys(
  sb: Sb,
  op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>,
  docId: string | null,
): Promise<{ keys?: number[]; refuse?: string }> {
  if (!docId) return {};
  try {
    const spec = DOWNSTREAM[CONVERT_TARGET[op]];
    const { data, error } = await sb.from(spec.itemTable)
      .select(`id, ${spec.sourceFk}`).eq(spec.itemFk, docId);
    if (error || !data) return {};
    const rows = data as unknown as Record<string, unknown>[];
    if (!rows.length) return {};

    const sourceIds = [...new Set(
      rows.map((r) => r[spec.sourceFk]).filter((v): v is string => typeof v === 'string' && !!v),
    )];
    /* Not one line came from a source document. Nothing to name, and the
       parentless / ad-hoc shape is already recorded by its own route. */
    if (!sourceIds.length) return {};

    const { data: src, error: sErr } = await sb.from(spec.sourceItemTable)
      .select('id, linked_ac_dtlkey').in('id', sourceIds);
    if (sErr || !src) return {};
    const srcRows = src as unknown as Array<{ id: string; linked_ac_dtlkey: number | null }>;

    const keys: number[] = [];
    const missing: string[] = [];
    for (const id of sourceIds) {
      const k = srcRows.find((r) => r.id === id)?.linked_ac_dtlkey;
      const n = k == null ? NaN : Number(k);
      if (Number.isFinite(n) && n > 0) keys.push(n); else missing.push(id);
    }
    if (!missing.length) return { keys };

    /* Some source line has no key. Whether that is fatal depends on ONE thing:
       is this a partial transfer? A whole-document transfer degrades safely to
       the old behaviour; a partial one cannot. */
    const partial = await conversionIsPartial(sb, spec, sourceIds);
    if (!partial) return {};
    return {
      refuse:
        `this ${op.replace('_to_', ' -> ').toUpperCase()} transfers only ${sourceIds.length} of the `
        + `source document's lines, and ${missing.length} of them carry no AutoCount DtlKey, so the `
        + 'ERP cannot name the subset. Sending the conversion without DtlKeys would make AutoCount '
        + 'transfer EVERY outstanding line on the source — goods moving in the account book that did '
        + `not move here. Backfill scm.${spec.sourceItemTable}.linked_ac_dtlkey for the source `
        + 'document, then re-raise this document.',
    };
  } catch {
    return {};
  }
}

/**
 * Does this conversion leave any of the parent's lines behind?
 *
 * Answered against the ERP's own parent, not AutoCount's — this decides only
 * whether the FALLBACK ("transfer everything outstanding") is a safe
 * approximation, and the ERP's line set is what the fallback would be wrong
 * about. On any doubt the answer is "partial", because that is the branch that
 * refuses: a wrong "no, it is whole" would let the defect through.
 */
async function conversionIsPartial(
  sb: Sb,
  spec: AcDownstreamSpec,
  takenSourceIds: string[],
): Promise<boolean> {
  const parentFk: Record<AcLineTable, string | null> = {
    mfg_sales_order_items: 'doc_no',
    purchase_order_items: 'purchase_order_id',
    delivery_order_items: 'delivery_order_id',
    grn_items: 'grn_id',
    sales_invoice_items: null,
    purchase_invoice_items: null,
  };
  const fk = parentFk[spec.sourceItemTable];
  if (!fk) return true;
  try {
    /* EVERY taken line's parent, not just the first one's.
       A MERGED conversion draws lines from several source documents, and this
       used to read the parent of `takenSourceIds[0]` and compare that ONE
       document's line count against the total taken from ALL of them. Two
       sales orders of three lines each, five of the six shipped: the parent
       holds 3, the caller took 5, `3 > 5` is false — "whole document", no
       DtlKeys sent, and AutoCount transfers every outstanding line on both
       orders including the one the ERP left behind. That is D14 again, one
       level up, and it becomes reachable the moment a merge is allowed to
       enqueue at all. Counted per parent, any leftover anywhere is partial. */
    const { data: taken, error: tErr } = await sb.from(spec.sourceItemTable)
      .select(`id, ${fk}`).in('id', takenSourceIds);
    if (tErr || !taken) return true;
    const takenRows = taken as unknown as Record<string, unknown>[];
    if (takenRows.length !== takenSourceIds.length) return true;

    const takenByParent = new Map<string, number>();
    for (const r of takenRows) {
      const parentKey = r[fk];
      if (parentKey == null) return true;
      const k = String(parentKey);
      takenByParent.set(k, (takenByParent.get(k) ?? 0) + 1);
    }

    for (const [parentKey, takenHere] of takenByParent) {
      let q = sb.from(spec.sourceItemTable)
        .select('id', { count: 'exact', head: true }).eq(fk, parentKey);
      /* A retired parent line is not one this conversion "left behind" — it is
         one nobody will ever transfer. Only mfg_sales_order_items has the column
         (42703 on the others), so the filter is applied only there. */
      if (spec.sourceItemTable === 'mfg_sales_order_items') q = q.eq('cancelled', false);
      const { count, error: cErr } = await q;
      if (cErr || count == null) return true;
      if (count > takenHere) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * The ERP lines of a freshly-created downstream document, positionally ordered,
 * so the DtlKeys AutoCount reports can be zipped onto them.
 *
 * Returns undefined on ANY doubt — no id, an unreadable table, or no lines.
 * Undefined means "do not attempt to store line identity", which is the safe
 * outcome: the document still syncs, and only a later edit is refused.
 */
export async function readConvertTargetLines(
  sb: Sb,
  op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>,
  docId: string | null,
): Promise<AcOutboxPayload['lineWriteback']> {
  if (!docId) return undefined;
  try {
    const spec = DOWNSTREAM[CONVERT_TARGET[op]];
    const { data, error } = await sb.from(spec.itemTable).select(spec.itemCols)
      .eq(spec.itemFk, docId)
      .order('created_at', { ascending: true }).order('id', { ascending: true });
    if (error || !data) return undefined;
    const rows = data as unknown as Record<string, unknown>[];
    if (!rows.length) return undefined;
    const lines = rows.map(spec.line);
    return {
      table: spec.itemTable,
      ids: rows.map((r) => String(r.id)),
      codes: lines.map((l) => l.item_code),
      desc2: lines.map((l) => composeDescription2(l)),
    };
  } catch {
    return undefined;
  }
}
