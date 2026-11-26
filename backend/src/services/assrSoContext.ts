import type { Env } from "../types";
import { soStreetTail } from "./autocount-address-fit";
import { canonicalizeMyState, isCanonicalMyState } from "../scm/lib/canonical-state";
import { postcodeInLines } from "../scm/shared/assr-case-address";

export interface SoCaseAddress {
  addr1: string | null;
  addr2: string | null;
  addr3: string | null;
  addr4: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
}

const t = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).replace(/\s+/g, " ").trim();
  return s ? s : null;
};

/** An order's address as the case stores it. An ERP order carries postcode /
 *  city / state as columns, so its town lines (address3 / address4, often the
 *  cutover's stale "51200 Kuala Lumpur", BUG-40) are dropped unless they carry
 *  the street on (soStreetTail). An order with neither (the AutoCount mirror,
 *  an old ERP import) keeps its four lines, and the postcode / state they name
 *  are lifted out; the city is left to the operator. Null when there is no
 *  address at all. Pure. */
export function caseAddressFromSo(o: {
  address1: unknown; address2: unknown; address3: unknown; address4: unknown;
  postcode: unknown; city: unknown; customer_state: unknown;
}): SoCaseAddress | null {
  const postcode = t(o.postcode);
  const state = t(o.customer_state);
  let out: SoCaseAddress;
  if (postcode || state) {
    const line2 = [t(o.address2), ...soStreetTail(o)].filter(Boolean).join(", ") || null;
    out = { addr1: t(o.address1), addr2: line2, addr3: null, addr4: null, postcode, city: t(o.city), state };
  } else {
    const lines = { addr1: t(o.address1), addr2: t(o.address2), addr3: t(o.address3), addr4: t(o.address4) };
    const named = canonicalizeMyState(lines.addr4);
    out = { ...lines, postcode: postcodeInLines(lines), city: t(o.city), state: named && isCanonicalMyState(named) ? named : null };
  }
  return Object.values(out).some((v) => v != null) ? out : null;
}

export async function fetchScmSoContext(
  env: Env,
  docNo: string
): Promise<{ context: Record<string, unknown>; company_id: number | null; address: SoCaseAddress | null } | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT o.debtor_name, o.phone, o.sales_location,
              COALESCE(NULLIF(o.agent, ''), sp.name) AS agent,
              o.ref, o.address1, o.address2, o.address3, o.address4,
              o.postcode, o.city, o.customer_state, o.company_id
         FROM scm."mfg_sales_orders" o
         LEFT JOIN scm.staff sp ON sp.id = o.salesperson_id
        WHERE LOWER(o.doc_no) = LOWER(?)
          AND o.status <> 'DRAFT' AND o.status <> 'CANCELLED'
        LIMIT 1`
    )
      .bind(docNo)
      .first<Record<string, unknown>>();
    if (!row) return null;
    const address = caseAddressFromSo(row as Parameters<typeof caseAddressFromSo>[0]);
    return {
      context: {
        DebtorName: row.debtor_name ?? null,
        Phone1: row.phone ?? null,
        SalesLocation: row.sales_location ?? null,
        SalesAgent: row.agent ?? null,
        SOUDF_ToPONo: null,
        InvAddr1: address?.addr1 ?? null,
        InvAddr2: address?.addr2 ?? null,
        InvAddr3: address?.addr3 ?? null,
        InvAddr4: address?.addr4 ?? null,
        Ref: row.ref ?? null,
      },
      company_id: row.company_id != null ? Number(row.company_id) : null,
      address,
    };
  } catch {
    return null;
  }
}

/** The address of the order a corrected SO No. names: the ERP order first, else
 *  the HOUZS AutoCount mirror (sales_orders.inv_addr1..4). Null when neither
 *  holds an address. */
export async function soAddressForDoc(env: Env, docNo: string): Promise<SoCaseAddress | null> {
  const scm = await fetchScmSoContext(env, docNo);
  if (scm?.address) return scm.address;
  const m = await env.DB.prepare(
    `SELECT inv_addr1, inv_addr2, inv_addr3, inv_addr4 FROM sales_orders WHERE LOWER(doc_no) = LOWER(?)`
  )
    .bind(docNo)
    .first<Record<string, string | null>>();
  if (!m) return null;
  return caseAddressFromSo({
    address1: m.inv_addr1, address2: m.inv_addr2, address3: m.inv_addr3, address4: m.inv_addr4,
    postcode: null, city: null, customer_state: null,
  });
}
