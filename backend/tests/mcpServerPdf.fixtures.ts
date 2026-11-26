// Fixtures for the server PDF test (mcpServerPdf.test.ts): a Sales Order and a
// Purchase Order shaped like GET /mfg-sales-orders/:docNo and
// GET /mfg-purchase-orders/:id, with Chinese in the fields that carry it in real
// life (customer name, address, note, supplier). Invented data — no real party.

/* A real 16x12 JPEG (made with Pillow) — an image the PDF can embed and a viewer can draw. */
export const TINY_JPEG = Uint8Array.from(
  atob(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAMABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCSiiivBPbP/9k=",
  ),
  (ch) => ch.charCodeAt(0),
);

export const BRANDING = {
  branding: {
    companyName: "Example Living Sdn Bhd",
    registrationNo: "202001234567 (1234567-X)",
    address: "No. 8, Jalan Contoh 3, Taman Contoh, Seri Kembangan, Selangor.",
    postcode: "43300",
    phone: "03-1234 5678",
    email: "hello@example.com",
    website: "",
    logoR2Key: "",
    printLogoR2Key: "",
  },
  companyCode: "TESTCO",
};

const GROUPS = ["SOFA", "MATTRESS", "BEDFRAME", "ACCESSORY", "SERVICE"];
const soItems = Array.from({ length: 40 }, (_, i) => ({
  id: `item-${i + 1}`,
  item_group: GROUPS[i % GROUPS.length],
  item_code: `MDL-${String(i + 1).padStart(3, "0")}`,
  description: i === 0 ? "Sofa 3-seater 布艺沙发" : `Model line ${i + 1}`,
  description2: i % 7 === 0 ? "Customer remark: deliver after 6pm" : null,
  uom: "UNIT",
  qty: (i % 3) + 1,
  unit_price_sen: 120000 + i * 1500,
  discount_sen: i % 4 === 0 ? 5000 : 0,
  total_sen: ((i % 3) + 1) * (120000 + i * 1500) - (i % 4 === 0 ? 5000 : 0),
  variants: i % 5 === 0 ? { fabricCode: "EZ-001", seatHeight: "18" } : null,
  remark: null,
  cancelled: i === 39,
  photo_urls: i === 1 ? ["so-items/HC-SO-099001/item-2/ac-1.jpg"] : null,
}));
const liveTotal = soItems.filter((l) => !l.cancelled).reduce((s, l) => s + l.total_sen, 0);

export const SO = {
  salesOrder: {
    doc_no: "HC-SO-099001",
    so_date: "2026-11-20",
    status: "CONFIRMED",
    debtor_code: "C-0001",
    debtor_name: "陈大文 Tan Dai Wen",
    agent: "Alice",
    branding: null,
    venue: "Showroom",
    ref: null,
    po_doc_no: null,
    phone: "012-345 6789",
    address1: "12, Jalan Bunga Raya 5",
    address2: "Taman Bunga（二期）",
    address3: "Puchong",
    address4: "47100",
    customer_state: "Selangor",
    local_total_sen: liveTotal,
    line_count: 39,
    currency: "MYR",
    note: "请在星期六送货",
    processing_date: "2026-11-22",
    customer_delivery_date: null,
    paid_sen_total: 300000,
    paid_outside_ledger_sen: 0,
  },
  items: soItems,
  pwpCodes: [],
};
export const PAYMENTS = {
  payments: [
    { paid_at: "2026-11-20", method: "transfer", online_type: "DuitNow", merchant_provider: null, installment_months: null, approval_code: null, amount_sen: 200000, account_sheet: null, collected_by_name: "Alice", note: null },
    { paid_at: "2026-11-21", method: "cash", merchant_provider: null, installment_months: null, approval_code: null, amount_sen: 100000, account_sheet: null, collected_by_name: "Alice", note: null },
  ],
};
export const FABRICS = { fabrics: [{ fabric_code: "EZ-001", supplier_code: "KN390-1", fabric_description: "Easy Clean Velvet" }] };

export const PO_ID = "6f1c2a3e-0000-4000-8000-000000000001";
export const PO = {
  purchaseOrder: {
    id: PO_ID,
    po_number: "HC-PO-2611-001",
    revision: 2,
    supplier_id: "sup-1",
    status: "SUBMITTED",
    po_date: "2026-11-20",
    expected_at: "2026-12-20",
    currency: "MYR",
    subtotal_sen: 0,
    tax_sen: 0,
    total_sen: 0,
    notes: "包装要加固",
    purchase_location_id: "wh-1",
    supplier: { code: "S-CN01", name: "佛山市家具有限公司", phone: "+86 757 1234 5678", address: "广东省佛山市顺德区" },
  },
  items: Array.from({ length: 12 }, (_, i) => ({
    id: `po-item-${i + 1}`,
    line_no: i + 1,
    item_code: `MDL-${String(i + 1).padStart(3, "0")}`,
    material_name: `Model line ${i + 1}`,
    supplier_sku: i % 2 === 0 ? `SUP-${i + 1}` : null,
    qty: 2,
    unit_price_sen: 50000 + i * 1000,
    line_total_sen: 2 * (50000 + i * 1000),
    uom: "UNIT",
    item_group: "BEDFRAME",
    variants: i === 0 ? { fabricCode: "EZ-001" } : null,
    so_doc_no: "HC-SO-099001",
    photo_urls: null,
  })),
};
PO.purchaseOrder.subtotal_sen = PO.items.reduce((s, l) => s + l.line_total_sen, 0);
PO.purchaseOrder.total_sen = PO.purchaseOrder.subtotal_sen;
