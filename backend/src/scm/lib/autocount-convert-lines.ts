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
import { inAcLineOrder } from './ac-line-order';
// time, so the two cannot form a runtime cycle.
// ----------------------------------------------------------------------------
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

/* Declared HERE rather than beside the other enqueue helpers: DOWNSTREAM below
   is a module-level const that references it during module evaluation, so a
   later `const soLine` would be in its temporal dead zone and every import of
   this module would throw. */
export const soLine = (r: Record<string, unknown>): ErpLine => ({
  id: r.id == null ? null : String(r.id),
  item_code: String(r.item_code ?? r.item_code ?? ''),
  item_group: (r.item_group as string) ?? null,
  /* undefined on the five tables that do not select it, which soBranding reads
     as "this line has no brand" — the same convention `cancelled` runs under. */
  branding: (r.branding as string) ?? null,
  description: (r.description as string) ?? null,
  description2: (r.description2 as string) ?? null,
  qty: Number(r.qty ?? 0),
  unit_price_sen: Number(r.unit_price_sen ?? 0),
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
  /**
   * The quantity column on THIS document's lines, and on its SOURCE's.
   *
   * Named per spec because they disagree: a GRN line's quantity is
   * `qty_accepted` — what entered stock — while everything else is `qty`. The
   * pair exists so a PARTIAL QUANTITY can be detected at all: "3 of 5" is
   * `itemQtyCol` summed per source line against `sourceQtyCol` on that line.
   */
  itemQtyCol: string;
  sourceQtyCol: string;
  headerCols: string;
  itemCols: string;
  /** The human document number, for the outbox row's doc_no. */
  docNoOf: (h: Record<string, unknown>) => string;
  line: (r: Record<string, unknown>) => ErpLine;
  /**
   * EVERY AutoCount-named header fact the ERP holds for this document — the ONE
   * master both routes are projected from, and the whole structural point of
   * this file.
   *
   * It used to be `header`, a hand-built object for `/edit` alone, while the
   * CONVERSION route built a second, narrower object of its own in
   * `enqueueConvert`. Two hand-written shapes for one document is the defect
   * this repo has now paid for three times on the purchase side — `/so-to-po`
   * threw the create's whole master away and was patched ONE FIELD AT A TIME,
   * `CreditorCode` on 2026-08-17 09:15 and `DocNo` at 10:15, and five fields
   * were still missing after both. The four conversions had the identical hole
   * and nobody had looked.
   *
   * So there is one master and the routes are PROJECTIONS of it —
   * `downstreamEditHeader` and `downstreamTransferHeader` below. A fact added
   * here reaches whichever route can apply it with no further edit, and a fact
   * that reaches NEITHER fails `every downstream header fact reaches a route`
   * by name rather than going out silently.
   *
   * RETURNS `string | null`, and every key is ALWAYS PRESENT. That is not
   * sloppiness about `present` — it is what makes the ABSENCE reportable. The
   * projections apply `present()` (so a blank is still omitted rather than
   * blanking the book), and `downstreamNotCarried` reads the nulls to say which
   * facts this document has none of. A shape that dropped its own blanks could
   * not tell "the ERP has no supplier invoice number" from "this document type
   * has no such field".
   */
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
  /** The `dbo.Location` code for this document's own warehouse, already resolved. */
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
      /* THE DOCUMENT'S OWN DATE. `SalesHeader` is guarded — `var dt =
         Date(p, "DocDate"); if (dt.HasValue)` (AcSyncService.cs:2424) — so
         sending nothing does not blank it, it leaves `cmd.AddNew()`'s default,
         which is TODAY. The delivery order was dated by the operator and the
         drain runs on a five-minute cron, so "today" is the drain's day and not
         the delivery's: a DO raised at 23:58 or back-dated after the fact
         posted under the wrong date in a live account book, every time. */
      DocDate: str(h.do_date),
      DebtorName: str(h.debtor_name),
      Attention: str(h.debtor_name),
      Ref: str(h.ref),
      Phone1: str(h.phone),
      Note: str(h.note),
      /* NO Description, AND THAT IS DELIBERATE. `delivery_orders` carries TWO
         note columns — `note`, which is the one mapped here since /edit was
         written, and `notes`, which reaches AutoCount nowhere. `SalesHeader`
         assigns Description unconditionally, so the transferred DO's
         Description is written "" — but the sales arm builds its target with
         `AddPartialTransferDetail(..., false)` (AcSyncService.cs:1096), whose
         third argument is transferMaster, so nothing was copied off the sales
         order for that "" to destroy. Blank in, blank out.
         Guessing WHICH of two note columns is the book's Description is exactly
         the "do not send a key whose value you cannot vouch for" rule, and the
         purchase side's `notes -> Description` is not evidence about a
         different table. Left for the owner to say. */
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
    /* qty_ACCEPTED, not qty_received. AutoCount's GR line quantity is what
       entered stock, and qty_accepted is the number this ERP posts to stock and
       rolls up onto the PO. The received/rejected split has no AutoCount
       counterpart at all, so sending qty_received would make AutoCount's PO
       outstanding disagree with the ERP's by exactly the rejected quantity. */
    line: (r) => soLine({ ...r, qty: r.qty_accepted }),
    facts: (h, ctx) => ({
      /* Guarded on the service side (AcSyncService.cs:2448), so an absent key
         leaves `cmd.AddNew()`'s today rather than the day the goods arrived. */
      DocDate: str(h.received_at),
      Ref: str(h.delivery_note_ref),
      Description: str(h.notes),
      /* THE SUPPLIER'S OWN DELIVERY NOTE NUMBER, and the second key the SAME
         column feeds. `Set(() => doc.SupplierDONo = Str(p, "SupplierDONo"))` is
         UNCONDITIONAL on the GR arm (AcSyncService.cs:1226) and `Str` of an
         absent key is "" (:3212), so the ERP's silence has been writing an
         empty string into the book's field for exactly this number on every
         goods receipt. AutoCount has a dedicated field for it and
         `scm.grns.delivery_note_ref` is that number.
         BOTH KEYS FROM ONE COLUMN on purpose: `Ref` is what /edit has mapped
         this column to since /edit was written, and the two routes describing
         the same document differently is the shape this whole file exists to
         stop. */
      SupplierDONo: str(h.delivery_note_ref),
      /* THE RECEIVING WAREHOUSE — AutoCount's own header purchase location.
         The ERP's model comment on the CREATE side says "a purchase order has
         no location of its own — the ship-to warehouse is per LINE"
         (autocount-writeback.ts:1237). That is true of the ERP's PO and it is
         NOT true of AutoCount, and it was never true of the GRN: `scm.grns`
         carries `warehouse_id` and the GRN list column it feeds is literally
         labelled "Purchase Location" (grns.ts:1050).
         `PurchaseHeader` takes it guarded — ContainsKey AND non-empty
         (AcSyncService.cs:2446) — because "" is not a row in `dbo.Location` and
         a blank would be its own foreign key error, so omitting it is safe and
         a fabricated one would not be. The vendor's own comment names an empty
         PurchaseLocation as its standing suspect for the GRN partial-transfer
         `IndexOutOfRangeException: There is no row at position -1` (:2438). */
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
    /* THE SAME FACTS AS THE DELIVERY ORDER, under the same names, off the same
       columns but this table's own date. Read the DO's notes above for every
       one of them — including why there is no Description here either. */
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
      /* THE SUPPLIER'S OWN INVOICE NUMBER, and the one that stings most. The PI
         arm assigns it unconditionally (AcSyncService.cs:1259), so the book's
         field for the supplier's invoice number has been written EMPTY on every
         purchase invoice the ERP has ever transferred, while
         `scm.purchase_invoices.supplier_invoice_ref` held it the whole time.
         Same one-column-two-keys note as the GRN's SupplierDONo. */
      SupplierInvoiceNo: str(h.supplier_invoice_ref),
      /* NO PurchaseLocation, and this is the answer to "if our model genuinely
         has no header location". `scm.purchase_invoices` has no warehouse
         column at all (purchase-invoices.ts:61 is the whole header) — a
         purchase invoice moves money, not stock, and the receipt it follows is
         where the goods landed. So nothing is fabricated here. The guard on
         `PurchaseHeader` (:2446) means an absent key leaves the location
         AutoCount's own transfer put there, which is the GRN's — the right
         answer, and one the ERP is not entitled to overwrite. */
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
  /* SalesHeader, and nothing after it: the DO and IV arms call it BEFORE the
     transfer and make no trailing assignment (AcSyncService.cs:1097, :1106). */
  DO: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'DebtorName', 'Attention', 'Phone1', 'Note'],
  IV: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'DebtorName', 'Attention', 'Phone1', 'Note'],
  /* PurchaseHeader plus the GRN arm's own SupplierDONo. */
  GR: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'PurchaseLocation', 'SupplierDONo'],
  /* PurchaseHeader plus the purchase invoice arm's own SupplierInvoiceNo. */
  PI: ['DocDate', 'DocNo', 'Ref', 'Description', 'DisplayTerm', 'PurchaseLocation', 'SupplierInvoiceNo'],
};

