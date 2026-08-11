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
import {
  ItemCodeError,
  resolveAcItemCode,
  type AcItemIndex,
} from './autocount-item-code';
import {
  collapseSofaLines,
  type CollapsedLine,
  type SofaRefusal,
} from './autocount-sofa-collapse';

/** Fixed AutoCount debtor account; the customer's real name is written over it. */
export const AC_DEBTOR_CODE = '300-C002';

/** ERP salesperson label -> AutoCount Sales Agent (the agent name IS the code). */
export const AGENT_MAP: Record<string, string> = {
  ANTHONY: 'ANTHONY', YUNY: 'YUNY', KRIS: 'KRIS', SHAWN: 'SHAWN',
  LAWRENCE: 'LAWRENCE', KINGSLEY: 'KINGSLEY', STANLEY: 'STANLEY',
  JUNIE: 'JUNIE', 'MEI TING': 'MEI TING', PETER: 'PETER', 'WEI HOW': 'WEI HOW',
  RACHAEL: 'RACHAEL', SALLY: 'SALLY', ZACK: 'Zack', 'SHELDON TAN': 'SHELDON',
  'JAMES SEOW': 'JAMES SEOW', LUCAS: 'LUCAS', ADRIAN: 'ADRIAN',
  'ESTHER CHONG': 'ESTHER CHONG', 'MELVIN CHONG': 'MELVIN CHONG',
  'CHEA HUAN': 'Chea Huan', WENGGI: 'WENGGI', 'KAR JIUN': 'TAN KAR JIUN',
  'HWA SHENG': 'Hwasheng', 'SHI TING': 'Chang Shi Ting', 'LUIS TEO': 'LUIS',
  'PEI FEN': 'PEIFEN', 'LIM YAU WEI': 'LIM YAU WEI', ETHAN: 'ETHAN SOO',
  'WEI PIN': 'WEIPIN',
};

/** ERP sales_location (long / free text) -> AutoCount location code. */
export const LOCATION_MAP: Record<string, string> = {
  'KL WAREHOUSE': 'KL', 'PG WAREHOUSE': 'PG', 'SLGR WAREHOUSE': 'KL',
  'KUALA LUMPUR': 'KL', 'PETALING JAYA': 'KL', CHERAS: 'KL', 'SHAH ALAM': 'KL',
  'GEORGE TOWN': 'PG', 'KOTA KINABALU': 'SBH', KUANTAN: 'KL', 'JOHOR BAHRU': 'KL',
  KL: 'KL', PG: 'PG', SRW: 'SRW', SBH: 'SBH', HQ: 'HQ',
};

/** ERP venue -> AutoCount VENUE UDF option (naming differs by SOLO suffix etc). */
export const VENUE_MAP: Record<string, string> = {
  'SUNWAY PYRAMID CONVENTION CENTRE': 'SUNWAY PYRAMID CONVENTION CENTRE',
  'SUTERA MALL': 'SUTERA MALL SOLO',
  'KLCC CONVENTION CENTRE': 'KUALA LUMPUR CONVENTION CENTRE',
  'SUTERA SQUARE': 'SUTRA SQUARE JOHOR',
  'MVEC SOUTHKEY': 'MIDVALLEY SOUTHKEY JB',
  'SUNWAY KLUANG MALL': 'SUNWAY KLUANG MALL SOLO',
  'KSL CITY MALL': 'KSL CITY MALL JOHOR SOLO',
};

/** ERP branding -> AutoCount BRANDING UDF option. HOUZS added to AC 2026-08-06. */
export const BRANDING_MAP: Record<string, string> = {
  AKEMI: 'AKEMI', DUNLOPILLO: 'DUNLOPILLO', ERGOTEX: 'ERGOTEX',
  MYLATEX: 'MYLATEX', HOUZS: 'HOUZS', ZANOTTI: 'ZANOTTI', NONE: 'NONE',
};

const norm = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Map, with pass-through for a value that is already canonical. */
export function mapOrPassthrough(
  value: string | null | undefined,
  map: Record<string, string>,
): string | null {
  const k = norm(value);
  if (!k) return null;
  if (map[k]) return map[k];
  for (const v of Object.values(map)) if (norm(v) === k) return v;
  return null;
}

/** Cents (integer) -> the decimal AutoCount price fields want. */
const price = (centi: number | null | undefined): number => Math.round(centi ?? 0) / 100;

