import { inAcLineOrder } from './ac-line-order';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AcOp, ErpLine } from '../../services/autocount-writeback';
import { composeDescription2 } from '../../services/autocount-writeback';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { readOrThrow } from './autocount-read';
import type { AcDocRef, AcLineTable, AcLinkTable, AcOutboxPayload } from './autocount-outbox';

type Sb = SupabaseClient<any, any, any>;

/** One line of a PARTIAL QUANTITY transfer: how much of the source line this
 *  document is taking. The service reads it as `Details[]`. */
export interface AcTransferQty { DtlKey: number; Qty: number }

export const soLine = (r: Record<string, unknown>): ErpLine => ({
  id: r.id == null ? null : String(r.id),
  item_code: String(r.item_code ?? r.item_code ?? ''),
  item_group: (r.item_group as string) ?? null,
  branding: (r.branding as string) ?? null,
  description: (r.description as string) ?? null,
  description2: (r.description2 as string) ?? null,
  qty: Number(r.qty ?? 0),
  unit_price_sen: Number(r.unit_price_sen ?? 0),
  variants: (r.variants as Record<string, unknown> | null) ?? null,
  linked_ac_dtlkey: (r.linked_ac_dtlkey as number | null) ?? null,
  line_no: r.line_no == null ? null : Number(r.line_no),
  delivery_date: (r.line_delivery_date as string | null) ?? (r.delivery_date as string | null) ?? null,
  cancelled: r.cancelled === true,
  location: null,
});

export interface AcDownstreamSpec {
  table: AcLinkTable;
  itemTable: AcLineTable;
  itemFk: string;
  sourceItemTable: AcLineTable;
  sourceFk: string;
  itemQtyCol: string;
  sourceQtyCol: string;
  headerCols: string;
  itemCols: string;
  docNoOf: (h: Record<string, unknown>) => string;
  line: (r: Record<string, unknown>) => ErpLine;
  facts: (h: Record<string, unknown>, ctx?: AcHeaderCtx) => Record<string, string | null>;
}

/**
 * What a header fact needs that is NOT a column on the header row.
 *
 * Only the warehouse today: `scm.grns.warehouse_id` is a uuid and AutoCount's
 * `dbo.Location` is keyed by the short code, so the hop needs a query and
 * `facts` is deliberately pure. The caller resolves it and passes the answer.
 */
