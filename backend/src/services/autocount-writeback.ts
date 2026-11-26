// ----------------------------------------------------------------------------
// autocount-writeback — the ERP -> AutoCount payload composer and the HTTP
// client for AcSyncService.
//
// AcSyncService (backend/scripts/autocount-service/AcSyncService.cs) runs on the
// AutoCount host and drives the licensed 2.2 SDK. It exposes eight POST routes
// and nothing else; this module speaks exactly that contract:
//
//   /create-so  /create-po  /so-to-do  /po-to-gr  /do-to-iv  /gr-to-pi
//   /cancel     /edit
//
// THE MASTER MAPS BELOW ARE CARRIED OVER FROM PR #1696 unchanged in content —
// they were built against the live AED_HOUZS book and are the only record of
// how an ERP salesperson / location / venue / branding is spelled in AutoCount.
// What changed is the PAYLOAD SHAPE: #1696 targeted an earlier middleware
// (POST /SalesOrder/create, SOUDF_* header fields, `Detail[]`, `ItemDescription`)
// that was never built. AcSyncService is the one that exists and was proven
// against the live book on 2026-08-07, and it takes `Details[]`, `Desc2`, and a
// free-form `UDF` dictionary. Composing for the middleware that does not exist
// would have produced a write-back that type-checks and never works.
//
// PURE ON PURPOSE. The composer takes plain rows and an injected ItemCode
// resolver, so it unit-tests with no database and no AutoCount.
// ----------------------------------------------------------------------------
import type { Env } from '../types';
import { erpLineIdsOf, shouldRebuild, type AcRetiredLine } from './ac-line-gone';
import {
  ItemCodeError,
  resolveAcItemCode,
  type AcItemIndex,
} from './autocount-item-code';
import {
  AC_DESC2_MAX,
  collapseSofaLines,
  type CollapsedLine,
  type SofaRefusal,
} from './autocount-sofa-collapse';
import {
  SO_PROCESSING_DATE_AC_UDF,
  SO_PROCESSING_DATE_COLUMN,
} from '../scm/shared/so-processing-date';
import { buildVariantSummary } from '../scm/shared/variant-summary';
import { abbreviateDesc2 } from './autocount-desc2-abbrev';

/** Fixed AutoCount debtor account; the customer's real name is written over it. */
export const AC_DEBTOR_CODE = '300-C002';

/**
 * THE FOUR MASTER-DATA MAPS — GENERATED, and re-exported here because this is
 * where every reader looks for them.
 *
 * They are compiled from `scripts/data/autocount-so-writeback-mappings.json` by
 * `scripts/gen-autocount-master-maps.mjs` (CI: `npm run audit:ac-master-maps`).
 * That is not ceremony: CONFIRMING A BINDING has to be cheap and reviewable, and
 * it used to mean hand-editing an object literal here while the record of WHY
 * the binding is right lived in the JSON. The two drifted in all four
 * dimensions. `check-autocount-master-bindings.mjs` proposes a pair with its
 * reason, a human moves it into the JSON, the generator writes the map.
 *
 * WHAT EACH MAP IS FOR:
 *
 * - `AGENT_MAP` — ERP salesperson label -> AutoCount Sales Agent (the name IS
 *   the code). Read through `bookSpelling` only; see `resolveAcAgent` for why
 *   the raw `agent` column never passes through unmapped.
 * - `LOCATION_MAP` — ERP `sales_location` / warehouse code -> the book's SHORT
 *   location code. Passes through unmapped (`bookSpellingOrOwn`).
 * - `VENUE_MAP` — ERP venue -> the book's VENUE UDF option. Passes through
 *   unmapped; venue is deliberately free text (mig 0229).
 * - `BRANDING_MAP` — ERP branding -> the book's BRANDING UDF option. Passes
 *   through unmapped, like the other three, since 2026-08-15.
 *
 *   It was the one allow-list, and the measurement that made it one was wrong.
 *   On 2026-08-14 a pass-through was measured as opening `2990s Sofa` (44
 *   orders), `Accessories` (8), `2990s Mattress` (8), `2990` (3) — and every one
 *   of those is 2990's, counted only because the report had no company predicate
 *   (#2201). The write-back runs for company 1. Scoped to it, the whole
 *   pass-through is `BEDFRAME` (1 order) and `SERVICE` (0).
 *
 *   Those two are still categories rather than brands, and the owner was told
 *   so before deciding: "bedframe和service的branding也开进去autocount ... 之后
 *   再有新的，如果 match 不上的，你都开进去". His book, his vocabulary. What
 *   the allow-list was really protecting against was a fiftyfold-inflated
 *   number, which is a reason to fix the number, not to keep the rule.
 */
export {
  AGENT_MAP,
  LOCATION_MAP,
  VENUE_MAP,
  BRANDING_MAP,
} from './autocount-master-maps';
import {
  AGENT_MAP,
  LOCATION_MAP,
  VENUE_MAP,
  BRANDING_MAP,
} from './autocount-master-maps';

const norm = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

import { tidy, soInvoiceAddress } from './autocount-address-fit';
import { poSupplierDateUdf, poSourceSoUdf, type PoSupplierDates } from './autocount-po-supplier-dates';
export { AC_ADDRESS_LINE_MAX, AC_ADDRESS_LINES, fitAddressLines, tidy, soInvoiceAddress } from './autocount-address-fit';


/**
 * The ACCOUNT BOOK'S OWN SPELLING of a value it already knows — or null.
 *
 * NULL MEANS "THE BOOK HAS NEVER HEARD OF THIS". It does not mean "no value",
 * and it is never a safe thing to send: on `Agent` and `SalesLocation` a null
 * reaches AcSyncService as a present-but-null key, `Str()` turns it into `""`,
 * the property is assigned unconditionally and `""` is not a row in
 * `dbo.SalesAgent` / `dbo.Location`, so the WHOLE document dies on a foreign
 * key. On the `BRANDING` / `VENUE` UDFs the null is dropped by `udf()` and the
 * field silently never reaches the book at all.
 *
 * This function used to be called `mapOrPassthrough`, and the name was the
 * trap: it passes through only a value that is ALREADY canonical, and returns
 * null for everything else. Four fields were composed on the strength of that
 * name (audit 2026-08-14, findings 1/3/5/6). Use `bookSpellingOrOwn` wherever
 * the ERP's own value is a legitimate thing to send.
 */
export function bookSpelling(
  value: string | null | undefined,
  map: Record<string, string>,
): string | null {
  const k = norm(value);
  if (!k) return null;
  if (map[k]) return map[k];
  for (const v of Object.values(map)) if (norm(v) === k) return v;
  return null;
}

/**
 * The book's spelling when it has one, otherwise the ERP's OWN value verbatim.
 *
 * Null only when the ERP has no value at all. The maps stay what they were
 * harvested to be — spelling corrections (`SUTERA MALL` -> `SUTERA MALL SOLO`)
 * — and everything else is sent as the ERP holds it, for `/ensure-masters` to
 * open. That is safe by MEASUREMENT, not by hope: every target all four maps
 * can emit is already a master in the live book (the field-alignment report's
 * first section, regenerated on every run), so the maps never protected against
 * sending something unknown — they only deleted what they had not been told
 * about.
 *
 * THE CALLER STILL HAS TO OPEN IT. A pass-through is only safe where
 * `mastersOf` names the field, so every use of this function is paired with an
 * `/ensure-masters` entry — including on the EDIT path, which reads the same
 * values out of `body.Header`.
 *
 * AND THE SOURCE COLUMN HAS TO BE A VOCABULARY OF THE RIGHT KIND. Three of the
 * all four maps use this now; BRANDING_MAP was the exception until 2026-08-15 —
 * the ERP column behind it holds categories, so a pass-through would open
 * `Bedframe` and `Accessories` as brands. Same distinction `resolveAcAgent`
 * draws for the raw `agent` text: a value with a trustworthy writer may pass
 * through, a column with none may not. Check what the column actually holds
 * before adding a fifth caller.
 */
export function bookSpellingOrOwn(
  value: string | null | undefined,
  map: Record<string, string>,
): string | null {
  const own = tidy(value);
  if (!own) return null;
  return bookSpelling(own, map) ?? own;
}

const price = (centi: number | null | undefined): number => Math.round(centi ?? 0) / 100;


export interface ErpSoHeader {
  doc_no: string;
  so_date: string | null;
  debtor_name: string | null;
  agent: string | null;
  sales_location: string | null;
  branding: string | null;
  venue: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  customer_state: string | null;
  phone: string | null;
  emergency_contact_phone: string | null;
  ref: string | null;
  customer_so_no: string | null;
  /** The SO's "Processing date" — the field with that label in the UI, and the
   *  owner's 账目日期. Its storage is `processing_date` and there is only ONE
   *  such field: 0189 dropped a dead second column carrying this label, and 0284
   *  renamed the surviving one (internal_expected_dd) onto the name everybody
   *  says, because two names for one field kept producing blank dates just as
   *  reliably as two columns did. Do not reintroduce a second source, or a
   *  second name, for it. Goes out as the `PDate` UDF. */
  processing_date?: string | null;
  /**
   * The order's delivery date, which THIS BOOK keeps in
   * `SalesExemptionExpiryDate`.
   *
   * Owner 2026-08-16: *"就是用我们 delivery date 放进去 sales exemption date
   * 而已，一样的东西"*. AutoCount's sales-order HEADER has no delivery date of
   * its own — the SDK lists `DeliveryDate` on the six DETAIL classes and nowhere
   * else — so this book uses the exemption expiry, and Inistate, the connector
   * the ERP replaces, writes it there.
   */
  customer_delivery_date?: string | null;
  linked_ac_docno?: string | null;
}

