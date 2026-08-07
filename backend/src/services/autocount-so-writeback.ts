// ERP -> AutoCount Sales Order write-back: the ERP-side composer + master
// resolution. Turns an ERP mfg_sales_order (+ items) into the payload the
// middleware's POST /SalesOrder/create expects, and reports which controlled
// masters must be auto-provisioned first so a brand-new SKU/agent/branding/venue
// can never make the push fail.
//
// The middleware (AutoCount 2.x SDK) implements the actual create + upserts; see
// docs/erp-to-autocount-so-writeback.md. This module is pure + dependency-injected
// (the ItemCode resolver is passed in) so it type-checks and unit-tests without a
// live DB or AutoCount.

/** Fixed AutoCount debtor account; the customer's real name is written over it. */
export const AC_DEBTOR_CODE = "300-C002";

/** ERP salesperson label -> AutoCount Sales Agent (agent name IS the AC code). */
export const AGENT_MAP: Record<string, string> = {
  "ANTHONY": "ANTHONY", "YUNY": "YUNY", "KRIS": "KRIS", "SHAWN": "SHAWN",
  "LAWRENCE": "LAWRENCE", "KINGSLEY": "KINGSLEY", "STANLEY": "STANLEY",
  "JUNIE": "JUNIE", "MEI TING": "MEI TING", "PETER": "PETER", "WEI HOW": "WEI HOW",
  "RACHAEL": "RACHAEL", "SALLY": "SALLY", "ZACK": "Zack", "SHELDON TAN": "SHELDON",
  "JAMES SEOW": "JAMES SEOW", "LUCAS": "LUCAS", "ADRIAN": "ADRIAN",
  "ESTHER CHONG": "ESTHER CHONG", "MELVIN CHONG": "MELVIN CHONG",
  "CHEA HUAN": "Chea Huan", "WENGGI": "WENGGI", "KAR JIUN": "TAN KAR JIUN",
  "HWA SHENG": "Hwasheng", "SHI TING": "Chang Shi Ting", "LUIS TEO": "LUIS",
  "PEI FEN": "PEIFEN", "LIM YAU WEI": "LIM YAU WEI", "ETHAN": "ETHAN SOO",
  "WEI PIN": "WEIPIN",
};

/** ERP sales_location (long / free text) -> AutoCount location code. */
export const LOCATION_MAP: Record<string, string> = {
  "KL WAREHOUSE": "KL", "PG WAREHOUSE": "PG", "SLGR WAREHOUSE": "KL",
  "KUALA LUMPUR": "KL", "PETALING JAYA": "KL", "CHERAS": "KL", "SHAH ALAM": "KL",
  "GEORGE TOWN": "PG", "KOTA KINABALU": "SBH", "KUANTAN": "KL", "JOHOR BAHRU": "KL",
  "KL": "KL", "PG": "PG", "SRW": "SRW", "SBH": "SBH", "HQ": "HQ",
};

/** ERP venue -> AutoCount SOUDF_VENUE option (naming differs by SOLO suffix etc). */
export const VENUE_MAP: Record<string, string> = {
  "SUNWAY PYRAMID CONVENTION CENTRE": "SUNWAY PYRAMID CONVENTION CENTRE",
  "SUTERA MALL": "SUTERA MALL SOLO",
  "KLCC CONVENTION CENTRE": "KUALA LUMPUR CONVENTION CENTRE",
  "SUTERA SQUARE": "SUTRA SQUARE JOHOR",
  "MVEC SOUTHKEY": "MIDVALLEY SOUTHKEY JB",
  "SUNWAY KLUANG MALL": "SUNWAY KLUANG MALL SOLO",
  "KSL CITY MALL": "KSL CITY MALL JOHOR SOLO",
};

/** ERP branding -> AutoCount SOUDF_BRANDING option. HOUZS added to AC 2026-08-06. */
export const BRANDING_MAP: Record<string, string> = {
  "AKEMI": "AKEMI", "DUNLOPILLO": "DUNLOPILLO", "ERGOTEX": "ERGOTEX",
  "MYLATEX": "MYLATEX", "HOUZS": "HOUZS", "ZANOTTI": "ZANOTTI", "NONE": "NONE",
};