export interface AcHeaderCtx {
  locationCode?: string | null;
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
    itemQtyCol: 'qty',
    sourceQtyCol: 'qty',
    headerCols: 'id, do_number, do_date, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.do_number ?? h.id ?? ''),
    line: soLine,
    facts: (h) => ({
      DocDate: str(h.do_date),
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
    itemQtyCol: 'qty_accepted',
    sourceQtyCol: 'qty',
    headerCols: 'id, grn_number, received_at, warehouse_id, delivery_note_ref, notes, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty_accepted, unit_price_sen, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.grn_number ?? h.id ?? ''),
    line: (r) => soLine({ ...r, qty: r.qty_accepted }),
    facts: (h, ctx) => ({
      DocDate: str(h.received_at),
      Ref: str(h.delivery_note_ref),
      Description: str(h.notes),
      SupplierDONo: str(h.delivery_note_ref),
      PurchaseLocation: ctx?.locationCode ?? null,
    }),
  },
  IV: {
    table: 'sales_invoices',
    itemTable: 'sales_invoice_items',
    itemFk: 'sales_invoice_id',
    sourceItemTable: 'delivery_order_items',
    sourceFk: 'do_item_id',
    itemQtyCol: 'qty',
    sourceQtyCol: 'qty',
    headerCols: 'id, invoice_number, invoice_date, debtor_name, ref, phone, note, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    facts: (h) => ({
      DocDate: str(h.invoice_date),
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
    itemQtyCol: 'qty',
    sourceQtyCol: 'qty_accepted',
    headerCols: 'id, invoice_number, invoice_date, supplier_invoice_ref, notes, linked_ac_docno',
    itemCols: 'id, item_code, item_group, description, description2, qty, unit_price_sen, variants, linked_ac_dtlkey, created_at',
    docNoOf: (h) => String(h.invoice_number ?? h.id ?? ''),
    line: soLine,
    facts: (h) => ({
      DocDate: str(h.invoice_date),
      Ref: str(h.supplier_invoice_ref),
      Description: str(h.notes),
      SupplierInvoiceNo: str(h.supplier_invoice_ref),
    }),
  },
};

/**
 * The header keys `/edit` will ever apply, straight off its allow-list.
 *
 * `Edit()` reflects over a fixed `string[]` and DROPS anything outside it
 * (AcSyncService.cs:2990-2995) — silently, because the payload is read with
 * `Str` and a key nobody looks at is not an error. So this is the set a fact
 * has to be in for `/edit` to carry it, and the contract test asserts it
 * against that array in the C# source rather than trusting this copy.
 */
export const AC_EDIT_HEADER_KEYS: readonly string[] = [
  'DebtorName', 'CreditorName', 'Attention', 'Agent', 'Ref', 'Description',
  'SalesLocation', 'Phone1', 'InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4',
  'DeliverAddr1', 'DeliverAddr2', 'DeliverAddr3', 'DeliverAddr4',
  'DeliverContact', 'DeliverPhone1', 'Remark1', 'Remark2', 'Remark3', 'Remark4',
  'Note',
];

/**
 * The header keys a CONVERSION will ever apply, per target document.
 *
 * A STRICTLY NARROWER SET THAN `/edit`'s, and that asymmetry is the finding
 * behind this whole change. The transfer route does not go through `Edit()`'s
 * reflection loop at all: it applies `SalesHeader` (AcSyncService.cs:2422-2434)
 * or `PurchaseHeader` (:2436-2461) and then, on the two purchase arms only, one
 * further assignment each — `SupplierDONo` on the GRN (:1226) and
 * `SupplierInvoiceNo` on the purchase invoice (:1259).
 *
 * So a key outside this set is NOT "sent and defaulted", it is sent and
 * DROPPED, and adding it to the payload would have been a third no-op patch of
 * the kind that left `/so-to-po` broken twice over. `DocNo` and `DisplayTerm`
 * are in the service's set and not in any spec's facts — the number comes from
 * the outbox row and the ERP has no payment term — which costs nothing: a
 * projection is an intersection, so a key the ERP never states is simply never
 * projected.
 *
 * ASSERTED AS A SUBSET of what the C# reads, never as an equality: the vendor
 * service is free to grow a slot the ERP has nothing to put in (`Agent` on
 * `PurchaseHeader` is one landing on a sibling branch right now), and a test
 * that broke on that would be a test that punishes the other half of the fix.
 * The direction that matters is the dangerous one — the ERP must never send a
 * key this route silently discards.
 */
export const AC_TRANSFER_HEADER_KEYS: Record<'DO' | 'GR' | 'IV' | 'PI', readonly string[]> = {
  DO: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'DebtorName', 'Attention', 'Phone1', 'Note'],
  IV: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'DebtorName', 'Attention', 'Phone1', 'Note'],
  GR: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'PurchaseLocation', 'SupplierDONo'],
  PI: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'PurchaseLocation', 'SupplierInvoiceNo'],
};

const project = (
  facts: Record<string, string | null>,
  keys: readonly string[],
): Record<string, string> => {
  const allowed = new Set(keys);
  const narrowed: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(facts)) if (allowed.has(k)) narrowed[k] = v;
  return present(narrowed);
};

/** The master projected onto `/edit`. */
export function downstreamEditHeader(
  docType: 'DO' | 'GR' | 'IV' | 'PI',
  h: Record<string, unknown>,
  ctx?: AcHeaderCtx,
): Record<string, string> {
  return project(DOWNSTREAM[docType].facts(h, ctx), AC_EDIT_HEADER_KEYS);
}

/** The master projected onto the CONVERSION route. */
export function downstreamTransferHeader(
  docType: 'DO' | 'GR' | 'IV' | 'PI',
  h: Record<string, unknown>,
  ctx?: AcHeaderCtx,
): Record<string, string> {
  return project(DOWNSTREAM[docType].facts(h, ctx), AC_TRANSFER_HEADER_KEYS[docType]);
}

