import {
  NotifyProvider,
  PoAmendmentCreateModal,
  QueryClient,
  QueryClientProvider,
} from "autocount-sync-frontend";

// PO amendment composer — loads the PO's lines via usePurchaseOrderDetail
// (TanStack query inside the component), lets the buyer edit qty / unit
// price / delivery per line or remove lines, then submits the delta set.
// CONNECTED: the detail endpoint is stubbed below (AnnouncementBanner stub
// pattern); unmatched /api/* returns a LOCAL 404 so nothing reaches the real
// workers.dev API with the fake token (a genuine 401 there would fire the
// global logout and blank the card mid-render).

try {
  localStorage.setItem("auth:token", "ds-preview-token");
} catch {
  /* private mode */
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const PO_DETAIL = {
  purchaseOrder: {
    id: "po-9012",
    po_number: "PO-2990-0101",
    supplier_name: "Sunrise Timber Sdn Bhd",
    status: "open",
    expected_at: "2026-08-15",
    notes: "Deliver to Kepong warehouse — call ahead.",
    total_centi: 1834000,
  },
  items: [
    {
      id: "l1",
      material_code: "WD-TEAK-25",
      material_name: "Teak board 25mm (per m²)",
      qty: 40,
      unit_price_centi: 18500,
      delivery_date: "2026-08-15",
    },
    {
      id: "l2",
      material_code: "FB-LINEN-SAND",
      material_name: "Linen upholstery — Sand (per metre)",
      qty: 120,
      unit_price_centi: 4200,
      delivery_date: "2026-08-10",
    },
    {
      id: "l3",
      material_code: "HW-HINGE-SOFT",
      material_name: "Soft-close hinge set",
      qty: 200,
      unit_price_centi: 950,
      delivery_date: null,
    },
  ],
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/mfg-purchase-orders/")) return json(PO_DETAIL);
  // Never let unstubbed API traffic reach the real backend (see header note).
  if (url.includes("/api/") || url.includes("workers.dev"))
    return new Response(JSON.stringify({ error: "not stubbed in preview" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  return realFetch(input as RequestInfo, init);
};

// Fresh client per preview load — retries off so a stub miss fails fast
// instead of spinning the card through retry backoff.
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export const AmendLines = () => (
  <QueryClientProvider client={client}>
    <NotifyProvider>
      <PoAmendmentCreateModal poId="po-9012" poNumber="PO-2990-0101" onClose={() => {}} />
    </NotifyProvider>
  </QueryClientProvider>
);