/**
 * NOT a row shape. `scm.purchase_orders` is supplier-keyed and has none of the
 * four fields below: the creditor is `scm.suppliers.code` / `.name` behind
 * `supplier_id`, and agent and ref do not exist on the ERP side at all.
 * `readPoHeader` (scm/lib/autocount-outbox.ts) is what assembles this — reading
 * these names off the table is the bug in BUG-HISTORY, 2026-08-10.
 */
export interface ErpPoHeader extends PoSupplierDates {
  po_number: string;
  po_date: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  agent: string | null;
  ref: string | null;
  source_so_no: string | null;
  notes: string | null;
  /**
   * The PURCHASE ORDER'S OWN ship-to warehouse, as a `dbo.Location` code.
   *
   * `readPoHeader` resolves it from `scm.purchase_orders.purchase_location_id`
   * (migration PR #77) through `scm.warehouses.code`, the same id -> code hop
   * `withLocations` does for the lines.
   *
   * IT IS A HEADER FIELD ON BOTH SIDES, which is what an earlier comment here
   * denied. AutoCount's purchase documents carry `PurchaseLocation`, assigned in
   * TWO places because the purchase side does not share one header function:
   * `CreatePo` sets its own master (AcSyncService.cs:934-935) and
   * `PurchaseHeader` (:2456-2457) is what /so-to-po and the four conversions
   * apply. `PurchaseHeader`'s own comment records that the ERP "has never been
   * sent" one, so the book has been defaulting it on every purchase order the
   * ERP ever wrote. Owner 2026-08-19: 「它的 Purchase Location 也不对」.
   *
   * The ERP treats it as the DEFAULT for every line and a line's own
   * `warehouse_id` OVERRIDES it (outstanding-po-lines.ts:382,
   * `r.warehouse_id ?? r.po.purchase_location_id`), so `composeCreatePo` passes
   * it as `defaultLocation` as well as sending it on the header.
   */
  purchase_location: string | null;
  linked_ac_docno?: string | null;
}

export interface ErpLine {
  id?: string | null;
  item_code: string;
  item_group?: string | null;
  branding?: string | null;
  description: string | null;
  description2?: string | null;
  qty: number;
  unit_price_sen: number;
  location?: string | null;
  delivery_date?: string | null;
  variants?: Record<string, unknown> | null;
  /** The AutoCount DtlKey this ERP line maps to (PR #1819, mig 0273). NULL is
   *  the correct "create, do not update" signal on the edit path. */
  linked_ac_dtlkey?: number | string | null;
  cancelled?: boolean | null;
  line_no?: number | null;
}

/** A line the ERP removed, named by the AutoCount key it still points at. */
export type { AcLineGoneReason, AcRetiredLine } from './ac-line-gone';


export interface AcDetail {
  ItemCode: string;
  Description: string | null;
  Desc2: string | null;
  Qty: number;
  UnitPrice: number;
  Location?: string | null;
  DeliveryDate?: string | null;
}

/*
 * NO `UOM` KEY, DELIBERATELY — and the extract is the reason it looked like one.
 *
 * `SODTL.UOM` is in the cutover's export and the ERP never sends it, so it reads
 * as a gap. It is not one: AutoCount's UOM is a property of the ITEM, echoed
 * onto the line. Measured over `ac-fidelity-so-lines.json.gz` against the book's
 * own `ItemUOM` rows (`ac-item-costs.json.gz` + `ac-utd-stock-cost.json.gz`),
 * 59,582 of the 59,624 lines carrying a UOM carry one the ITEM's master row
 * holds — the 2 exceptions are the case typo `unit` for `UNIT`. So the line
 * never decides it.
 *
 * The ERP has nothing to add. `mfg_sales_order_items.uom` and
 * `purchase_order_items.uom` are written `(it.uom as string) ?? 'UNIT'` at every
 * create path, so the column is a default, not a fact — and 363 of the 758
 * distinct item codes on those lines have NO `UNIT` row at all (their only UOM
 * is `SET`). Sending the ERP's value would put `UNIT` on a line whose item only
 * has `SET`, against a column the detail foreign-keys to `ItemUOM`, and lose the
 * whole document.
 *
 * The item's UOM is instead set where it belongs — at the moment the item is
 * opened. `/ensure-masters` gives a new item `NewUom(uom, 1m)` + `BaseUom`
 * (AcSyncService.cs), so the line inherits it, and an item the book already
 * holds keeps its own. Owner 2026-08-15: every SKU already carries a UOM.
 */

export interface AcCreateSoPayload {
  DocNo: string;
  DocDate: string | null;
  DebtorCode: string;
  DebtorName: string | null;
  Agent: string | null;
  SalesLocation: string | null;
  Ref: string | null;
  Phone: string | null;
  DeliverPhone1: string | null;
  Attention: string | null;
  InvAddr1: string | null;
  InvAddr2: string | null;
  InvAddr3: string | null;
  InvAddr4: string | null;
  SalesExemptionExpiryDate: string | null;
  UDF: Record<string, string>;
  Details: AcDetail[];
}

export interface AcCreatePoPayload {
  DocNo: string;
  DocDate: string | null;
  CreditorCode: string | null;
  CreditorName: string | null;
  Agent: string | null;
  Ref: string | null;
  Description: string | null;
  PurchaseLocation?: string;
  UDF: Record<string, string>;
  Details: AcDetail[];
}

export interface AcConvertPayload {
  FromDocNo: string;
  DtlKeys?: number[];
  DocDate?: string | null;
  Ref?: string | null;
  Description?: string | null;
  SupplierDONo?: string | null;
  SupplierInvoiceNo?: string | null;
}

export interface AcCancelPayload {
  DocType: AcDocType;
  DocNo: string;
}

/**
 * The six document types AcSyncService can cancel and edit.
 *
 * These are AutoCount's own literals, not the ERP's names: 'IV' is the Sales
 * Invoice and 'GR' the Goods Received Note. Cancel() (AcSyncService.cs:421-426)
 * and Edit() (:441-446) each switch over exactly this set, and the four
 * conversion sources ('SO' | 'PO' | 'DO' | 'GR') are a subset of it.
 */
export type AcDocType = 'SO' | 'PO' | 'DO' | 'GR' | 'IV' | 'PI';

/**
 * A retired line carries the MINIMUM that identifies it and nothing else.
 *
 * AcSyncService's Retire branch `continue`s before it reads Qty / UnitPrice /
 * Description / Location, so sending them would be inert today and a trap
 * tomorrow: the first service build that stops short-circuiting would apply an
 * ERP quantity to a line the ERP has already written off.
 */
export type AcEditLine =
  | (AcDetail & { DtlKey?: number })
  | (AcRetiredLine & { Retire: true });

export interface AcEditPayload {
  DocType: AcDocType;
  DocNo: string;
  Rebuild?: true;
  Header: Record<string, string | null | Record<string, string>>;
  Lines: AcEditLine[];
}

/* The lines the host reports a document holds, and their parser, live in
   ./autocount-created-lines (moved 2026-09-14 for FromDocDtlKey, docs/bugs/0898). */
import { parseCreatedLines, type AcCreatedLine } from './autocount-created-lines';
export { parseCreatedLines, type AcCreatedLine } from './autocount-created-lines';

/**
 * Thrown when an edit cannot be expressed without risking a duplicate line in
 * the live account book. Carries no document data — the message is what an
 * operator reads off the outbox row.
 */
export class KeylessLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeylessLineError';
  }
}

/**
 * What a composer needs to know about the document beyond its rows.
 *
 * `supplierCode` is the creditor (scm.suppliers.code). It is the disambiguator
 * for the ERP codes the cutover collapsed from several AutoCount items — a
 * purchase order has one, a sales order does not, and the difference shows up
 * as refusals on the sales side rather than as guesses.
 */