/**
 * A downstream document's OWN header, in the shape the conversion route wants,
 * plus what it is going without.
 *
 * NEVER THROWS, and that is the contract the caller needs: `enqueueConvert`
 * runs after the route has already committed the operator's document, so an
 * unreadable header must cost the transfer its header fields, never the
 * transfer. A read that fails comes back as `readFailed`, which the caller
 * turns into a sentence on the outbox row — the difference between "the ERP has
 * no supplier invoice number" and "the ERP could not look" is exactly the kind
 * of thing this queue has previously reported as neither.
 *
 * The warehouse hop is done HERE rather than in `facts`, which is pure: the ERP
 * column is a `scm.warehouses` uuid and AutoCount's `dbo.Location` is keyed by
 * the short code. Same id -> code resolution `withLocations` does for lines, one
 * row instead of a set, and the same `code ?? name` fallback so a header and a
 * line on one document can never disagree about the same warehouse.
 */
export async function readConvertHeaderFacts(
  sb: Sb,
  docType: 'DO' | 'GR' | 'IV' | 'PI',
  id: string | null,
): Promise<{ header: Record<string, string>; notCarried: string[]; readFailed: boolean }> {
  const spec = DOWNSTREAM[docType];
  if (!id) {
    return {
      header: {},
      notCarried: ['the ERP did not name which document this conversion produced, so none of its header fields could be read'],
      readFailed: true,
    };
  }
  try {
    const row = await readOrThrow(`${spec.table} header`,
      sb.from(spec.table).select(spec.headerCols).eq('id', id).maybeSingle());
    if (!row) {
      return {
        header: {},
        notCarried: [`the ${spec.table} row for this document was not found, so none of its header fields could be read`],
        readFailed: true,
      };
    }
    const h = row as unknown as Record<string, unknown>;
    let locationCode: string | null = null;
    if (typeof h.warehouse_id === 'string' && h.warehouse_id.trim()) {
      const w = await readOrThrow('warehouses',
        sb.from('warehouses').select('id, code, name').eq('id', h.warehouse_id).maybeSingle());
      const rec = w as { code?: string | null; name?: string | null } | null;
      const raw = ((rec?.code ?? rec?.name ?? '') as string).trim() || null;
      locationCode = bookSpellingOrOwn(raw, LOCATION_MAP);
    }
    const ctx: AcHeaderCtx = { locationCode };
    return {
      header: downstreamTransferHeader(docType, h, ctx),
      notCarried: downstreamNotCarried(docType, h, ctx),
      readFailed: false,
    };
  } catch (e) {
    return {
      header: {},
      notCarried: [`the ERP could not read this document's own header (${(e as Error)?.message ?? 'read failed'}), so it was transferred with none of its own fields`],
      readFailed: true,
    };
  }
}

/**
 * What this document will reach the accounts WITHOUT, in the operator's words.
 *
 * TWO DIFFERENT SILENCES, and they are not the same problem, so they do not get
 * the same sentence:
 *
 *   · the ERP HAS NO VALUE — the fact is one this route could carry and the
 *     column is empty. `present()` omits the key rather than sending a blank
 *     (a blank is a foreign key error on a master field and a destroyed value
 *     on a text one), so the book keeps its own. Fixable by the person holding
 *     the document: fill the field in and it goes on the next edit.
 *   · THE ROUTE CANNOT CARRY IT — the ERP has the value and `SalesHeader` /
 *     `PurchaseHeader` have no slot for it. Nobody on the shop floor can fix
 *     that; it needs a service change. Said out loud anyway, because the owner
 *     asked why the transferred document did not carry the source's data and
 *     the honest half of the answer is "this route has nowhere to put it".
 *
 * Returned as sentences and not codes because it goes in the outbox row's
 * reason, which is read by a person.
 */
