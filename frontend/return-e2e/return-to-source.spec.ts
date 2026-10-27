import { test, expect, type Page } from "@playwright/test";

/* HC-0127: a document raised from another document's page returns to that page
   after saving. The frontend is real; the API is stubbed per flow, so this
   proves the screen's own navigation, not the server. */

type Handler = (method: string, path: string, body: any) => unknown | undefined;

async function openWith(page: Page, url: string, handler: Handler) {
  await page.addInitScript(() => localStorage.setItem("auth:token", "t"));
  const posts: Array<{ path: string; body: any }> = [];
  await page.route((u) => new URL(u).pathname.startsWith("/api/"), async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    let body: any = null;
    try { body = req.postDataJSON(); } catch { /* no body */ }
    if (method !== "GET") posts.push({ path, body });
    if (path.endsWith("/auth/me")) {
      return route.fulfill({ json: { user: { id: 1, email: "t@t", name: "T", role_id: 1, role_name: "Super Admin", status: "active", permissions: ["*"], page_access: {} } } });
    }
    if (path === "/api/presence") return route.fulfill({ json: { active: [], away: [] } });
    if (path === "/api/notifications") return route.fulfill({ json: { feed: [], unread_by_project: {}, total_unread: 0 } });
    const mine = handler(method, path.replace(/^\/api\/scm/, ""), body);
    if (mine !== undefined) return route.fulfill({ json: mine as object });
    return route.fulfill({ json: method === "GET" ? [] : {} });
  });
  page.on("console", (m) => { if (m.text().includes("route-crash")) console.log(m.text().slice(0, 300)); });
  await page.goto(url);
  return posts;
}

test("Delivery Order -> Delivery Return lands back on the DO", async ({ page }) => {
  await openWith(page, "/scm/delivery-returns/new?fromDo=do-1", (m, p) => {
    if (p === "/delivery-orders-mfg/do-1") {
      return { deliveryOrder: { id: "do-1", do_number: "DO-1", debtor_name: "Acme", debtor_code: "C1" },
               items: [{ id: "i1", item_code: "SOFA", item_group: "sofa", qty: 2, uom: "UNIT", description: "Sofa" }] };
    }
    if (m === "POST" && p === "/delivery-returns") return { id: "dr-1", returnNumber: "DR-1" };
  });
  await page.getByRole("button", { name: /^(save|create)/i }).first().click();
  await expect(page).toHaveURL(/\/scm\/delivery-orders\/do-1$/);
});

const soSource = { source: { customerName: "Acme", debtorCode: "C1" }, missing: [] };
const soDetail = { salesOrder: { doc_no: "SO-1" }, items: [{ id: "s1", item_code: "SOFA", item_group: "sofa", qty: 2, uom: "UNIT", description: "Sofa", unit_price_sen: 10000 }] };
/** A notice dialog ("created + posted") must be dismissed by the operator before the page moves on. */
const dismissNotice = async (page: Page) => {
  const ok = page.getByRole("button", { name: /^ok$/i });
  await ok.waitFor({ timeout: 2_000 }).then(() => ok.click(), () => {});
};
const saveButton = (page: Page) => page.getByRole("button", { name: /^(save|create)/i }).first();

test("Sales Order -> Sales Invoice lands back on the SO", async ({ page }) => {
  await openWith(page, "/scm/sales-invoices/new?fromSo=SO-1", (m, p) => {
    if (p === "/delivery-orders-mfg/so-source/SO-1") return soSource;
    if (p === "/mfg-sales-orders/SO-1") return soDetail;
    if (m === "POST" && p === "/sales-invoices") return { id: "si-1", invoiceNumber: "SI-1" };
  });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/sales-orders\/SO-1$/);
});

test("Delivery Order -> Sales Invoice lands back on the DO (#4758 control)", async ({ page }) => {
  await openWith(page, "/scm/sales-invoices/new?fromDo=do-1", (m, p) => {
    if (p === "/delivery-orders-mfg/do-1") {
      return { deliveryOrder: { id: "do-1", do_number: "DO-1", debtor_name: "Acme", debtor_code: "C1" },
               items: [{ id: "i1", item_code: "SOFA", item_group: "sofa", qty: 2, uom: "UNIT", description: "Sofa" }] };
    }
    if (m === "POST" && p === "/sales-invoices") return { id: "si-1", invoiceNumber: "SI-1" };
  });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/delivery-orders\/do-1$/);
});