export interface ComposeOptions {
  /**
   * AN EDIT DOES NOT SEND AN ITEMCODE FOR A LINE THE BOOK ALREADY HOLDS, so it
   * must not refuse one it cannot resolve.
   *
   * `composeEdit` strips `ItemCode` from every keyed line — AUTOCOUNT OWNS THE
   * ITEM ON A LINE IT ALREADY HOLDS, the owner's rule of 2026-08-13 — and then
   * asked `composeDetails` to resolve that code first anyway. So an edit to
   * HC-PO-006690 was refused for `DIVAN ONLY-(Q)` resolving to four book items,
   * none under its creditor: a code the payload was never going to carry.
   *
   * `forTransfer` has said exactly this since it was written ("A TRANSFER KEEPS
   * THE LINE. The ItemCode below is never sent"). This is the same statement for
   * the edit path, and it is deliberately NOT folded into `forTransfer`: a
   * transfer sends four fields, an edit sends the line.
   *
   * KEYED LINES ONLY. A keyless line on an edit is APPENDED and does carry its
   * ItemCode, so it must still resolve or be refused — and a REBUILD puts every
   * ItemCode back, so it must refuse too. Both are checked at the use site.
   */
  keyedLinesKeepTheBooksItem?: boolean;
  rebuild?: boolean;
  rebuildBlocked?: string;
  supplierCode?: string | null;
  itemIndex?: AcItemIndex;
  defaultLocation?: string | null;
  requireLocation?: boolean;
  /**
   * The composed details are for a TRANSFER, which does not send an ItemCode.
   *
   * `AddSOToPOTransferDetail(Int64)` takes a source line KEY and nothing else —
   * AutoCount copies the sales line's own item into the purchase line. So
   * `composeSoToPo` sends DtlKey, UnitPrice, Qty, Location and DeliveryDate,
   * and throws every ItemCode away.
   *
   * Owner 2026-08-25: 「如果它是 by convert 的，那肯定是先跟 Sales Order 的 SKU
   * 进行 convert … SKU 可能就不用看了」. He is right, and the code did the
   * opposite: the transfer path composed a full CREATE payload first — which
   * resolves every line's ItemCode and can throw ItemCodeError — and only then
   * discarded the codes. A purchase order that needs no item code at all was
   * being refused over one. Measured 2026-08-25, 139 bindings resolve to
   * `ambiguous: … none belongs to supplier`; on a transfer every one of them
   * was blocking a document over a value that would never be sent.
   *
   * Set ONLY on the transfer path. The create path must keep refusing, because
   * there the ItemCode really is what opens or names an item in a licensed book.
   */
  forTransfer?: boolean;
  bindings?: Map<string, string> | null;
  newLineIds?: Set<string>;
}

/**
 * Thrown when a sofa build cannot be folded into AutoCount's one-line shape
 * without inventing text. Carries every refused build.
 */
export class SofaCollapseError extends Error {
  readonly refusals: readonly SofaRefusal[];
  constructor(refusals: SofaRefusal[]) {
    super(
      `${refusals.length} sofa build(s) cannot be written to AutoCount faithfully: `
      + refusals.map((r) => r.reason).join('; '),
    );
    this.name = 'SofaCollapseError';
    this.refusals = refusals;
  }
}

/**
 * A CREATE with no stock location is refused, because AutoCount refuses it too.
 *
 * MEASURED ON THE LIVE BOOK, 2026-08-11 11:54:59: a `/create-so` whose lines
 * carried no `Location` came back
 * `AutoCount.Data.ForeignKeyException ... FK_SODTL_Location ... table
 * "dbo.Location", column 'Location'`. The same document at 11:57:43 with
 * `Location: "KL"` on both lines saved. AcSyncService's create path applies the
 * key unconditionally (`Set(() => d.Location = Str(it, "Location"))`) and `Str`
 * turns an absent key into `""` — and `""` is not a row in `dbo.Location`.
 *
 * The omission rule was introduced with a comment claiming it was "a NO-OP on
 * the create routes". It is not, and it was wrong in the direction that fails
 * EVERY create. The rule stays correct for an EDIT, where a blank would
 * overwrite the location the account book already holds; on a CREATE there is
 * nothing to preserve and a foreign key to satisfy.
 */
export class MissingLocationError extends Error {
  readonly lines: ReadonlyArray<{ index: number; itemCode: string }>;
  constructor(lines: Array<{ index: number; itemCode: string }>) {
    super(
      `${lines.length} line(s) carry no stock location and none can be inherited from the `
      + `document: ${lines.map((l) => `${l.index + 1} (${l.itemCode})`).join(', ')}. `
      + 'AutoCount rejects a document line whose Location is not in dbo.Location, and an '
      + 'absent key reaches it as the empty string — so this create would fail on '
      + 'FK_SODTL_Location. Set the warehouse on the line, or the sales location on the '
      + 'document, then save again.',
    );
    this.name = 'MissingLocationError';
    this.lines = lines;
  }
}

/**
 * A CREATE with no salesperson is refused, because AutoCount refuses it too.
 *
 * MEASURED ON THE LIVE BOOK, 2026-08-13 — the day the write-back went live. Two
 * re-queued sales orders retried four times each and AED_HOUZS answered
 * `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)`. Both carried an empty
 * `mfg_sales_orders.agent`, because no SO form has ever sent `body.agent` and
 * that column was the composer's only source. AcSyncService's create applies
 * the key unconditionally (`Set(() => so.Agent = Str(p, "Agent"))`) and `Str`
 * turns an absent key into `""` — and `""` is not a row in `dbo.SalesAgent`.
 *
 * Nothing was written: the foreign key rejects the document before it lands, so
 * a refusal here loses no successful write. It only converts a 500 buried in
 * `C:\Temp\ac-sync-service.log` into a `skipped` outbox row naming the remedy.
 *
 * Same shape and same reason as MissingLocationError, one level up: the
 * document as a whole is refused, never sent with a blank the book will reject.
 */
export class MissingAgentError extends Error {
  readonly agentText: string | null;
  constructor(agentText: string | null) {
    const saw = agentText && agentText.trim()
      ? `\`agent\` holds "${agentText.trim()}", which is neither an AutoCount sales agent nor a `
        + 'name this ERP can vouch for, and no salesperson is linked to the order'
      : 'the order names no salesperson at all — `agent` is blank and `salesperson_id` is empty';
    super(
      `This sales order cannot name an AutoCount sales agent: ${saw}. AutoCount rejects a sales `
      + 'order whose Agent is not in dbo.SalesAgent, and an absent Agent reaches it as the empty '
      + 'string — so this create would fail on FK_SO_SalesAgent, which is exactly what the live '
      + 'book answered on 2026-08-13. Assign a salesperson on the order, then re-queue it.',
    );
    this.name = 'MissingAgentError';
    this.agentText = agentText;
  }
}

/**
 * A CREATE with no stock location ON THE DOCUMENT is refused, one level up from
 * MissingLocationError.
 *
 * `so.SalesLocation` is assigned unconditionally by `CreateSo` and `Str()`
 * turns both an absent key and a present-null into `""`, so there is no way to
 * "leave it alone" on a create — `""` reaches `FK_SO_SalesLocation`, which the
 * live book answered on 2026-08-12, and the whole document is lost.
 *
 * Unreachable for any document that has a line, because `soSalesLocation`
 * falls back to the lines and `requireLocation` has already refused a line with
 * no location of its own. What is left is a sales order with NO live lines at
 * all, which cannot be written to the account book by any route — this converts
 * that into a `skipped` row naming the reason instead of a 500 in the host's log.
 */
export class MissingSalesLocationError extends Error {
  constructor(docNo: string) {
    super(
      `Sales order ${docNo} names no stock location and has no live line to take one from. `
      + 'AutoCount assigns the document\'s SalesLocation unconditionally and rejects one that is '
      + 'not in dbo.Location, so this create would fail on FK_SO_SalesLocation. Set the sales '
      + 'location on the order, or add a line carrying a warehouse, then re-queue it.',
    );
    this.name = 'MissingSalesLocationError';
  }
}

/**
 * A PURCHASE ORDER WITH NO CREDITOR CODE IS REFUSED.
 *
 * `CreatePo` assigns `po.CreditorCode = Str(p, "CreditorCode")` DIRECTLY — not
 * even wrapped in `Set` — so a supplier row with a blank `code`, or a PO with
 * no `supplier_id` at all, sends `""` into `FK_PO_Creditor` and loses the whole
 * document. `mastersOf` opens a creditor only when the code is a non-empty
 * string, so the empty case is exactly the one nothing covers.
 *
 * Same shape and same reason as MissingAgentError: the document cannot land
 * either way, so refusing loses no successful write and turns a 500 buried in
 * `C:\Temp\ac-sync-service.log` into a row an operator can read.
 */
export class MissingCreditorError extends Error {
  constructor(poNumber: string) {
    super(
      `Purchase order ${poNumber} names no AutoCount creditor: its supplier has no code in `
      + '`scm.suppliers.code`, or the order has no supplier at all. AutoCount rejects a purchase '
      + 'order whose CreditorCode is not in dbo.Creditor, and an absent code reaches it as the '
      + 'empty string — so this create would fail on FK_PO_Creditor. Give the supplier a code, '
      + 'then re-queue the order.',
    );
    this.name = 'MissingCreditorError';
  }
}

/**
 * A /so-to-po whose source keys and cost lines do not line up is REFUSED.
 *
 * `composeSoToPo` zips them by index — the Nth key gets the Nth cost — and the
 * two lists are built by different code from different rows: `poTransferShape`
 * counts ERP purchase-order lines, `composeDetails` COLLAPSES a sofa build into
 * a single AutoCount line (divergence D9).
 *
 * THE CASE THAT REACHES IT IS THE MIXED ONE, and `collapseSofaLines` calls it
 * "the dangerous one" itself. A build whose compartments carry NO DtlKeys is
 * passed through and one whose keys are ALL DISTINCT is left separate — either
 * way the counts match. MIXED keys mean the account book holds the build folded
 * while the ERP's record of that is incomplete, so the compartments fold to one
 * line while the transfer still names one source key per ERP row.
 *
 * Nothing downstream catches it. `SoToPo`'s own guard compares the lines it
 * CREATED against `DtlKeys` (AcSyncService.cs:2382-2384), so a short `Details`
 * passes it and simply leaves the tail lines carrying the CUSTOMER's price
 * instead of the supplier's cost — a purchase order that saves, looks right,
 * and pays the wrong number. Refusing composes nothing and writes a readable
 * outbox row instead.
 */