// ── ERP-side row shapes (only the fields the write-back reads) ───────────────

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
  phone: string | null;
  ref: string | null;
  po_doc_no: string | null;
  /** AutoCount SO number this ERP order came FROM, when it was imported at the
   *  cutover (mig 0271). Non-null means the counterpart already exists. */
  linked_ac_docno?: string | null;
}

/**
 * NOT a row shape. `scm.purchase_orders` is supplier-keyed and has none of the
 * four fields below: the creditor is `scm.suppliers.code` / `.name` behind
 * `supplier_id`, and agent and ref do not exist on the ERP side at all.
 * `readPoHeader` (scm/lib/autocount-outbox.ts) is what assembles this — reading
 * these names off the table is the bug in BUG-HISTORY, 2026-08-10.
 */
export interface ErpPoHeader {
  po_number: string;
  po_date: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  agent: string | null;
  ref: string | null;
  notes: string | null;
  linked_ac_docno?: string | null;
}

export interface ErpLine {
  item_code: string;
  item_group?: string | null;
  description: string | null;
  description2?: string | null;
  qty: number;
  unit_price_centi: number;
  location?: string | null;
  delivery_date?: string | null;
  variants?: Record<string, unknown> | null;
  /** The AutoCount DtlKey this ERP line maps to (PR #1819, mig 0273). NULL is
   *  the correct "create, do not update" signal on the edit path. */
  linked_ac_dtlkey?: number | string | null;
}

// ── AcSyncService payload shapes ────────────────────────────────────────────

export interface AcDetail {
  ItemCode: string;
  Description: string | null;
  Desc2: string | null;
  Qty: number;
  UnitPrice: number;
  Location?: string | null;
  DeliveryDate?: string | null;
}

export interface AcCreateSoPayload {
  DocNo: string;
  DocDate: string | null;
  DebtorCode: string;
  DebtorName: string | null;
  Agent: string | null;
  SalesLocation: string | null;
  Ref: string | null;
  Phone: string | null;
  Attention: string | null;
  InvAddr1: string | null;
  InvAddr2: string | null;
  InvAddr3: string | null;
  InvAddr4: string | null;
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
  DocType: string;
  DocNo: string;
}

export interface AcEditPayload {
  DocType: string;
  DocNo: string;
  Header: Record<string, string | null>;
  Lines: Array<AcDetail & { DtlKey?: number }>;
}

/**
 * One line AutoCount created, as the create and convert routes now report them.
 * Ordered by DtlKey, which is creation order. ItemCode travels with the key so
 * the caller can ASSERT its index-zip before storing anything: a wrong DtlKey
 * silently edits a different line in a live book, which is strictly worse than
 * no DtlKey (no key is refused loudly by composeEdit).
 */
export interface AcCreatedLine {
  Seq: number;
  DtlKey: number;
  ItemCode: string;
  Desc2?: string | null;
}

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
  supplierCode?: string | null;
  /** Test seam: an alternative cutover map. Defaults to the compiled one. */
  itemIndex?: AcItemIndex;
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

export { ItemCodeError };

/**
 * Build the Description 2 string from ERP variants when the line has none.
 * Sofa fabric/leg/seat collapse into one text blob because AutoCount has no
 * per-variant fields; bedframe lines usually already carry description2.
 * Carried over from PR #1696.
 */
export function composeDescription2(line: ErpLine): string | null {
  if (line.description2 && line.description2.trim()) return line.description2.trim();
  const v = line.variants ?? {};
  const parts: string[] = [];
  const push = (label: string, key: string) => {
    const val = (v as Record<string, unknown>)[key];
    if (val != null && String(val).trim() !== '') parts.push(`${label}: ${String(val).trim()}`);
  };
  push('Col', 'fabricColor');
  push('Fabric', 'fabricLabel');
  push('Seat', 'seatHeight');
  push('Leg', 'legHeight');
  return parts.length ? parts.join(' / ') : null;
}