/** The master, narrowed to one route's keys and then blank-stripped. */
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
    /* Only the GRN has one. Asked of the ROW rather than of the doc type, so a
       table that grows a warehouse column is one `facts` line from sending it. */
    if (typeof h.warehouse_id === 'string' && h.warehouse_id.trim()) {
      const w = await readOrThrow('warehouses',
        sb.from('warehouses').select('id, code, name').eq('id', h.warehouse_id).maybeSingle());
      const rec = w as { code?: string | null; name?: string | null } | null;
      /* THROUGH THE BOOK'S OWN SPELLING, exactly as the CREATE path does.
         This line used to send `warehouses.code` RAW, and the create path has
         always sent `bookSpellingOrOwn(..., LOCATION_MAP)` — two answers to
         "what does the account book call this warehouse", from one ERP row.

         The raw answer does not fail loudly. Measured on the host's own log,
         2026-08-25, on the PO -> GR that carried KL WAREHOUSE:

           set skipped: Cannot set column 'Location'. The value violates the
                        MaxLength limit of this column.
           set skipped: Cannot set column 'PurchaseLocation'. ...

         AutoCount SKIPS the assignment and saves the document anyway, so the
         goods received landed in a licensed book with NO warehouse on it and
         nothing anywhere said so — not the outbox row, not the page, not the
         ERP log. Every value in LOCATION_MAP is 8 characters or fewer
         (`KELANA.J`, `C&C DISP`); `KL WAREHOUSE` is twelve.

         Mapping here is not a truncation: LOCATION_MAP is the book's spelling
         of each warehouse, so `KL WAREHOUSE` becomes `KL` because that is what
         the location is CALLED there, not because it is shorter. A warehouse
         the map does not know still travels as its own code — unchanged
         behaviour, and `bookSpellingOrOwn`'s whole contract — so this fixes the
         mapped ones without inventing an answer for the rest. */
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
    /* ORDERED for the same reason the payload reads are: the KEYS this returns
       are handed to the transfer in this order, and `details` pairs a quantity
       with each one positionally. An unordered read makes that pairing depend
       on whatever order Postgres felt like — ac-line-order.ts. */
    const { data, error } = await inAcLineOrder(sb.from(spec.itemTable)
      .select(`id, ${spec.sourceFk}, ${spec.itemQtyCol}`).eq(spec.itemFk, docId));
    if (error || !data) return {};
    const rows = data as unknown as Record<string, unknown>[];
    if (!rows.length) return {};

    const sourceIds = [...new Set(
      rows.map((r) => r[spec.sourceFk]).filter((v): v is string => typeof v === 'string' && !!v),
    )];
    /* Not one line came from a source document. Nothing to name, and the
       parentless / ad-hoc shape is already recorded by its own route. */
    if (!sourceIds.length) return {};

    /* HOW MUCH this document took of each source line. Summed, because several
       target lines can point at one source row — a sofa build's compartments
       are the standing example. */
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
    const perKey: AcTransferQty[] = [];
    let partialQty = false;
    let qtyReadable = true;
    for (const id of sourceIds) {
      const row = srcRows.find((r) => String(r.id) === id);
      const k = row?.linked_ac_dtlkey;
      const n = k == null ? NaN : Number(k);
      if (Number.isFinite(n) && n > 0) {
        keys.push(n as number);
        const took = taken.get(id);
        const had = Number(row?.[spec.sourceQtyCol]);
        if (took == null || !Number.isFinite(took) || !Number.isFinite(had) || took <= 0) {
          qtyReadable = false;
        } else {
          perKey.push({ DtlKey: n as number, Qty: took });
          /* EPSILON, because these are decimals out of PostgREST. A hair under
             is not a partial shipment. */
          if (took < had - 1e-9) partialQty = true;
        }
      } else missing.push(id);
    }
    if (!missing.length) {
      /* PARTIAL BY QUANTITY — "3 of 5 on this line" — is the ONE shape DtlKeys
         alone cannot express, and getting it wrong is silent: the service's
         AddPartialTransferDetail moves each named line's WHOLE outstanding
         quantity, so a delivery of 2 out of 5 booked 5 in a licensed account
         book and answered ok.
         `Details[].Qty` is how the service was taught to hear it (PlanTransfer,
         AcSyncService.cs), and it is ALL-OR-NOTHING PER DOCUMENT — a named key
         with no number would silently move its whole outstanding quantity — so
         every key gets one or none do.
         SENT ONLY WHEN THE TRANSFER REALLY IS PARTIAL. A quantity on the
         payload routes the service onto the documented PartialTransfer
         overloads, which it REFUSES to fall back from; the plain shape below is
         the one proven against this book on every conversion type. A refusal on
         a genuine 3-of-5 is recoverable and loud; the wrong quantity in the
         ledger is neither. Measured 2026-08-11 on the book: 10 of 60,939 sales
         order lines were ever partly transferred, so this branch is rare by
         construction and must not become the common path. */
      if (partialQty && qtyReadable && perKey.length === keys.length) {
        return { keys, details: perKey };
      }
      return { keys };
    }

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


// ── WHO a conversion is transferring FROM ────────────────────────────────────
// MOVED HERE FROM autocount-outbox.ts on 2026-08-20, and the reason is the one
// this file's own header records: that module reached its 2,000-line cap again.
// This is the seam it wanted. All four of these are derived from, or ask about,
// `CONVERT_TARGET` — which lives HERE, and `SALES_CONVERSION` is literally a
// filter over it — so they were reaching across a module boundary to answer a
// question this module owns.
//
// STILL ONE-WAY. They take only TYPES back from autocount-outbox.ts
// (`AcDocRef`, `AcLinkTable`), and a type import is erased at compile time, so
// the two cannot form a runtime cycle. autocount-outbox.ts imports the VALUES;
// nothing here imports a value from it.

/**
 * The two conversions whose target is a SALES document, and therefore the two
 * that need a DebtorCode on the payload.
 *
 * Derived from CONVERT_TARGET rather than listed again: a fifth conversion
 * added to that map joins this set on its own if its target is a sales one,
 * and the alternative — a second hand-written list of ops — is the duplicated
 * -list bug this repo keeps paying for.
 */
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
    /* Trimmed and length-checked because "   " is not an account, and
       AutoCount's own complaint is "Debtor Code is empty." — the service trims
       the payload for the same reason (AcSyncService.cs, Convert_). */
    if (!code) return null;
    return { CreditorCode: code, ...(s?.name ? { CreditorName: String(s.name) } : {}) };
  } catch {
    return null;
  }
}