export class AcSoToPoAlignmentError extends Error {
  constructor(poNumber: string, keys: number, details: number) {
    super(
      `Purchase order ${poNumber} cannot be transferred from its sales order: it names ${keys} `
      + `source line(s) but composes ${details} cost line(s), and the two are matched by position. `
      + 'This is what a collapsed sofa build looks like from here — several ERP rows become one '
      + 'AutoCount line while the transfer still names one key per row. The order can still be '
      + 'sent as a plain create; nothing has been written to the account book.',
    );
    this.name = 'AcSoToPoAlignmentError';
  }
}

/**
 * The AutoCount Sales Agent a sales order names, from the ERP's two sources.
 *
 * They are not equally trustworthy, and the order below says so:
 *
 *   1. `agent` THROUGH AGENT_MAP. A hit means the account book already spells
 *      this rep, under its own spelling (`ZACK` -> `Zack`, `KAR JIUN` ->
 *      `TAN KAR JIUN`). Nothing to open, nothing to guess.
 *   2. the SALESPERSON's name, through the same map. Same certainty; it just
 *      arrived by the id rather than the text.
 *   3. the salesperson's name AS ITSELF, opened by `/ensure-masters`. This is
 *      the D10 rule applied to people: an unmapped item code no longer refuses
 *      a document, it resolves to the ERP's own code and the item is opened
 *      (owner 2026-08-13). AGENT_MAP is a snapshot of the book's spellings, not
 *      an allow-list, so every rep hired since would otherwise be unwritable.
 *   4. nothing -> MissingAgentError.
 *
 * WHAT DELIBERATELY NEVER PASSES THROUGH IS THE RAW `agent` TEXT. That column
 * is free text with no writer that keeps it honest: production rows hold bare
 * `scm.staff` UUIDs (`useStaffLookup` carries a UUID_RE for exactly that) and
 * placeholder text like "Unassigned" (HC-SO-2607-008, the order that produced
 * the confirm gate's salesperson rule). `/ensure-masters` opens a sales agent
 * under EXACTLY the string it is given, so passing that through would write
 * permanent garbage master data into a licensed book. `scm.staff.name` is a
 * real person by construction, which is why only IT is trusted unmapped.
 */
export function resolveAcAgent(
  agent: string | null | undefined,
  salespersonName: string | null,
): string | null {
  const mapped = bookSpelling(agent, AGENT_MAP);
  if (mapped) return mapped;
  const name = (salespersonName ?? '').trim();
  if (!name) return null;
  return bookSpelling(name, AGENT_MAP) ?? name;
}

/**
 * The AutoCount PURCHASE agent every ERP purchase order names.
 *
 * A CONSTANT, because the ERP has no such concept: `scm.purchase_orders` has no
 * agent column, there is no purchase-agent picker anywhere in the UI, and
 * `readPoHeader` was sending `null` for all 60 unpushed POs — which reaches
 * `po.Agent` as `""` and fails `FK_PO_PurchaseAgent`, the constraint
 * AcSyncService.cs:552-560 already names. Omitting the key does not help: `Str`
 * turns an absent key into `""` too, and the assignment is unconditional.
 *
 * `OTHERS` is the value the FK chain was debugged with on 2026-08-12 and it
 * already exists in AED_HOUZS as a purchase agent (module guide §7m). It is
 * also what `mastersOf` will open under `PurchaseAgents` if the book ever loses
 * it. CHANGING WHAT THE ACCOUNT BOOK'S PURCHASE REPORTS GROUP BY IS AN OWNER
 * DECISION — this is the single place it is written down.
 */
export const AC_PURCHASE_AGENT = 'OTHERS';

/**
 * The order's reference, as AutoCount's `Ref`.
 *
 * NOT `ToPONo`. That UDF is the book's "PO Doc No." (its EventLog label). The
 * office plug-in writes there the numbers of the purchase orders made from the
 * order, ", "-separated, and keeps the reference in `Ref`. Composing the
 * reference into `ToPONo` overwrote 92 PO numbers and filled 376 blank ones
 * between 2026-09-07 and 09-15, and ERP-made orders reached the book with `Ref`
 * blank (docs/bugs/0926-the-order-s-reference-was-written-into-autocount-s-po-doc-no.md).
 *
 * `ref` first, `customer_so_no` as the fallback: the precedence of owner ruling
 * #2429 and of the screens' `customerRefOf`. An ERP-made order has only
 * `customer_so_no` (75 of 77 filled, `ref` on none); a carried-over one holds
 * the book's Ref in both. `unknown` so a typed header and a bare PostgREST row
 * both pass without a cast.
 */
export function soReference(h: { customer_so_no?: unknown; ref?: unknown }): string | null {
  return tidy(h.ref) ?? tidy(h.customer_so_no);
}

/**
 * The brand this sales order is for, as AutoCount's `BRANDING` UDF.
 *
 * THE HEADER COLUMN IS NULL ON EVERY ERP-CREATED ORDER — no client sends it
 * (`SalesOrderNew.tsx` and `MobileNewSO.tsx` both omit the key) and the SO form
 * has never exposed a branding field. The value the business actually has is on
 * the LINES, snapshotted from the product catalog at line creation by
 * `deriveLineBrandingFromProduct`, and the detail page has been showing it as
 * `first_item_branding` all along.
 *
 * DELIBERATELY NOT THE FULL DISPLAY RULE. `so-display-branding.ts` prefers a
 * MAIN-category line, borrows `mfg_products.branding` for a blank mattress, and
 * falls back to the pseudo-brand `"BEDFRAME"` for a bedframe-only order. The
 * first two need a catalog read, which would make this composer impure; the
 * third must NOT happen here at all — `BEDFRAME` is a CATEGORY, and passing it
 * through would open a category as an option in the account book's brand list.
 * So this takes the first live line that carries brand text and nothing else.
 */
export function soBranding(
  headerBranding: string | null | undefined,
  lines: ErpLine[],
): string | null {
  const own = tidy(headerBranding);
  if (own) return own;
  for (const l of live(lines)) {
    const b = tidy(l.branding);
    if (b) return b;
  }
  return null;
}


/**
 * The document's own AutoCount stock location, for a CREATE.
 *
 * Two steps, and the second is what closes the live gap. `sales_location` is
 * derived from `customer_state` through `state_warehouse_mappings`, so an order
 * with no customer state has none at all — and measured on production
 * 2026-08-14, that is ALL of the exposure: 21 of 115 unpushed sales orders have
 * a blank `sales_location` and NONE has a value `LOCATION_MAP` fails to know.
 * The pass-through alone would therefore have fixed nothing today.
 *
 * The lines are the answer, and they cost nothing to open: `requireLocation`
 * has already refused any create whose line resolves to no location, so every
 * detail on a document that gets this far carries one — and it is a code
 * `mastersOf` is ALREADY collecting off that line, so falling back to it opens
 * no master the document was not opening anyway.
 *
 * EDIT DOES NOT USE THIS. There, an omitted key leaves the account book's own
 * value alone, which is the conservative half of the pair; only a create has
 * nothing to preserve and a foreign key to satisfy.
 */
export function soSalesLocation(
  salesLocation: string | null | undefined,
  details: AcDetail[],
): string | null {
  const own = bookSpellingOrOwn(salesLocation, LOCATION_MAP);
  if (own) return own;
  for (const d of details) {
    const l = tidy(d.Location);
    if (l) return l;
  }
  return null;
}

export { ItemCodeError };

/**
 * Thrown when the line's Description 2 does not fit AutoCount's field.
 *
 * `SODTL.Desc2` / `PODTL.Desc2` are `nvarchar(100)` and the live book is
 * already AT that ceiling — measured over `ac-fidelity-so-lines.json.gz`, the
 * longest of its 15,950 populated values is exactly 100 characters and none is
 * over. So an over-long spec is not a warning: SQL Server refuses the Save and
 * the whole document is lost with a 500 nobody can read.
 *
 * Truncating is not the alternative. Desc2 IS the specification the factory
 * builds from — the colour, the divan, the gap, the special order — and half a
 * specification is a wrong instruction, not a short one. Same reasoning, and
 * the same `AC_DESC2_MAX`, as the sofa collapse's own refusal.
 */
export class Desc2TooLongError extends Error {
  readonly lines: ReadonlyArray<{ index: number; itemCode: string; length: number }>;
  constructor(lines: Array<{ index: number; itemCode: string; length: number }>) {
    super(
      `${lines.length} line(s) carry a Description 2 longer than AutoCount's ${AC_DESC2_MAX} `
      + `characters: ${lines.map((l) => `${l.index + 1} (${l.itemCode}, ${l.length})`).join(', ')}. `
      + 'AutoCount stores SODTL.Desc2 / PODTL.Desc2 as nvarchar(100) and refuses the whole '
      + 'document rather than truncating, and a truncated specification is a wrong instruction '
      + 'to the factory. Shorten the special order or the colour text on that line, then save again.',
    );
    this.name = 'Desc2TooLongError';
    this.lines = lines;
  }
}

