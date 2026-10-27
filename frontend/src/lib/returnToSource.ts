/** Where a "New <document>" form goes after a save. A document raised from
 *  another document's page returns to that page (HC-0127, same rule as
 *  siAfterSave.ts); one keyed from scratch opens the new document. */
export function afterCreatePath(createdPath: string, sourcePath: string | null): string {
  return sourcePath ?? createdPath;
}

const detail = (base: string) => (id: string | null | undefined): string | null =>
  id ? `${base}/${encodeURIComponent(id)}` : null;

/** Detail-page route of each source document; null when the URL carried no id. */
export const sourceDocPath = {
  salesOrder: detail('/scm/sales-orders'), // keyed by doc no
  deliveryOrder: detail('/scm/delivery-orders'),
  purchaseOrder: detail('/scm/purchase-orders'),
  goodsReceipt: detail('/scm/grns'),
  consignmentOrder: detail('/scm/consignment-orders'), // keyed by doc no
  consignmentNote: detail('/scm/consignment-notes'),
  purchaseConsignmentOrder: detail('/scm/purchase-consignment-orders'),
  purchaseConsignmentReceive: detail('/scm/purchase-consignment-receives'),
};
