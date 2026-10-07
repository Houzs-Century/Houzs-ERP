// Product request (owner 2026-10-06: to request new product / repack product)
// — the pure rules. No DB, no I/O; the route (routes/product-requests.ts)
// and the Purchase Consignment Order's create door import them, and so can a
// client.
//
// A salesperson asks for a product — an existing SKU, or a Model the catalogue
// does not have yet — in a fabric, seat size and leg size, for a use, delivered
// where and by when. The Purchaser answers: approve or reject; for a new Model,
// build the Model + SKU from the request; then raise the Purchase Consignment
// Order from it. One request, one approver (like the PO amendment).

export const PRODUCT_REQUEST_TYPES = ['NEW_PRODUCT', 'REPACK'] as const;
export type ProductRequestType = (typeof PRODUCT_REQUEST_TYPES)[number];

export const PRODUCT_REQUEST_APPLICATIONS = ['SHOWROOM', 'CUSTOMER_ORDER', 'SAMPLE'] as const;
export type ProductRequestApplication = (typeof PRODUCT_REQUEST_APPLICATIONS)[number];

export const PRODUCT_REQUEST_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PCO_ISSUED', 'CLOSED'] as const;
export type ProductRequestStatus = (typeof PRODUCT_REQUEST_STATUSES)[number];

export type ProductRequestAction = 'approve' | 'reject' | 'withdraw' | 'resubmit' | 'issue_pco' | 'close';

const FLOW: Record<ProductRequestAction, { from: ProductRequestStatus[]; to: ProductRequestStatus }> = {
  // The Purchaser's yes. A Model/SKU build and a PC Order may follow.
  approve:   { from: ['REQUESTED'], to: 'APPROVED' },
  // The Purchaser's no, with the why — the requester may fix it and resubmit.
  reject:    { from: ['REQUESTED'], to: 'REJECTED' },
  // The requester pulls it back, before or after a rejection.
  withdraw:  { from: ['REQUESTED', 'REJECTED'], to: 'WITHDRAWN' },
  // A rejected request, corrected and sent again.
  resubmit:  { from: ['REJECTED'], to: 'REQUESTED' },
  // A Purchase Consignment Order was raised from it.
  issue_pco: { from: ['APPROVED'], to: 'PCO_ISSUED' },
  // Nothing more to do: the goods came in, or the Purchaser ends it.
  close:     { from: ['APPROVED', 'PCO_ISSUED'], to: 'CLOSED' },
};

export const canTransition = (s: ProductRequestStatus, a: ProductRequestAction): boolean => FLOW[a].from.includes(s);
export const nextStatus = (s: ProductRequestStatus, a: ProductRequestAction): ProductRequestStatus | null =>
  canTransition(s, a) ? FLOW[a].to : null;

/** The requester may still change the request (edit, withdraw) while nobody
    has acted on it, or after the Purchaser sent it back. */
export const requesterMayChange = (s: ProductRequestStatus): boolean => s === 'REQUESTED' || s === 'REJECTED';

/** Open for the Purchaser: waiting for a decision. */
export const awaitsPurchaser = (s: ProductRequestStatus): boolean => s === 'REQUESTED';

export type ProductRequestProduct = {
  request_type: string;
  item_code: string | null;
  proposed_model_name: string | null;
};

/** Why a request's product line is not acceptable, or null when it is.
    A REPACK re-packs something the catalogue has, so it names an existing SKU.
    A NEW_PRODUCT names an existing SKU (a variant the catalogue can already
    make) or the Model the requester wants, by name. */
export function productRefusal(p: ProductRequestProduct): { error: string; message: string } | null {
  const code = (p.item_code ?? '').trim();
  const proposed = (p.proposed_model_name ?? '').trim();
  if (p.request_type === 'REPACK') {
    if (!code) return { error: 'item_code_required', message: 'A repack names the SKU being re-packed — pick it from the catalogue.' };
    return null;
  }
  if (!code && !proposed) return { error: 'product_required', message: 'Pick an existing SKU, or give the new Model a name.' };
  return null;
}

/** Why a Purchase Consignment Order may not be raised from this request, or
    null when it may: the Purchaser must have approved it, and the product must
    exist in the catalogue (a new Model is built first, from the request). */
export function pcoFromRequestRefusal(r: { status: string; item_code: string | null; request_no: string }): { error: string; message: string } | null {
  if (r.status !== 'APPROVED') {
    if (r.status === 'PCO_ISSUED') return { error: 'request_already_issued', message: `${r.request_no} already has a Purchase Consignment Order.` };
    return { error: 'request_not_approved', message: `${r.request_no} is ${r.status.toLowerCase().replace('_', ' ')} — only an approved request raises a Purchase Consignment Order.` };
  }
  if (!(r.item_code ?? '').trim()) {
    return { error: 'model_not_created', message: `${r.request_no} asks for a Model the catalogue does not have yet — build the Model and SKU from the request first.` };
  }
  return null;
}

/** The SKU code a new Model's first SKU takes: `<MODEL>-<compartment>` for a
    sofa with a compartment (product-models.ts: the compartment code is part of
    every sofa SKU code), else the model code itself. Upper-cased, no spaces. */
export function defaultSkuCode(modelCode: string, category: string, compartment: string | null): string {
  const model = modelCode.trim().toUpperCase().replace(/\s+/g, '-');
  const comp = (compartment ?? '').trim().toUpperCase().replace(/\s+/g, '-');
  return category === 'SOFA' && comp ? `${model}-${comp}` : model;
}

/** The variants bag a PC Order line carries for this request, in the keys the
    PcVariantEditor reads (fabricCode / seatHeight / legHeight). Empty keys are
    left out so a line with nothing picked carries no bag. */
export function requestVariants(r: { fabric_code: string | null; seat_size: string | null; leg_size: string | null }): Record<string, string> {
  const v: Record<string, string> = {};
  if ((r.fabric_code ?? '').trim()) v.fabricCode = r.fabric_code!.trim();
  if ((r.seat_size ?? '').trim()) v.seatHeight = r.seat_size!.trim();
  if ((r.leg_size ?? '').trim()) v.legHeight = r.leg_size!.trim();
  return v;
}
