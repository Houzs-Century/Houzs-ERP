// Product request (owner 2026-10-06: to request new product / repack product)
// — the pure rules. No DB, no I/O; the route (routes/product-requests.ts)
// and the Purchase Consignment Order's create door import them, and so can a
// client.
//
// A salesperson asks for products — each line an existing SKU, or a Model the
// catalogue does not have yet — in a fabric, seat size and leg size, for a
// use, delivered where and by when (owner 2026-10-15, 方案 A: a request is a
// header plus lines, the shape a PC Order has, so dozens of showroom pieces go
// in one request). The Purchaser answers the WHOLE request: approve or reject;
// for each new-Model line, build the Model + SKU from it; then raise ONE
// Purchase Consignment Order carrying every line — or ONE Purchase Order, when
// the goods are bought outright (2990-0015).

export const PRODUCT_REQUEST_TYPES = ['NEW_PRODUCT', 'REPACK'] as const;
export type ProductRequestType = (typeof PRODUCT_REQUEST_TYPES)[number];

export const PRODUCT_REQUEST_APPLICATIONS = ['SHOWROOM', 'CUSTOMER_ORDER', 'SAMPLE', 'FAIR_EXHIBITION'] as const;
export type ProductRequestApplication = (typeof PRODUCT_REQUEST_APPLICATIONS)[number];

export const PRODUCT_REQUEST_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PCO_ISSUED', 'PO_ISSUED', 'CLOSED'] as const;
export type ProductRequestStatus = (typeof PRODUCT_REQUEST_STATUSES)[number];

export type ProductRequestAction = 'approve' | 'reject' | 'withdraw' | 'resubmit' | 'issue_pco' | 'issue_po' | 'release_po' | 'close';

const FLOW: Record<ProductRequestAction, { from: ProductRequestStatus[]; to: ProductRequestStatus }> = {
  // The Purchaser's yes. Model/SKU builds and a PC Order may follow.
  approve:   { from: ['REQUESTED'], to: 'APPROVED' },
  // The Purchaser's no, with the why — the requester may fix it and resubmit.
  reject:    { from: ['REQUESTED'], to: 'REJECTED' },
  // The requester pulls it back, before or after a rejection.
  withdraw:  { from: ['REQUESTED', 'REJECTED'], to: 'WITHDRAWN' },
  // A rejected request, corrected and sent again.
  resubmit:  { from: ['REJECTED'], to: 'REQUESTED' },
  // A Purchase Consignment Order was raised from it.
  issue_pco: { from: ['APPROVED'], to: 'PCO_ISSUED' },
  // A Purchase Order was raised from it instead.
  issue_po:  { from: ['APPROVED'], to: 'PO_ISSUED' },
  // Its PO was cancelled (2990-0027): it is approved again and may raise another.
  release_po: { from: ['PO_ISSUED'], to: 'APPROVED' },
  // Nothing more to do: the goods came in, or the Purchaser ends it.
  close:     { from: ['APPROVED', 'PCO_ISSUED', 'PO_ISSUED'], to: 'CLOSED' },
};

export const canTransition = (s: ProductRequestStatus, a: ProductRequestAction): boolean => FLOW[a].from.includes(s);
export const nextStatus = (s: ProductRequestStatus, a: ProductRequestAction): ProductRequestStatus | null =>
  canTransition(s, a) ? FLOW[a].to : null;

/** The requester may still change the request (edit, withdraw) while nobody
    has acted on it, or after the Purchaser sent it back. */
export const requesterMayChange = (s: ProductRequestStatus): boolean => s === 'REQUESTED' || s === 'REJECTED';

/** Open for the Purchaser: waiting for a decision. */
export const awaitsPurchaser = (s: ProductRequestStatus): boolean => s === 'REQUESTED';

/** A request carries at most this many lines — a showroom's worth, not a catalogue. */
export const PRODUCT_REQUEST_MAX_LINES = 200;

export type ProductRequestProduct = {
  item_code: string | null;
  proposed_model_name: string | null;
};

/** Why one line's product is not acceptable, or null when it is.
    A REPACK re-packs something the catalogue has, so every line names an
    existing SKU. A NEW_PRODUCT line names an existing SKU (a variant the
    catalogue can already make) or the Model the requester wants, by name. */
export function productRefusal(requestType: string, p: ProductRequestProduct, lineNo: number): { error: string; message: string } | null {
  const code = (p.item_code ?? '').trim();
  const proposed = (p.proposed_model_name ?? '').trim();
  if (requestType === 'REPACK') {
    if (!code) return { error: 'item_code_required', message: `Line ${lineNo}: a repack names the SKU being re-packed — pick it from the catalogue.` };
    return null;
  }
  if (!code && !proposed) return { error: 'product_required', message: `Line ${lineNo}: pick an existing SKU, or give the new Model a name.` };
  return null;
}

/** Why the request's lines, as a set, are not acceptable: none at all, or too
    many. Each line's own product check is `productRefusal`. */
export function linesRefusal(count: number): { error: string; message: string } | null {
  if (count < 1) return { error: 'lines_required', message: 'Add at least one product line.' };
  if (count > PRODUCT_REQUEST_MAX_LINES) return { error: 'too_many_lines', message: `A request carries at most ${PRODUCT_REQUEST_MAX_LINES} lines — split it.` };
  return null;
}

const ORDER_WORD = { PCO: 'Purchase Consignment Order', PO: 'Purchase Order' } as const;

/** Why an order (a Purchase Consignment Order, or a Purchase Order) may not be
    raised from this request, or null when it may: the Purchaser must have
    approved it, and every line's product must exist in the catalogue (a new
    Model is built first, from its line). A request carries one order, of
    either kind. */
export function orderFromRequestRefusal(r: { status: string; request_no: string; lines: ReadonlyArray<{ item_code: string | null }> }, order: 'PCO' | 'PO'): { error: string; message: string } | null {
  if (r.status !== 'APPROVED') {
    if (r.status === 'PCO_ISSUED') return { error: 'request_already_issued', message: `${r.request_no} already has a Purchase Consignment Order.` };
    if (r.status === 'PO_ISSUED') return { error: 'request_already_issued', message: `${r.request_no} already has a Purchase Order.` };
    return { error: 'request_not_approved', message: `${r.request_no} is ${r.status.toLowerCase().replace('_', ' ')} — only an approved request raises a ${ORDER_WORD[order]}.` };
  }
  if (r.lines.length === 0) return { error: 'lines_required', message: `${r.request_no} has no product line to order.` };
  const pending = r.lines.filter((l) => !(l.item_code ?? '').trim()).length;
  if (pending > 0) {
    return { error: 'model_not_created', message: `${r.request_no} asks for ${pending === 1 ? 'a Model' : `${pending} Models`} the catalogue does not have yet — build the Model and SKU from each of those lines first.` };
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

/** The variants bag a PC Order line carries for a request line, in the keys
    the PcVariantEditor reads (fabricCode / seatHeight / legHeight). Empty keys
    are left out so a line with nothing picked carries no bag. */
export function requestVariants(r: { fabric_code: string | null; seat_size: string | null; leg_size: string | null }): Record<string, string> {
  const v: Record<string, string> = {};
  if ((r.fabric_code ?? '').trim()) v.fabricCode = r.fabric_code!.trim();
  if ((r.seat_size ?? '').trim()) v.seatHeight = r.seat_size!.trim();
  if ((r.leg_size ?? '').trim()) v.legHeight = r.leg_size!.trim();
  return v;
}