export function downstreamNotCarried(
  docType: 'DO' | 'GR' | 'IV' | 'PI',
  h: Record<string, unknown>,
  ctx?: AcHeaderCtx,
): string[] {
  const facts = DOWNSTREAM[docType].facts(h, ctx);
  const carried = new Set(AC_TRANSFER_HEADER_KEYS[docType]);
  const out: string[] = [];
  for (const [k, v] of Object.entries(facts)) {
    if (!carried.has(k)) out.push(`${k}: this transfer has no field for it (it reaches AutoCount only through an edit)`);
    else if (!(v ?? '').trim()) out.push(`${k}: the ERP document has none, so AutoCount keeps its own`);
  }
  return out;
}

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
 * PARTIAL QUANTITY IS COVERED NOW — 2026-08-18. This comment used to end "NOT
 * COVERED, and deliberately so", on the grounds that AddPartialTransferDetail
 * takes line keys and not quantities. True of that primitive, and the service
 * stopped depending on it alone: `PlanTransfer` reads `Details[].Qty` and
 * `RunTransfer` uses the documented `PartialTransfer` overloads for it,
 * REFUSING rather than falling back — because the fallback moves each line's
 * whole outstanding quantity, so a DO of 2 out of 5 booked 5 and answered ok.
 *
 * `details` is returned ONLY when some line is genuinely being taken in part.
 * A quantity on the payload commits the whole document to those overloads, and
 * the plain shape is the one proven against this book on every conversion type;
 * 46,308 of the 46,318 source lines that ever moved went whole (measured
 * 2026-08-11). Rare by construction, and it must stay that way.
 */