const norm = (s: string | null | undefined): string =>
  String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/** Map with pass-through for already-canonical values; null/blank -> null. */
function mapOrPassthrough(value: string | null | undefined, map: Record<string, string>): string | null {
  const k = norm(value);
  if (!k) return null;
  if (map[k]) return map[k];
  // already an AC value (present as a map target) -> keep as-is
  for (const v of Object.values(map)) if (norm(v) === k) return v;
  return null; // unknown -> caller provisions / flags
}

export interface ErpSoHeader {
  doc_no: string;
  so_date: string | null;
  debtor_name: string | null;
  agent: string | null;
  sales_location: string | null;
  branding: string | null;
  venue: string | null;
  address1: string | null; address2: string | null;
  address3: string | null; address4: string | null;
  phone: string | null;
  ref: string | null;
  po_doc_no: string | null;
  remark2: string | null;
  line_delivery_date: string | null;
  balance_centi: number | null;
}

export interface ErpSoItem {
  item_code: string;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  qty: number;
  unit_price_centi: number;
  variants: Record<string, unknown> | null;
}

export interface AcSoLine {
  ItemCode: string;
  Description: string | null;
  ItemDescription: string | null; // Description 2
  Qty: number;
  UOM: string | null;
  UnitPrice: number;
}

export interface MasterToProvision {
  kind: "stock_item" | "sales_agent" | "udf_branding" | "udf_venue";
  value: string;
  // for stock_item creation (see docs §4 default template):
  itemGroup?: string | null;
  description?: string | null;
  uom?: string | null;
  mainSupplierCode?: string | null;
}

export interface AcCreateSoPayload {
  DocNo: string;
  DocDate: string | null;
  DebtorCode: string;
  DebtorName: string | null;
  SalesAgent: string | null;
  SalesLocation: string | null;
  SOUDF_BRANDING: string | null;
  SOUDF_VENUE: string | null;
  InvAddr1: string | null; InvAddr2: string | null;
  InvAddr3: string | null; InvAddr4: string | null;
  Phone1: string | null;
  Ref: string | null;
  SOUDF_ToPONo: string | null;
  Remark2: string | null;
  SOUDF_PDate: string | null;
  SOUDF_BALANCE: number | null;
  Detail: AcSoLine[];
}

/** Resolves an ERP item_code to its AutoCount ItemCode (via bindings; sofa lines
 *  collapse to the parent code). Injected so this module stays DB-free. Returns
 *  null when no AutoCount code is known (line then needs a StockItem upsert). */
export type ItemCodeResolver = (erpItemCode: string) => Promise<{
  acItemCode: string | null;
  mainSupplierCode: string | null;
}>;

/** Cents (integer) -> decimal for AutoCount price fields. */
const price = (centi: number | null | undefined): number =>
  Math.round((centi ?? 0)) / 100;

/**
 * Compose the AutoCount SO payload + the masters that must be provisioned first.
 * The middleware runs the pre-flight (upserts) using `mastersToProvision`, then
 * creates the SO from `payload`.
 */