/**
 * The line's Description 2 — AutoCount's "Further Description".
 *
 * OWNER, 2026-08-15: *"照片那一边是从 Further Description 那边抽出来的，所以你录入
 * 的时候，也是要录入回 Further Description"*. The cutover PARSED this field to
 * get the ERP's variants — `import-ac-outstanding-so.mjs` turns a bedframe's
 * `Desc2` into `variants.fabricCode` / `gap` / `divanHeight` / `legHeight` /
 * `totalHeight` / `specials` — so the write-back has to put the same
 * specification back.
 *
 * IT USES THE ERP'S OWN RENDERER, and that is the fix rather than a detail of
 * it. This function used to be a SECOND implementation of `buildVariantSummary`
 * — it emitted `Col / Fabric / Seat / Leg` and read colour off `fabricColor`,
 * which is the GRN-family editors' key. A bedframe keeps its colour in
 * `fabricCode` / `colourLabel` and its spec in `gap` / `divanHeight`, so on an
 * ERP-created bedframe line the account book got NONE of it — while the book's
 * own text is `COL` on 6,741 lines, `DIVAN` on 5,778 and `GAP` on 2,620, the
 * three most common labels it has. Two renderers for one string is the shape
 * COE lesson 4 names: when a pipeline decides a shape, nothing downstream may
 * re-derive it.
 *
 * `buildVariantSummary` is the SO / PO / DO / GRN line's Description 2
 * everywhere else in this system, it is pure, it is mirrored to the frontend
 * with a drift check, and its vocabulary is the book's own — `DIVAN`, `GAP`,
 * `LEG`, `SEAT`. Using it means the account book reads what the paperwork
 * reads, and a new attribute reaches AutoCount the day it reaches the screen.
 *
 * A STORED `description2` STILL WINS, VERBATIM. That is the echo path, and it
 * is load-bearing: both cutover importers wrote the book's original text onto
 * every migrated line, and D9's sofa collapse hands this function a collapsed
 * line whose `description2` is the build text it has already decided (echoed
 * character-for-character when the build is unchanged, composed and re-gated
 * when it is not). Re-deriving either from variants would be lossy.
 */
export function composeDescription2(line: ErpLine): string | null {
  const stored = line.description2 && line.description2.trim();
  const text = stored || buildVariantSummary(line.item_group ?? null, line.variants ?? null);
  if (!text) return null;
  return abbreviateDesc2(text, AC_DESC2_MAX);
}

/**
 * The whole ERP -> AutoCount line transformation, in the order it has to happen.
 *
 *   1. COLLAPSE (D9). Sofa compartment lines fold into AutoCount's one line per
 *      sofa, with the build carried in Desc2 — echoed verbatim when the stored
 *      text still decodes to the compartments the ERP holds, composed and
 *      re-decoded when it does not, refused when neither survives the gate.
 *   2. RESOLVE (D10). Every remaining line gets exactly one AutoCount ItemCode
 *      out of the cutover map. There is no fallback to item_code.
 *
 * BOTH STEPS REFUSE THE WHOLE DOCUMENT rather than sending part of it. A
 * half-synced order is a divergence with no marker on either side; a refusal is
 * a 'skipped' outbox row with the reason on it.
 *
 * Returns the collapsed lines alongside the details so the caller can zip
 * AutoCount's DtlKeys back onto the ERP rows that produced each one.
 */
export function composeDetails(
  lines: ErpLine[],
  opts: ComposeOptions = {},
): { details: AcDetail[]; collapsed: CollapsedLine[] } {
  const { lines: collapsed, refusals } = collapseSofaLines(lines);
  if (refusals.length) throw new SofaCollapseError(refusals);

  const failures: Array<{ index: number; erpItemCode: string; detail: string }> = [];
  const locationless: Array<{ index: number; itemCode: string }> = [];
  const overlong: Array<{ index: number; itemCode: string; length: number }> = [];
  const details: AcDetail[] = [];
  collapsed.forEach((l, i) => {
    const r = resolveAcItemCode(l.item_code, {
      supplierCode: opts.supplierCode ?? null,
      index: opts.itemIndex,
      bindings: opts.bindings ?? null,
    });
    const keyed = l.linked_ac_dtlkey != null && String(l.linked_ac_dtlkey) !== '';
    const codeWillBeSent = !opts.forTransfer
      && !(opts.keyedLinesKeepTheBooksItem && keyed && !opts.rebuild);
    if (!r.ok && codeWillBeSent) {
      failures.push({ index: i, erpItemCode: l.item_code, detail: r.detail });
      return;
    }
    const acItemCode = r.ok ? r.acItemCode : l.item_code;
    const raw = l.location ?? opts.defaultLocation ?? null;
    const location = bookSpellingOrOwn(raw, LOCATION_MAP);
    if (!location && opts.requireLocation) {
      locationless.push({ index: i, itemCode: acItemCode });
      return;
    }
    const desc2 = composeDescription2(l as ErpLine);
    if (desc2 && desc2.length > AC_DESC2_MAX) {
      overlong.push({ index: i, itemCode: acItemCode, length: desc2.length });
      return;
    }
    const d: AcDetail = {
      ItemCode: acItemCode,
      Description: l.description ?? null,
      Desc2: desc2,
      Qty: Number(l.qty) || 0,
      UnitPrice: price(l.unit_price_sen),
    };
    if (location) d.Location = location;
    d.DeliveryDate = l.delivery_date ?? null;
    details.push(d);
  });
  if (failures.length) throw new ItemCodeError(failures);
  if (locationless.length) throw new MissingLocationError(locationless);
  if (overlong.length) throw new Desc2TooLongError(overlong);

  return { details, collapsed };
}

/**
 * A cancelled line has no place on a document being CREATED.
 *
 * On the edit path a cancelled line is sent as a retirement, because AutoCount
 * already holds it. On a create AutoCount holds nothing yet, so the only honest
 * rendering of a line the ERP has written off is its absence — sending it would
 * put a live, outstanding, transferable line into a brand-new account-book
 * document for goods nobody is going to deliver.
 */
export const live = (lines: ErpLine[]): ErpLine[] => lines.filter((l) => l.cancelled !== true);

function udf(entries: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) if (v) out[k] = v;
  return out;
}

/**
 * A date on its way into an AutoCount UDF, normalised to `YYYY-MM-DD`.
 *
 * The ERP stores these as text and they arrive in more than one shape — a bare
 * date from a date input, a full ISO timestamp from anything that went through
 * a Date. AutoCount's own reader hands the same field back as
 * `SOUDF_PDate: "2026-08-12T00:00:00"`, which the inbound pull already trims
 * with `dateOnly()`; this is that trim on the way out, so a round trip does not
 * change the value.
 *
 * Anything that is not a date is dropped rather than passed through. Every UDF
 * write inside AcSyncService is wrapped in its exception-swallowing `Set()`
 * helper, so a value AutoCount rejects fails INVISIBLY — no error, no failed
 * outbox row, just a field that never updates. Sending only what is
 * unambiguously a date is the half of that we control from here.
 */
export function acUdfDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(String(v).trim());
  return m ? m[1] : null;
}

/**
 * A sen amount on its way into AutoCount's numeric `UDF_BALANCE`, as the
 * decimal string every other UDF is sent as.
 *
 * ZERO IS A VALUE, NOT AN ABSENCE, and this is the one place that matters:
 * `udf()` drops a falsy entry, so the amount has to arrive as `"0.00"` rather
 * than as `0` or `null` — otherwise a fully-paid order silently keeps whatever
 * balance the account book last held, which is the exact staleness this field
 * exists to remove. `null` means the ERP could not compute one at all.
 *
 * Sent as a STRING because `ApplyUdf` stringifies every UDF value it is given
 * (`kv.Value.ToString()`), so the type is not ours to choose from here. That is
 * the same path `PDate` already takes into `SO.UDF_PDate`, which is a date
 * column — so a typed UDF column taking a string is the established shape in
 * this book, not a new bet. It is not PROVEN, and it cannot fail loudly: every
 * UDF write is wrapped in the service's exception-swallowing `Set()`. What
 * settles it is one document and one look at `SO.UDF_BALANCE` for that DocNo.
 */
export function acUdfMoney(centi: number | null | undefined): string | null {
  if (centi == null || !Number.isFinite(centi)) return null;
  return (Math.round(centi) / 100).toFixed(2);
}

/** One payment's two reference texts, as the ledger holds them. */
export interface ErpPaymentRef {
  account_sheet: string | null;
  approval_code: string | null;
}

const PAYEMENT_DELIMITERS = /[()/]/g;

const cleanPayemenPart = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').replace(PAYEMENT_DELIMITERS, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
};

/**
 * The `PAYEMENT` UDF — where the account sheet and the approval code go back.
 *
 * THE CUTOVER READ THIS FIELD AND NOTHING EVER WROTE IT BACK.
 * `import-ac-outstanding-so.mjs` filled `mfg_sales_order_payments.account_sheet`
 * and `.approval_code` from `SO.UDF_PAYEMENT` on 13,015 headers; the write-back
 * sent five UDFs and not this one, so an ERP-recorded payment reference reached
 * the account book nowhere. The owner's rule is that whatever the cutover
 * extracted must go back.
 *
 * THE FORMAT IS NOT MINE TO CHOOSE. It is whatever `parsePayment` reads, and
 * that function is the one the cutover actually ran, so it is the
 * specification. It lives beside its inverse in
 * `backend/scripts/lib/ac-payment-udf.mjs`, and
 * `autocountPaymentUdf.roundtrip.test.ts` composes with THIS function and
 * parses with THAT one — a format written in one place and read in another is
 * how the two stop agreeing, and this field is free text with no schema to
 * catch it.
 *
 * Returns null when there is nothing to say, so `udf()` drops the key. Omitting
 * is not sending a blank: `Str` turns a present-null into `""`, which would
 * ERASE the cutover's own text on an order whose payments predate the ERP.
 */