/**
 * The whole ERP -> AutoCount line transformation, in the order it has to happen.
 *
 *   1. COLLAPSE (D9). Sofa compartment lines fold into AutoCount's one line per
 *      sofa, with the build carried in Desc2 — echoed verbatim when the stored
 *      text still decodes to the compartments the ERP holds, composed and
 *      re-decoded when it does not, refused when neither survives the gate.
 *   2. RESOLVE (D10). Every remaining line gets exactly one AutoCount ItemCode
 *      out of the cutover map. There is no fallback to material_code.
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
  const details: AcDetail[] = [];
  collapsed.forEach((l, i) => {
    const r = resolveAcItemCode(l.item_code, {
      supplierCode: opts.supplierCode ?? null,
      index: opts.itemIndex,
    });
    if (!r.ok) {
      failures.push({ index: i, erpItemCode: l.item_code, detail: r.detail });
      return;
    }
    details.push({
      ItemCode: r.acItemCode,
      Description: l.description ?? null,
      Desc2: composeDescription2(l as ErpLine),
      Qty: Number(l.qty) || 0,
      UnitPrice: price(l.unit_price_centi),
      Location: l.location ? mapOrPassthrough(l.location, LOCATION_MAP) ?? l.location : null,
      DeliveryDate: l.delivery_date ?? null,
    });
  });
  if (failures.length) throw new ItemCodeError(failures);

  return { details, collapsed };
}

/** UDF entries, blanks dropped — AcSyncService writes every key it is given. */
function udf(entries: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) if (v) out[k] = v;
  return out;
}

export function composeCreateSo(
  header: ErpSoHeader,
  lines: ErpLine[],
  opts: ComposeOptions = {},
): AcCreateSoPayload {
  return {
    DocNo: header.doc_no,
    DocDate: header.so_date,
    DebtorCode: AC_DEBTOR_CODE,
    DebtorName: header.debtor_name,
    Agent: mapOrPassthrough(header.agent, AGENT_MAP),
    SalesLocation: mapOrPassthrough(header.sales_location, LOCATION_MAP),
    Ref: header.ref,
    Phone: header.phone,
    Attention: header.debtor_name,
    InvAddr1: header.address1,
    InvAddr2: header.address2,
    InvAddr3: header.address3,
    InvAddr4: header.address4,
    UDF: udf({
      BRANDING: mapOrPassthrough(header.branding, BRANDING_MAP),
      VENUE: mapOrPassthrough(header.venue, VENUE_MAP),
      ToPONo: header.po_doc_no,
    }),
    Details: composeDetails(lines, opts).details,
  };
}