export async function composeAutoCountSalesOrder(
  header: ErpSoHeader,
  items: ErpSoItem[],
  resolveItemCode: ItemCodeResolver,
): Promise<{ payload: AcCreateSoPayload; mastersToProvision: MasterToProvision[] }> {
  const provision: MasterToProvision[] = [];

  const agent = mapOrPassthrough(header.agent, AGENT_MAP);
  if (header.agent && !agent) provision.push({ kind: "sales_agent", value: norm(header.agent) });

  const branding = mapOrPassthrough(header.branding, BRANDING_MAP);
  if (header.branding && !branding) provision.push({ kind: "udf_branding", value: String(header.branding).trim() });

  const venue = mapOrPassthrough(header.venue, VENUE_MAP);
  if (header.venue && !venue) provision.push({ kind: "udf_venue", value: String(header.venue).trim() });

  const location = mapOrPassthrough(header.sales_location, LOCATION_MAP);

  const detail: AcSoLine[] = [];
  for (const it of items) {
    const { acItemCode, mainSupplierCode } = await resolveItemCode(it.item_code);
    const code = acItemCode ?? it.item_code;
    if (!acItemCode) {
      provision.push({
        kind: "stock_item",
        value: it.item_code,
        itemGroup: it.item_group,
        description: it.description ?? it.item_code,
        uom: it.uom,
        mainSupplierCode,
      });
    }
    detail.push({
      ItemCode: code,
      Description: it.description,
      ItemDescription: it.description2 ?? composeDescription2(it),
      Qty: it.qty,
      UOM: it.uom,
      UnitPrice: price(it.unit_price_centi),
    });
  }

  const payload: AcCreateSoPayload = {
    DocNo: header.doc_no,
    DocDate: header.so_date,
    DebtorCode: AC_DEBTOR_CODE,
    DebtorName: header.debtor_name,
    SalesAgent: agent,
    SalesLocation: location,
    SOUDF_BRANDING: branding,
    SOUDF_VENUE: venue,
    InvAddr1: header.address1, InvAddr2: header.address2,
    InvAddr3: header.address3, InvAddr4: header.address4,
    Phone1: header.phone,
    Ref: header.ref,
    SOUDF_ToPONo: header.po_doc_no,
    Remark2: header.remark2,
    SOUDF_PDate: header.line_delivery_date,
    SOUDF_BALANCE: header.balance_centi != null ? price(header.balance_centi) : null,
    Detail: detail,
  };

  // de-dup provision list by kind+value
  const seen = new Set<string>();
  const mastersToProvision = provision.filter((m) => {
    const k = `${m.kind}:${norm(m.value)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { payload, mastersToProvision };
}

/** Build the Description 2 string from ERP variants when the line has none.
 *  Sofa fabric/leg/seat etc. -> a single text blob (AutoCount has no per-variant
 *  fields). Bedframe lines usually already carry it in description2. */
export function composeDescription2(it: ErpSoItem): string | null {
  const v = it.variants ?? {};
  const parts: string[] = [];
  const push = (label: string, key: string) => {
    const val = (v as Record<string, unknown>)[key];
    if (val != null && String(val).trim() !== "") parts.push(`${label}: ${String(val).trim()}`);
  };
  push("Col", "fabricColor");
  push("Fabric", "fabricLabel");
  push("Seat", "seatHeight");
  push("Leg", "legHeight");
  return parts.length ? parts.join(" / ") : null;
}

export interface BindingRow {
  supplierSku: string;        // the AutoCount ItemCode
  mainSupplierCode: string | null;
}

/**
 * Build an ItemCodeResolver from the ERP supplier bindings (material_code ->
 * AutoCount supplier_sku). Direct hit first; a sofa compartment with no direct
 * binding collapses to the parent model's sofa code (owner's rule: all
 * compartments point to one AutoCount code, the compartment goes into Desc 2).
 * The route loads the bindings once and injects this — keeps the composer DB-free.
 */
export function makeItemCodeResolver(
  bindings: Map<string, BindingRow>
): ItemCodeResolver {
  const parentOf = (code: string) => code.split("-")[0].trim().toUpperCase();
  return async (erpItemCode: string) => {
    const direct = bindings.get(erpItemCode);
    if (direct) return { acItemCode: direct.supplierSku, mainSupplierCode: direct.mainSupplierCode };
    const parent = parentOf(erpItemCode);
    for (const [code, b] of bindings) {
      if (parentOf(code) === parent && /SOFA/i.test(b.supplierSku)) {
        return { acItemCode: b.supplierSku, mainSupplierCode: b.mainSupplierCode };
      }
    }
    return { acItemCode: null, mainSupplierCode: null };
  };
}