/** `SO.UDF_PAYEMENT` is nvarchar(50) in the live book (INFORMATION_SCHEMA, 2026-09-15). */
export const AC_PAYEMENT_MAX = 50;

export function composePaymentUdf(payments: readonly ErpPaymentRef[]): string | null {
  const groups: string[] = [];
  for (const p of payments) {
    const acct = cleanPayemenPart(p?.account_sheet);
    const appr = cleanPayemenPart(p?.approval_code);
    if (!acct && !appr) continue;
    groups.push(`(${acct ?? ''}/${appr ?? ''})`);
  }
  if (!groups.length) return null;
  const spaced = groups.join(' ');
  if (spaced.length <= AC_PAYEMENT_MAX) return spaced;
  /* OVER THE FIELD (docs/bugs/0921). AutoCount refuses a longer value and the
     host swallows the refusal, so the field stayed EMPTY: HC-SO-2609-011's three
     payments came to 63 characters and three sends wrote nothing. The book's own
     long texts run the references together and stop at fifty, oldest first, so
     this does the same with WHOLE references, and the parser still reads the
     first pair. A single reference too long for the field is not cut in half:
     nothing is sent and the book keeps what it has. */
  let text = '';
  for (const g of groups) {
    if (text.length + g.length > AC_PAYEMENT_MAX) break;
    text += g;
  }
  return text || null;
}

export function composeCreateSo(
  header: ErpSoHeader,
  lines: ErpLine[],
  salespersonName: string | null,
  outstandingSen: number | null,
  paymentRefs: readonly ErpPaymentRef[],
  opts: ComposeOptions = {},
): AcCreateSoPayload {
  const agent = resolveAcAgent(header.agent, salespersonName);
  if (!agent) throw new MissingAgentError(header.agent ?? null);
  const details = composeDetails(live(lines), {
    ...opts,
    defaultLocation: opts.defaultLocation ?? header.sales_location,
    requireLocation: true,
  }).details;
  const salesLocation = soSalesLocation(header.sales_location, details);
  if (!salesLocation) throw new MissingSalesLocationError(header.doc_no);
  return {
    DocNo: header.doc_no,
    DocDate: header.so_date,
    DebtorCode: AC_DEBTOR_CODE,
    DebtorName: header.debtor_name,
    Agent: agent,
    SalesLocation: salesLocation,
    Ref: soReference(header),
    Phone: header.phone,
    /* TWO CONTACTS, TWO COLUMNS (owner 2026-08-15: "应该是有一个 Delivery
       Contact，一个是 Contact"). `phone` is the customer's; the delivery-day
       number is `emergency_contact_phone`, which is where the cutover put
       AutoCount's own DeliverPhone1 and where the SO detail page renders it as
       "Emergency contact". Null leaves CreateSo's Or() to reuse Phone, which is
       the cutover's rule read backwards — it kept DeliverPhone1 only when it
       DIFFERED. */
    DeliverPhone1: tidy(header.emergency_contact_phone),
    Attention: header.debtor_name,
    ...soInvoiceAddress(header),
    UDF: udf({
      BRANDING: bookSpellingOrOwn(soBranding(header.branding, lines), BRANDING_MAP),
      VENUE: bookSpellingOrOwn(header.venue, VENUE_MAP),
      /* `PDate` IS AUTOCOUNT'S OWN NAME, NOT OURS — DO NOT "UNIFY" IT.
         The ERP calls this date `processing_date` everywhere it owns; this key
         is the UDF spelling on AutoCount's sales-order document
         (`SO.UDF_PDate`), and it is the one name in the set that a naming
         sweep must leave alone (owner asked 2026-08-18 which of the names was
         the AutoCount write — this one). Renaming it renames nothing in
         AutoCount: the connector drops an unknown UDF, the document posts 200
         without it, and every Processing Date silently stops reaching the
         account book. See SO_PROCESSING_DATE_AC_UDF. */
      [SO_PROCESSING_DATE_AC_UDF]: acUdfDate(header.processing_date),
      BALANCE: acUdfMoney(outstandingSen),
      PAYEMENT: composePaymentUdf(paymentRefs),
    }),
    SalesExemptionExpiryDate: acUdfDate(header.customer_delivery_date),
    Details: details,
  };
}

export function composeCreatePo(
  header: ErpPoHeader,
  lines: ErpLine[],
  opts: ComposeOptions = {},
): AcCreatePoPayload {
  const creditorCode = tidy(header.creditor_code);
  if (!creditorCode) throw new MissingCreditorError(header.po_number);
  const purchaseLocation = bookSpellingOrOwn(header.purchase_location, LOCATION_MAP);
  return {
    DocNo: header.po_number,
    DocDate: header.po_date,
    CreditorCode: creditorCode,
    CreditorName: header.creditor_name,
    Agent: tidy(header.agent) ?? AC_PURCHASE_AGENT,
    Ref: header.ref,
    Description: header.notes,
    ...(purchaseLocation ? { PurchaseLocation: purchaseLocation } : {}),
    UDF: { ...poSupplierDateUdf(header), ...poSourceSoUdf(header) },
    Details: composeDetails(live(lines), {
      supplierCode: opts.supplierCode ?? header.creditor_code ?? null,
      itemIndex: opts.itemIndex,
      bindings: opts.bindings,
      defaultLocation: opts.defaultLocation ?? purchaseLocation,
      requireLocation: true,
      forTransfer: opts.forTransfer,
    }).details,
  };
}

/**
 * An edit payload. Lines that carry an AutoCount DtlKey UPDATE that same line.
 *
 * A LINE WITHOUT A KEY IS REFUSED, and the whole edit with it.
 *
 * The obvious reading of a keyless line — "this one is new, append it" — is the
 * bug. AcSyncService's /edit acted on exactly that reading and called
 * AddDetail(). Measured against production on 2026-08-11, BEFORE the backfill:
 * 0 of 13,907 SO lines and 0 of 864 PO lines on AutoCount-linked documents
 * carried a DtlKey. Every line was keyless, so "append the new one" meant
 * appending a SECOND COPY OF EVERY LINE into a live licensed account book. On a
 * purchase order those copies are permanent — PurchaseOrder exposes neither
 * DeleteDetail nor any line-level Cancelled in the 2.2 SDK.
 *
 * Refusing costs a visible skipped outbox row and one document that does not
 * sync. Appending costs an account book nobody can repair.
 *
 * AcSyncService carries the SAME refusal (see its Edit()), so a service binary
 * that has not been rebuilt yet is also safe. This copy exists so the request is
 * never even sent.
 *
 * A GENUINELY NEW LINE IS THE EXCEPTION, DECLARED and never inferred: the route
 * that inserted the row names it (`newLineIds`), believed only when every OTHER
 * line already carries a key. Those go out `IsNewLine`, which AcSyncService turns
 * into AddDetail(). SO 2026-08-11, PO 2026-08-31 — this said "nothing sets it
 * yet" for the twenty days between them. docs/modules/autocount-writeback.md.
 *
 * LINE REMOVAL — CORRECTED 2026-09-02 (0608). This said removal is ALWAYS a
 * retirement. It is not: a HARD-DELETED line changes the line SET, which
 * rebuilds the document, so the cleared book never carries it. `Retire: true`
 * (Qty = 0, Transferable = false, an `[ERP-CANCELLED]` Desc2 marker) is now for
 * the other case only — a line the ERP still HAS and has cancelled, which must
 * stay visible. Either way it is never an OMISSION: /edit applies only the lines
 * it is GIVEN, so a line simply left out would stay live and transferable.
 *
 * A CANCELLED LINE WITH NO KEY IS REFUSED like any other keyless line, and for
 * a sharper reason: it means the ERP wants a line retired in the account book
 * and cannot name which one. Dropping it would be a silent divergence — the
 * exact failure mode this whole path exists to avoid.
 */