export function composeCreatePo(
  header: ErpPoHeader,
  lines: ErpLine[],
  opts: ComposeOptions = {},
): AcCreatePoPayload {
  return {
    DocNo: header.po_number,
    DocDate: header.po_date,
    CreditorCode: header.creditor_code,
    CreditorName: header.creditor_name,
    Agent: mapOrPassthrough(header.agent, AGENT_MAP),
    Ref: header.ref,
    Description: header.notes,
    UDF: {},
    /* The creditor is the D10 disambiguator, and a PO always has one. Defaulted
       from the header so no caller can forget it. */
    Details: composeDetails(lines, {
      supplierCode: opts.supplierCode ?? header.creditor_code ?? null,
      itemIndex: opts.itemIndex,
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
 * KNOWN LIMITATION, deliberate: a genuinely new line added to a document that
 * AutoCount already has is refused too, because the ERP cannot yet tell it apart
 * from a legacy line whose key was never stored. AcSyncService accepts an
 * explicit IsNewLine marker for that case and nothing sets it yet — see
 * docs/modules/autocount-writeback.md for what has to be true first.
 */
export function composeEdit(
  docType: 'SO' | 'PO',
  docNo: string,
  header: Record<string, string | null>,
  lines: ErpLine[],
  opts: ComposeOptions = {},
): AcEditPayload {
  const { details, collapsed } = composeDetails(lines, opts);
  /* The key is read off the COLLAPSED line, not the ERP line. One AutoCount
     line has one DtlKey, and a sofa build's compartments only carry line
     identity when every one of them holds the same key — anything else
     collapses to null here and is refused below, which is the whole point. */
  const keyed: Array<AcDetail & { DtlKey?: number }> = details.map((d, i) => {
    const key = collapsed[i].linked_ac_dtlkey;
    const n = key == null ? null : Number(key);
    return n != null && Number.isFinite(n) ? { ...d, DtlKey: n } : d;
  });

  const keyless: number[] = [];
  keyed.forEach((d, i) => { if (d.DtlKey == null) keyless.push(i); });
  if (keyless.length) {
    const which = keyless.map((i) => `${i + 1} (${keyed[i].ItemCode || 'no item code'})`).join(', ');
    throw new KeylessLineError(
      `${docType} ${docNo}: ${keyless.length} of ${keyed.length} line(s) carry no AutoCount `
      + `DtlKey — line(s) ${which}. Sending this edit would append duplicate lines to the live `
      + `account book, and on a PO a duplicate cannot be removed. Backfill `
      + `scm.*_items.linked_ac_dtlkey for this document, then save it again.`,
    );
  }

  return { DocType: docType, DocNo: docNo, Header: header, Lines: keyed };
}

// ── the HTTP client ─────────────────────────────────────────────────────────

/** AcSyncService route per outbox operation. */
export const AC_ROUTE = {
  create_so: '/create-so',
  create_po: '/create-po',
  so_to_do: '/so-to-do',
  po_to_gr: '/po-to-gr',
  do_to_iv: '/do-to-iv',
  gr_to_pi: '/gr-to-pi',
  cancel: '/cancel',
  edit: '/edit',
} as const;

export type AcOp = keyof typeof AC_ROUTE;

export interface AcCallResult {
  ok: boolean;
  /** HTTP status, or 0 when the host could not be reached at all. */
  status: number;
  /** AutoCount's document number, when the route returns one. */
  docNo: string | null;
  /**
   * The lines AutoCount created, when the route returns them. EMPTY is a
   * legitimate answer and must not be treated as a failure: an older
   * AcSyncService binary does not send them at all, and the service degrades to
   * an empty array when its own read-back fails rather than losing the DocNo.
   */
  lines: AcCreatedLine[];
  error: string | null;
  /** False for a refusal a retry cannot fix (a 4xx, or AutoCount saying no). */
  retryable: boolean;
}

/**
 * Read the `lines` array off a service response, keeping only entries that are
 * completely usable. A half-parsed entry is dropped rather than coerced: a
 * DtlKey guessed from a malformed row would be stored as line identity and used
 * to edit a live document.
 */
export function parseCreatedLines(raw: unknown): AcCreatedLine[] {
  if (!Array.isArray(raw)) return [];
  const out: AcCreatedLine[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const r = entry as Record<string, unknown>;
    const key = Number(r.DtlKey);
    if (!Number.isFinite(key) || key <= 0) return;
    const seq = Number(r.Seq);
    out.push({
      Seq: Number.isFinite(seq) ? seq : i,
      DtlKey: key,
      ItemCode: typeof r.ItemCode === 'string' ? r.ItemCode : '',
      Desc2: typeof r.Desc2 === 'string' ? r.Desc2 : null,
    });
  });
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
    return { ok: false, status: 0, docNo: null, lines: [], error: 'AC_SYNC_URL is not configured', retryable: false };
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
    // The AutoCount host reboots and the tunnel drops. Always retryable.
    return {
      ok: false,
      status: 0,
      docNo: null,
      lines: [],
      error: e instanceof Error ? e.message : String(e),
      retryable: true,
    };
  }

  const text = await res.text().catch(() => '');
  let body: { ok?: boolean; docNo?: string; error?: string; lines?: unknown } = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* keep the raw text below */ }

  if (res.ok && body.ok !== false) {
    return {
      ok: true,
      status: res.status,
      docNo: body.docNo ?? null,
      lines: parseCreatedLines(body.lines),
      error: null,
      retryable: false,
    };
  }
  const error = body.error ?? (text || `AutoCount service responded ${res.status}`);
  return {
    ok: false,
    status: res.status,
    docNo: null,
    lines: [],
    error,
    /* 4xx is configuration or a bad payload — a retry cannot fix either, so
       fail it now with the message intact. 5xx is ambiguous by construction:
       AcSyncService turns EVERY exception into a 500 (AcSyncService.cs:107), so
       the same status carries both "AutoCount login failed" (transient) and
       "already transferred downstream" (permanent, and the mirror image of the
       rule downstream-lock.ts enforces on our side). Retrying is the cheaper
       mistake: a permanent refusal simply exhausts its attempts and lands in
       'failed' still carrying AutoCount's own words, whereas dead-lettering a
       transient one loses a document until a human notices. */
    retryable: res.status >= 500,
  };
}