test("Sales Order -> Delivery Order lands back on the SO", async ({ page }) => {
  await openWith(page, "/scm/delivery-orders/new?fromSo=SO-1", (m, p) => {
    if (p === "/delivery-orders-mfg/so-source/SO-1") return soSource;
    if (p === "/delivery-orders-mfg/deliverable-so-lines") {
      return { lines: [{ soItemId: "s1", docNo: "SO-1", itemCode: "SOFA", itemGroup: "sofa", description: "Sofa", uom: "UNIT", qty: 2, remaining: 2, delivered: 0, returned: 0, unitPriceSen: 10000, unitCostSen: 5000, discountSen: 0, variants: {}, notReady: null }] };
    }
    if (m === "POST" && p.startsWith("/delivery-orders-mfg")) return { id: "do-9", doNumber: "DO-9" };
  });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/sales-orders\/SO-1$/);
});

const grn = { grn: { id: "g1", grn_number: "GRN-1", supplier_id: "sup1", purchase_order_id: "po1", supplier: { name: "Sup" }, status: "POSTED" },
  items: [{ id: "gi1", item_code: "SOFA", material_name: "Sofa", material_kind: "item", qty_accepted: 2, qty_rejected: 1, unit_price_sen: 5000, item_group: "sofa" }] };

test("GRN -> Purchase Return lands back on the GRN", async ({ page }) => {
  await openWith(page, "/scm/purchase-returns/new?grnId=g1", (m, p) => {
    if (p === "/grns/g1") return grn;
    if (m === "POST" && p === "/purchase-returns") return { id: "pr-1", returnNumber: "PR-1" };
    if (m === "PATCH") return {};
  });
  const reason = page.locator("select").filter({ hasText: /defect|damage|wrong|reason/i }).first();
  await reason.selectOption({ index: 1 });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/grns\/g1$/);
});

test("GRN -> Supplier Bill: the pop-up's main button goes back to the GRN", async ({ page }) => {
  await openWith(page, "/scm/purchase-invoices/new?grnId=g1", (m, p) => {
    if (p === "/grns/g1") return grn;
    if (m === "POST" && p === "/purchase-invoices") return { id: "pi-1", invoiceNumber: "PI-1" };
  });
  await saveButton(page).click();
  await page.getByRole("button", { name: "Back to GRN" }).click();
  await expect(page).toHaveURL(/\/scm\/grns\/g1$/);
});

test("Purchase Order -> GRN: the pop-up's main button goes back to the PO", async ({ page }) => {
  await openWith(page, "/scm/grns/new?poId=po1", (m, p) => {
    if (p === "/mfg-purchase-orders/po1") return { purchaseOrder: { id: "po1", po_number: "PO-1", supplier_id: "sup1", supplier: { name: "Sup" }, status: "CONFIRMED" },
      items: [{ id: "pi1", item_code: "SOFA", material_name: "Sofa", qty: 2, qty_received: 0, unit_price_sen: 5000, item_group: "sofa" }] };
    if (m === "POST" && p === "/grns") return { id: "g-9", grnNumber: "GRN-9" };
  });
  await saveButton(page).click();
  await page.getByRole("button", { name: "Back to PO" }).click();
  await expect(page).toHaveURL(/\/scm\/purchase-orders\/po1$/);
});

const coLines = [{ id: "c1", item_code: "SOFA", item_group: "sofa", qty: 2, uom: "UNIT", description: "Sofa", unit_price_sen: 10000 }];

test("Consignment Order -> Consignment Note lands back on the order", async ({ page }) => {
  await openWith(page, "/scm/consignment-notes/new?fromConsignmentOrder=CO-1", (m, p) => {
    if (p === "/consignment-orders/CO-1") return { salesOrder: { doc_no: "CO-1", debtor_name: "Acme", debtor_code: "C1" }, items: coLines };
    if (m === "POST" && p === "/consignment-notes") return { id: "cn-1", doNumber: "CN-1" };
  });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/consignment-orders\/CO-1$/);
});