export function composeEdit(
  docType: AcDocType,
  docNo: string,
  header: Record<string, string | null | Record<string, string>>,
  lines: ErpLine[],
  opts: ComposeOptions = {},
  retired: AcRetiredLine[] = [],
): AcEditPayload {
  const effOpts: ComposeOptions = {
    ...opts,
    rebuild: shouldRebuild(opts, docType, retired),
    keyedLinesKeepTheBooksItem: true,
  };
  const { details, collapsed } = composeDetails(lines, effOpts);
  const cancelledOf = (i: number): boolean | 'partial' => {
    const src = collapsed[i].sourceIndexes;
    const n = src.filter((ix) => lines[ix]?.cancelled === true).length;
    if (n === 0) return false;
    return n === src.length ? true : 'partial';
  };
  const partial: SofaRefusal[] = [];
  const keyed: AcEditLine[] = details.map((d, i) => {
    const key = collapsed[i].linked_ac_dtlkey;
    const n = key == null ? null : Number(key);
    const dtlKey = n != null && Number.isFinite(n) ? n : undefined;
    const cancelled = cancelledOf(i);
    if (cancelled === 'partial') {
      partial.push({
        sourceIndexes: collapsed[i].sourceIndexes,
        itemCodes: collapsed[i].sourceIndexes.map((ix) => lines[ix]?.item_code ?? ''),
        reason:
          `${d.ItemCode}: some compartments of this build are cancelled and some are not. `
          + 'AutoCount holds ONE line for the whole build, so there is no shape for a partial '
          + 'retirement — cancel the rest of the build, or reinstate them.',
      });
    }
    if (cancelled === true && dtlKey != null) {
      const line: AcRetiredLine & { Retire: true } = {
        DtlKey: dtlKey, ItemCode: d.ItemCode, Retire: true,
      };
      if (d.Desc2 != null) line.Desc2 = d.Desc2;
      return line;
    }
    if (dtlKey == null) return (effOpts.rebuild ? { ...d, ErpLineIds: erpLineIdsOf(collapsed[i].sourceIndexes, lines) } : d) as AcEditLine;
    /* AUTOCOUNT OWNS THE ITEM ON A LINE IT ALREADY HOLDS — the same rule
     * Location runs under, applied to the item itself. Owner 2026-08-13: an
     * edit to an order that came in through the API changes its Description 2,
     * never its SKU.
     *
     * The ERP's answer for these codes is a POLICY, not a reading of the book.
     * A sales order does not know the brand, so four sofa models resolve to one
     * canonical item — right for a new order, wrong for the 194 real lines the
     * book already holds under the two brand items the cutover collapsed. An
     * edit that sent the canonical code would move every one of them, silently,
     * in a licensed ledger.
     *
     * Swapping the product on a line still propagates, because that is a DELETE
     * plus an ADD: the removed row arrives in `retired` and is zeroed, and the
     * added row has no DtlKey, so it keeps its ItemCode and is appended. Only
     * an in-place item change on a line the book owns is dropped, and the ERP
     * has no such operation. */
    const { ItemCode: acItemCode, ...rest } = d;
    if (rest.DeliveryDate == null) delete rest.DeliveryDate;
    return { ...rest, ...(effOpts.rebuild ? { ItemCode: acItemCode, ErpLineIds: erpLineIdsOf(collapsed[i].sourceIndexes, lines) } : {}), DtlKey: dtlKey } as AcEditLine;
  });

  if (partial.length) throw new SofaCollapseError(partial);

  const keyless: number[] = [];
  keyed.forEach((d, i) => { if (d.DtlKey == null) keyless.push(i); });

  const declaredNew = effOpts.newLineIds ?? null;
  if (declaredNew && declaredNew.size && keyless.length) {
    const isDeclared = (i: number) => {
      const id = collapsed[i].sourceIndexes
        .map((ix) => lines[ix]?.id)
        .find((v) => v != null);
      return id != null && declaredNew.has(String(id));
    };
    if (keyless.every(isDeclared)) {
      for (const i of keyless) {
        const d = keyed[i] as AcDetail & { IsNewLine?: true; ErpLineIds?: string[] };
        d.IsNewLine = true;
        const ids = collapsed[i].sourceIndexes.map((ix) => lines[ix]?.id)
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (ids.length) d.ErpLineIds = ids;
      }
      keyless.length = 0;
    }
  }

  if (keyless.length) {
    const which = keyless
      .map((i) => `${i + 1} (${keyed[i].ItemCode || 'no item code'}${cancelledOf(i) === true ? ', cancelled' : ''})`)
      .join(', ');
    if (effOpts.rebuild) return { DocType: docType, DocNo: docNo, Header: header, Lines: keyed, Rebuild: true };
    const anyCancelled = keyless.some((i) => cancelledOf(i) === true);
    throw new KeylessLineError(
      `${docType} ${docNo}: ${keyless.length} of ${keyed.length} line(s) carry no AutoCount `
      + `DtlKey — line(s) ${which}. `
      + (anyCancelled
        ? 'A cancelled line with no key cannot be retired in AutoCount, and a live one would be '
          + 'appended as a duplicate. '
        : 'Sending this edit would append duplicate lines to the live account book, and on a PO a '
          + 'duplicate cannot be removed. ')
      + 'Backfill scm.*_items.linked_ac_dtlkey for this document, then save it again.',
    );
  }

  const present = new Set(keyed.map((d) => d.DtlKey).filter((k): k is number => k != null));
  for (const r of retired) {
    if (!Number.isFinite(r.DtlKey) || present.has(r.DtlKey)) continue;
    present.add(r.DtlKey);
    keyed.push({ ...r, Retire: true });
  }

  return { DocType: docType, DocNo: docNo, Header: header, Lines: keyed, ...(effOpts.rebuild ? { Rebuild: true as const } : {}) };
}


/** AcSyncService route per outbox operation. */
export const AC_ROUTE = {
  create_so: '/create-so',
  create_po: '/create-po',
  so_to_do: '/so-to-do',
  so_to_po: '/so-to-po',
  po_to_gr: '/po-to-gr',
  do_to_iv: '/do-to-iv',
  gr_to_pi: '/gr-to-pi',
  cancel: '/cancel',
  edit: '/edit',
  ensure_masters: '/ensure-masters',
  health: '/health',
} as const;

export type AcOp = keyof typeof AC_ROUTE;

/**
 * A master the account book ALREADY HELD, under a DIFFERENT company name.
 *
 * `/ensure-masters` used to ask `CreditorExists(acc)` — `GetCreditor(acc) !=
 * null` — and throw away the `CompanyName` it had just read, so a code that
 * resolves to the WRONG company was indistinguishable from one that resolves to
 * the right company at every layer. That is how HC-PO-2608-001 came to be
 * booked against `400-H004`, which the book holds as HAO HUA FURNITURE, for a
 * purchase order the ERP names HOOKKA INDUSTRIES SDN. BHD.
 *
 * IT REPORTS AND IT NEVER REFUSES. The ERP legitimately holds a shorter trading
 * name than the book's registered one on many suppliers, so failing the document
 * would block real purchasing in bulk. `ok` is untouched by a mismatch.
 */
export interface AcMasterMismatch {
  master: string;
  erp: string;
  book: string;
}

export interface AcCallResult {
  ok: boolean;
  status: number;
  docNo: string | null;
  lines: AcCreatedLine[];
  error: string | null;
  mismatches: AcMasterMismatch[];
  body: Record<string, unknown> | null;
  retryable: boolean;
}

/**
 * Read the `mismatched` array off an `/ensure-masters` response, keeping only
 * entries that carry all three strings. A half-parsed entry is DROPPED rather
 * than coerced — the same rule `parseCreatedLines` follows (./autocount-created-lines), and
 * for a sharper reason here: a mismatch line with a blank `book` would read as
 * "the account book calls this supplier nothing", which is a claim about the
 * book that nobody measured.
 */
export function parseAcMismatches(raw: unknown): AcMasterMismatch[] {
  if (!Array.isArray(raw)) return [];
  const out: AcMasterMismatch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const master = typeof r.master === 'string' ? r.master.trim() : '';
    const erp = typeof r.erp === 'string' ? r.erp.trim() : '';
    const book = typeof r.book === 'string' ? r.book.trim() : '';
    if (!master || !erp || !book) continue;
    out.push({ master, erp, book });
  }
  return out;
}

/** Config, not a secret. Absent = the write-back cannot run, and says so. */
export function acServiceConfig(env: Env): { url: string; key: string | null } | null {
  const url = (env as unknown as { AC_SYNC_URL?: string }).AC_SYNC_URL;
  if (!url) return null;
  const key = (env as unknown as { AC_SYNC_KEY?: string }).AC_SYNC_KEY ?? null;
  return { url: url.replace(/\/+$/, ''), key };
}

/**
 * POST one operation to AcSyncService.
 *
 * The service answers 200 {ok:true, docNo?}, or 4xx/500 {ok:false, error}. A
 * REFUSAL is not a transport failure and must never be retried forever: the two
 * that matter are "already transferred downstream" (cancel/edit — the same rule
 * downstream-lock.ts enforces on our side) and a bad payload. Both are 4xx or a
 * 500 carrying AutoCount's own message, and both need a human, not a retry.
 * Only an unreachable host or a bare 5xx is retryable.
 */
export async function callAcService(
  env: Env,
  op: AcOp,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<AcCallResult> {
  const cfg = acServiceConfig(env);
  if (!cfg) {
    return {
      ok: false, status: 0, docNo: null, lines: [], mismatches: [], body: null,
      error: 'AC_SYNC_URL is not configured', retryable: false,
    };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}${AC_ROUTE[op]}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.key ? { 'X-API-KEY': cfg.key } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      docNo: null,
      lines: [],
      mismatches: [],
      body: null,
      error: e instanceof Error ? e.message : String(e),
      retryable: true,
    };
  }

  const text = await res.text().catch(() => '');
  let body: { ok?: boolean; docNo?: string; error?: string; lines?: unknown; mismatched?: unknown } = {};
  try { body = text ? JSON.parse(text) : {}; } catch { }

  if (res.ok && body.ok !== false) {
    return {
      ok: true,
      status: res.status,
      docNo: body.docNo ?? null,
      lines: parseCreatedLines(body.lines),
      mismatches: parseAcMismatches(body.mismatched),
      body: body as Record<string, unknown>,
      error: null,
      retryable: false,
    };
  }
  const GATEWAY = new Set([502, 503, 504]);
  const unreachable = body.error === undefined && GATEWAY.has(res.status);
  const error = unreachable
    ? `the AutoCount host did not answer (HTTP ${res.status}) — the request never reached it, `
      + 'so nothing was refused and nothing was opened. Check that the sync service is running '
      + 'on that machine; https://autocount.houzscentury.com/health answers 200 when it is.'
    : (body.error ?? (text || `AutoCount service responded ${res.status}`));
  return {
    ok: false,
    status: res.status,
    docNo: null,
    lines: [],
    mismatches: parseAcMismatches(body.mismatched),
    body: (body ?? null) as Record<string, unknown> | null,
    error,
    retryable: res.status >= 500,
  };
}