export async function readConvertSourceKeys(
  sb: Sb,
  op: Extract<AcOp, 'so_to_do' | 'po_to_gr' | 'do_to_iv' | 'gr_to_pi'>,
  docId: string | null,
): Promise<{ keys?: number[]; details?: AcTransferQty[]; refuse?: string }> {
  if (!docId) return {};
  try {
    const spec = DOWNSTREAM[CONVERT_TARGET[op]];
    const { data, error } = await inAcLineOrder(sb.from(spec.itemTable)
      .select(`id, ${spec.sourceFk}, ${spec.itemQtyCol}`).eq(spec.itemFk, docId));
    if (error || !data) return {};
    const rows = data as unknown as Record<string, unknown>[];
    if (!rows.length) return {};

    const sourceIds = [...new Set(
      rows.map((r) => r[spec.sourceFk]).filter((v): v is string => typeof v === 'string' && !!v),
    )];
    if (!sourceIds.length) return {};

    const taken = new Map<string, number>();
    for (const r of rows) {
      const id = r[spec.sourceFk];
      if (typeof id !== 'string' || !id) continue;
      const q = Number(r[spec.itemQtyCol]);
      taken.set(id, (taken.get(id) ?? 0) + (Number.isFinite(q) ? q : NaN));
    }

    const { data: src, error: sErr } = await sb.from(spec.sourceItemTable)
      .select(`id, linked_ac_dtlkey, ${spec.sourceQtyCol}`).in('id', sourceIds);
    if (sErr || !src) return {};
    const srcRows = src as unknown as Array<Record<string, unknown>>;

    const keys: number[] = [];
    const missing: string[] = [];
    const byKey = new Map<number, { took: number; had: number; erpLines: number }>();
    let qtyReadable = true;
    for (const id of sourceIds) {
      const row = srcRows.find((r) => String(r.id) === id);
      const k = row?.linked_ac_dtlkey;
      const n = k == null ? NaN : Number(k);
      if (!Number.isFinite(n) || n <= 0) { missing.push(id); continue; }
      const key = n as number;
      if (!byKey.has(key)) { keys.push(key); byKey.set(key, { took: 0, had: 0, erpLines: 0 }); }
      const acc = byKey.get(key) as { took: number; had: number; erpLines: number };
      acc.erpLines += 1;
      const took = taken.get(id);
      const had = Number(row?.[spec.sourceQtyCol]);
      if (took == null || !Number.isFinite(took) || !Number.isFinite(had) || took <= 0) {
        qtyReadable = false;
      } else {
        acc.took += took;
        acc.had += had;
      }
    }
    const keyIsPartial = (key: number): boolean => {
      const a = byKey.get(key);
      return !!a && a.took < a.had - 1e-9;
    };
    const siblings = new Map<number, { lines: number; qty: number; ids: string[] }>();
    if (keys.length) {
      const { data: sib, error: sibErr } = await sb.from(spec.sourceItemTable)
        .select(`id, linked_ac_dtlkey, ${spec.sourceQtyCol}`).in('linked_ac_dtlkey', keys);
      for (const r of (sibErr ? [] : (sib ?? []) as unknown as Array<Record<string, unknown>>)) {
        const n = Number(r.linked_ac_dtlkey);
        if (!Number.isFinite(n)) continue;
        const acc = siblings.get(n) ?? { lines: 0, qty: 0, ids: [] };
        acc.lines += 1;
        if (typeof r.id === 'string' && r.id) acc.ids.push(r.id);
        const q = Number(r[spec.sourceQtyCol]);
        if (Number.isFinite(q)) acc.qty += q;
        siblings.set(n, acc);
      }
    }
    const shared = keys.filter((key) => Math.max(
      byKey.get(key)?.erpLines ?? 0, siblings.get(key)?.lines ?? 0,
    ) > 1);
    /* ── WHEN DOES A SHARED LINE GO? THE OWNER'S ANSWER IS "WHEN IT IS WHOLE" ──
       Option C, chosen 2026-09-08: the shared line — a sofa — WAITS for the
       delivery that completes it, while every other line on the document goes on
       time. 「C 除了accessories 不看 就看sofa」: completeness is judged on the
       sofa's OWN pieces, so a pillow still in the warehouse never holds it back.
       Keying the decision on the shared DtlKey gives exactly that for free — a
       pillow has its own key and is a different question.

       AND IT IS COUNTED ACROSS EVERY DELIVERY, not just this one. A sofa shipped
       in two trips has each trip taking ONE piece, so "did THIS document take
       them all" answers no on the trip that completes it — the sofa would wait
       for ever. What decides it is whether every ERP line sharing that key has
       now been taken by SOME downstream document. The delivery that covers the
       last piece is the one that carries the sofa into the book.

       Best-effort like the sibling read above: unreadable coverage leaves the
       key in `waiting`, which holds the line back rather than sending it early.
       Holding is recoverable; a sofa in the book that is still in the warehouse
       is not. */
    const covered = new Set<string>();
    const sibIds = [...new Set(shared.flatMap((key) => siblings.get(key)?.ids ?? []))];
    if (sibIds.length) {
      const { data: cov, error: covErr } = await inAcLineOrder(sb.from(spec.itemTable)
        .select(`id, ${spec.sourceFk}`).in(spec.sourceFk, sibIds));
      for (const r of (covErr ? [] : (cov ?? []) as unknown as Array<Record<string, unknown>>)) {
        const src = r[spec.sourceFk];
        if (typeof src === 'string' && src) covered.add(src);
      }
    }
    const sharedIsWhole = (key: number): boolean => {
      const all = siblings.get(key);
      if (!all || !all.ids.length) return !keyIsPartial(key);
      if (!all.ids.every((id) => covered.has(id))) return false;
      return true;
    };
    if (!missing.length) {
      /* ── A SHARED KEY MAY NEVER CARRY A QUANTITY ─────────────────────────
         The two sides count in different units. AutoCount's sofa line is ONE
         sofa; the ERP's pieces are two or three lines that each say 1. Summing
         them gives 2 against a book line of 1, which is an OVER-TRANSFER of a
         licensed account book — the exact class of silent damage this function
         was written to prevent.

         Whole, it does not arise: no quantity is sent at all and the service
         moves each named line's outstanding, so the book's one sofa moves once.
         PARTLY shipped, it cannot be expressed and is REFUSED rather than
         approximated — "two of the three pieces" has no shape in a document
         that holds one line of one unit.

         THE OWNER CHOSE THE ANSWER ON 2026-09-08 — option C, and it is BUILT
         now: the shared line WAITS for the delivery that completes it while
         every other line on the document goes on time. The whole document used
         to be refused for it, which held a pillow hostage to a sofa. */
      if (shared.length) {
        const waiting = shared.filter((key) => !sharedIsWhole(key));
        if (waiting.length) {
          const ready = keys.filter((key) => !waiting.includes(key));
          if (!ready.length) {
            return {
              refuse:
                `every line on this ${op.replace('_to_', ' -> ').toUpperCase()} belongs to a line AutoCount holds `
                + 'as ONE — a sofa, which the ERP splits into a piece per line — and not all of its pieces have '
                + 'been delivered yet. The account book has no shape for part of a sofa, so it waits for the '
                + 'delivery that completes it and goes then. Nothing is lost and nothing needs doing.',
            };
          }
          return { keys: ready };
        }
        return { keys };
      }
      if (qtyReadable && keys.some(keyIsPartial)) {
        return { keys, details: keys.map((key) => ({ DtlKey: key, Qty: (byKey.get(key) as { took: number }).took })) };
      }
      return { keys };
    }

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
    const { data, error } = await inAcLineOrder(
      sb.from(spec.itemTable).select(spec.itemCols).eq(spec.itemFk, docId));
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



/**
 * The two conversions whose target is a SALES document, and therefore the two
 * that need a DebtorCode on the payload.
 *
 * Derived from CONVERT_TARGET rather than listed again: a fifth conversion
 * added to that map joins this set on its own if its target is a sales one,
 * and the alternative — a second hand-written list of ops — is the duplicated
 * -list bug this repo keeps paying for.
 */
/**
 * Is this op a CONVERSION — a document AutoCount builds from a parent, and
 * therefore one whose line keys the ERP can only learn by being told?
 *
 * Derived from CONVERT_TARGET rather than listed again, for the reason
 * SALES_CONVERSION gives right below: a fifth conversion added to that map
 * joins this predicate on its own, and a second hand-written list of ops is the
 * duplicated-list bug this repo keeps paying for.
 */
export function isConvertOp(op: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONVERT_TARGET, op);
}

export const SALES_CONVERSION = new Set(
  (Object.keys(CONVERT_TARGET) as Array<keyof typeof CONVERT_TARGET>)
    .filter((op) => CONVERT_TARGET[op] === 'DO' || CONVERT_TARGET[op] === 'IV'),
);

/** The complement, and derived the same way so the two can never disagree. */
export const PURCHASE_CONVERSION = new Set<string>(
  Object.keys(CONVERT_TARGET).filter((op) => !SALES_CONVERSION.has(op as never)),
);

/**
 * The ERP source tables that carry a supplier of their own.
 *
 * THIS LIST IS THE CORRECTION. Until 2026-08-17 the purchase half of divergence
 * D15 was left open on the recorded grounds that "`grns` and `purchase_invoices`
 * carry no supplier column, so a creditor means a `grn -> purchase_order ->
 * supplier` join". That is false, and the DDL this repo already vendors says so
 * in one line each — `scripts/scm-schema/2990s-full-schema.sql`:
 *
 *     CREATE TABLE "grns" (...  "supplier_id" uuid NOT NULL, ...)
 *     CREATE TABLE "purchase_invoices" (... "supplier_id" uuid NOT NULL, ...)
 *
 * Both are NOT NULL, both are written on every insert (`grns.ts`,
 * `purchase-invoices.ts`) and both are selected by the live list and detail
 * routes. So there is no join: it is one hop to `suppliers.code`, the same hop
 * `readPoHeader` already makes for `/create-po`, and therefore the same
 * vocabulary AutoCount has already accepted as a `CreditorCode`.
 *
 * Only the SOURCE tables are listed. The target row carries the same supplier —
 * the GRN is inserted with the PO's, the PI with the GRN's — but the document
 * being TRANSFERRED is the authority on whose account it moves, and that is the
 * row the service's own book fallback reads too.
 */
export const SUPPLIER_BEARING_SOURCE = new Set<AcLinkTable>(['purchase_orders', 'grns']);

/**
 * The creditor for a purchase conversion, off the ERP's own source document.
 *
 * Returns null on ANY doubt, and null means "say nothing": the body goes out
 * without an account and the service falls back to reading the creditor off the
 * source document in the live book. That fallback stays whatever happens here —
 * it is the only thing that drains a row queued before this existed, and a
 * lookup that quietly stops being exercised is a lookup someone deletes.
 */
export async function readConvertCreditor(
  sb: Sb,
  from: AcDocRef,
): Promise<{ CreditorCode: string; CreditorName?: string } | null> {
  try {
    if (!SUPPLIER_BEARING_SOURCE.has(from.table)) return null;
    const { data, error } = await sb.from(from.table)
      .select('supplier_id').eq(from.keyCol, from.key).maybeSingle();
    if (error || !data) return null;
    const supplierId = (data as Record<string, unknown>).supplier_id;
    if (!supplierId) return null;
    const { data: sup, error: supErr } = await sb.from('suppliers')
      .select('code, name').eq('id', String(supplierId)).maybeSingle();
    if (supErr) return null;
    const s = sup as { code?: string | null; name?: string | null } | null;
    const code = s?.code == null ? '' : String(s.code).trim();
    if (!code) return null;
    return { CreditorCode: code, ...(s?.name ? { CreditorName: String(s.name) } : {}) };
  } catch {
    return null;
  }
}
