/**
 * Shared layout identities for document line tables.
 *
 * A layout belongs to a document family, not an individual document. Using
 * these fixed values prevents eight localStorage entries from being created
 * for every order/invoice/return a user opens.
 */
export const DATA_TABLE_LAYOUT_FAMILIES = {
  deliveryOrderLines: "delivery-order-lines",
  deliveryReturnLines: "delivery-return-lines",
  goodsReceivedLines: "goods-received-lines",
  purchaseInvoiceLines: "purchase-invoice-lines",
  purchaseOrderLines: "purchase-order-lines",
  purchaseReturnLines: "purchase-return-lines",
  salesInvoiceLines: "sales-invoice-lines",
  salesOrderLines: "sales-order-lines",
} as const;