/**
 * WHY THIS EXISTS. `soEditHeader` omits every key the ERP has no value for, and
 * that rule is right for the case it was written for: an order that never had a
 * `Ref` must not blank the one an operator typed into AutoCount. But it also
 * makes the opposite intent inexpressible — an operator who DELETES a value in
 * the ERP gets silence, and the account book keeps the old one forever. The
 * owner's rule is that the ERP is master: *"任何情况 ERP update 就是都要跟"*.
 *
 * The composer cannot tell the two apart, because it reads the SAVED row and
 * both look like an empty column. So the ROUTE says which fields this request
 * wrote — it is the only thing that knows — exactly as it already does for
 * `newLineIds`, and for the same reason: a keyless line means two opposite
 * things and the ERP is not allowed to guess.
 *
 * NOT EVERY FIELD MAY BE CLEARED, and the exclusions are the point:
 *
 *   `agent`          FK_SO_SalesAgent. A blank Agent is not an empty field, it
 *                    is a foreign-key failure that loses the whole document.
 *   `sales_location` Same shape, and company 1 cannot save an order without one
 *                    anyway (so-location-gate.ts).
 *   `debtor_name`    Also travels as `Attention`. An order with no customer name
 *                    is not a state the ERP can produce.
 *   line `ItemCode`  Never re-sent on a line the book owns at all.
 *
 * Everything here is free text or a date with no foreign key behind it.
 */
export const CLEARABLE_SO_HEADER_FIELDS: Readonly<Record<string, string>> = {
  ref: 'Ref',
  customer_so_no: 'Ref',
  phone: 'Phone1',
  emergency_contact_phone: 'DeliverPhone1',
};

/**
 * The ERP columns that pack into `InvAddr1..4`, as ONE unit.
 *
 * `soInvoiceAddress` folds five columns into four lines, so clearing any one of
 * them re-shuffles the rest — line 3 can become line 2. There is no
 * field-by-field answer, so touching ANY of these sends ALL FOUR keys, nulls
 * included, and the account book takes the ERP's whole address block.
 */
export const SO_ADDRESS_FIELDS: readonly string[] = [
  'address1', 'address2', 'address3', 'address4', 'city', 'postcode', 'customer_state',
];

/** `processing_date` is the owner's 账目日期; it leaves as the `PDate` UDF.
 *
 *  EXTERNAL NAME ON THE RIGHT-HAND SIDE. The key is OUR column and follows our
 *  unification; the value is AUTOCOUNT'S UDF and must never be renamed to match
 *  it. This map is exactly where the two vocabularies meet, which is why both
 *  sides are pinned to constants — `SO_PROCESSING_DATE_COLUMN` moves with a
 *  rename, `SO_PROCESSING_DATE_AC_UDF` deliberately does not. */
export const CLEARABLE_SO_UDF_FIELDS: Readonly<Record<string, string>> = {
  [SO_PROCESSING_DATE_COLUMN]: SO_PROCESSING_DATE_AC_UDF,
};

/** Header dates with no foreign key behind them, so a cleared one may travel. */
export const CLEARABLE_SO_DATE_FIELDS: Readonly<Record<string, string>> = {
  customer_delivery_date: 'SalesExemptionExpiryDate',
};

/**
 * The keys this edit must send as an EXPLICIT NULL, from the ERP columns the
 * request wrote.
 *
 * A field is cleared only when the route says it was written AND the saved value
 * is empty. Written-and-still-empty is the operator deleting it; not written at
 * all is silence, and silence keeps the book's value.
 */
export function clearedAcKeys(
  touchedFields: readonly string[],
  saved: Record<string, unknown>,
): { header: string[]; udf: string[] } {
  const touched = new Set(touchedFields);
  const isBlank = (col: string) => String(saved[col] ?? '').trim() === '';
  const header: string[] = [];
  for (const [col, key] of Object.entries(CLEARABLE_SO_HEADER_FIELDS)) {
    if (key === 'Ref' && soReference(saved) != null) continue;
    if (touched.has(col) && isBlank(col) && !header.includes(key)) header.push(key);
  }
  for (const [col, key] of Object.entries(CLEARABLE_SO_DATE_FIELDS)) {
    if (touched.has(col) && isBlank(col)) header.push(key);
  }
  if (SO_ADDRESS_FIELDS.some((f) => touched.has(f))) {
    header.push('InvAddr1', 'InvAddr2', 'InvAddr3', 'InvAddr4');
    header.push('DeliverAddr1', 'DeliverAddr2', 'DeliverAddr3', 'DeliverAddr4');
  }
  const udf: string[] = [];
  for (const [col, key] of Object.entries(CLEARABLE_SO_UDF_FIELDS)) {
    if (touched.has(col) && isBlank(col)) udf.push(key);
  }
  return { header, udf };
}

/**
 * The `/so-to-po` payload: THE SAME MASTER A CREATE WOULD SEND, plus which
 * sales lines this purchase order buys and what the ERP agreed to pay for them.
 *
 * IT TAKES THE CREATE PAYLOAD, and that is the whole design. This function used
 * to build a master of its own — `{ DocNo, DtlKeys, Details }` — and every field
 * `composeCreatePo` grew that this one did not was a field that silently
 * vanished the moment `poTransferShape` answered `transfer`. It cost two live
 * failures, each found on a real document and each patched one field at a time:
 *
 *   CreditorCode  host 2026-08-17 09:15  `CreditorCode required for /so-to-po`,
 *                 which AutoCount reported as `FK_PO_DisplayTerm` — the PAYMENT
 *                 TERM's foreign key, because the term is defaulted from the
 *                 supplier and there was no supplier.
 *   DocNo         host 2026-08-17 10:15  the first transfer that ever succeeded
 *                 landed as `PO-009968` while the ERP calls it `HC-PO-2608-001`.
 *
 * After both patches FIVE were still missing — DocDate, Agent, Ref, Description
 * and UDF — and `Description` is `purchase_orders.notes`, which the owner
 * reported wrong on 2026-08-19. `Agent` is the dangerous one: it carries
 * `AC_PURCHASE_AGENT` behind `FK_PO_PurchaseAgent`, the same class of foreign
 * key as the two above.
 *
 * So the master is SPREAD, not re-listed. A field added to `composeCreatePo`
 * reaches a transfer without anyone remembering this function exists, which is
 * the only property that makes a third one-field patch impossible.
 *
 * WHAT A TRANSFER GENUINELY OVERRIDES, and the only thing it may:
 *
 *   `Details`. A create's detail NAMES the item being bought — ItemCode,
 *     Description, Desc2, Qty, UnitPrice — because AutoCount holds no line yet.
 *     A transfer's detail addresses a line AutoCount already made: the SDK's
 *     `AddSOToPOTransferDetail` brought the sales line across, price and all
 *     (AcSyncService.cs:2358), and phase two reopens the saved document and
 *     applies the ERP's COST over the customer's price by `DtlKey`
 *     (:2391-2411). Those four keys — UnitPrice, Qty, Location, DeliveryDate —
 *     are the only ones phase two reads, so they are the only ones sent; a
 *     fifth would be composed, stored, POSTed and dropped by the host, which is
 *     the exact failure this function's history is made of.
 *
 * NOTHING ELSE IS EXCLUDED. `Ref` is carried even though a transfer's is null
 * by construction (`readPoEnqueueShape` puts the source SO numbers in a
 * CREATE's Ref because AutoCount has no DocTransfer link to carry them, and
 * leaves a transfer's alone because it does) — carrying the key costs nothing
 * and excluding it would be a rule someone has to remember.
 *
 * `DtlKeys` and `Details` are index-aligned by construction, and that is
 * ASSERTED rather than assumed: both come from the same purchase order, but
 * `composeDetails` COLLAPSES a sofa build into one AutoCount line (D9) while
 * `poTransferShape` counts ERP rows, so the two can disagree without anything
 * in between noticing. Misaligned, the Nth key would be given the (N+1)th cost.
 * See `AcSoToPoAlignmentError` for which sofa build actually reaches it.
 */
export function composeSoToPo(
  master: AcCreatePoPayload,
  dtlKeys: readonly number[],
  details: readonly AcDetail[],
): Omit<AcCreatePoPayload, 'Details'> & { DtlKeys: number[]; Details: Array<Record<string, unknown>> } {
  if (dtlKeys.length !== details.length) {
    throw new AcSoToPoAlignmentError(master.DocNo, dtlKeys.length, details.length);
  }
  return {
    ...master,
    DtlKeys: [...dtlKeys],
    Details: details.map((d, i) => ({
      DtlKey: dtlKeys[i],
      UnitPrice: d.UnitPrice,
      Qty: d.Qty,
      ...(d.Location != null ? { Location: d.Location } : {}),
      ...(d.DeliveryDate !== undefined ? { DeliveryDate: d.DeliveryDate } : {}),
    })),
  };
}