test("Consignment Note -> Consignment Return lands back on the note", async ({ page }) => {
  await openWith(page, "/scm/consignment-returns/new?fromConsignmentNote=cn-1", (m, p) => {
    if (p === "/consignment-notes/cn-1") return { deliveryOrder: { id: "cn-1", do_number: "CN-1", debtor_name: "Acme", debtor_code: "C1" }, items: coLines };
    if (m === "POST" && p === "/consignment-returns") return { id: "cr-1", returnNumber: "CR-1" };
  });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/consignment-notes\/cn-1$/);
});

const pcOrder = { purchaseOrder: { id: "pco1", po_number: "PCO-1", supplier_id: "sup1", supplier: { name: "Sup" }, status: "CONFIRMED" },
  items: [{ id: "pi1", item_code: "SOFA", material_name: "Sofa", qty: 2, received_qty: 0, unit_price_sen: 5000, item_group: "sofa" }] };
const pcReceive = { grn: { id: "pcr1", grn_number: "PCR-1", supplier_id: "sup1", purchase_order_id: "pco1", supplier: { name: "Sup" }, status: "POSTED" },
  items: [{ id: "ri1", item_code: "SOFA", material_name: "Sofa", qty_accepted: 2, qty_rejected: 1, unit_price_sen: 5000, item_group: "sofa" }] };

test("PC Order -> PC Receive: the pop-up's main button goes back to the order", async ({ page }) => {
  await openWith(page, "/scm/purchase-consignment-receives/new?fromPcOrder=pco1", (m, p) => {
    if (p === "/purchase-consignment-orders/pco1") return pcOrder;
    if (m === "POST" && p === "/purchase-consignment-receives") return { id: "pcr-9", grnNumber: "PCR-9" };
  });
  await saveButton(page).click();
  await page.getByRole("button", { name: "Back to Order" }).click();
  await expect(page).toHaveURL(/\/scm\/purchase-consignment-orders\/pco1$/);
});

test("PC Receive -> PC Return lands back on the receive", async ({ page }) => {
  await openWith(page, "/scm/purchase-consignment-returns/new?fromPcReceive=pcr1", (m, p) => {
    if (p === "/purchase-consignment-receives/pcr1") return pcReceive;
    if (m === "POST" && p === "/purchase-consignment-returns") return { id: "pcret-1", returnNumber: "PCRET-1" };
    if (m === "PATCH") return {};
  });
  await saveButton(page).click();
  await dismissNotice(page);
  await expect(page).toHaveURL(/\/scm\/purchase-consignment-receives\/pcr1$/);
});

test("Payment Request -> Payment Voucher: the pop-up's main button goes back to the request", async ({ page }) => {
  await openWith(page, "/scm/payment-vouchers/new?fromRequest=r1", (m, p) => {
    if (p === "/payment-requests/r1") {
      return { finance: true, request: { id: "r1", request_no: "PRQ-1", payee_name: "Vendor", purpose: "Fair booth", amount_sen: 50000, project_id: null, bill_no: null, bill_date: null, note: null } };
    }
    if (p === "/accounting/accounts") {
      const base = { parent_code: null, is_active: true, acc_money: false };
      return { accounts: [{ ...base, account_code: "100-0000", account_name: "Bank", account_type: "ASSET", acc_money: true },
                          { ...base, account_code: "600-0000", account_name: "Booth expense", account_type: "EXPENSE" }] };
    }
    if (p === "/accounting/roles") return { roles: { AP: "400-0000", AP_OTHER: "405-0000", BANK_DEFAULT: "100-0000" }, overridden: {} };
    if (m === "POST" && p === "/payment-vouchers") return { id: "pv-1", pvNumber: "PV-1" };
  });
  await page.getByPlaceholder(/Expense/).first().click();
  await page.getByText("600-0000 · Booth expense").first().click();
  await saveButton(page).click();
  await page.getByRole("button", { name: "Back to Request" }).click();
  await expect(page).toHaveURL(/\/scm\/payment-requests\?open=r1$/);
});
