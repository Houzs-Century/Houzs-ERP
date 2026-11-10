/* The phone's purchase invoice header lists every PO its lines bill (owner
   2026-11-10), not only the header's stored first PO. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ detail: {} as Record<string, unknown> }));

vi.mock("../vendor/scm/lib/authed-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/authed-fetch")>()),
  authedFetch: vi.fn(async (path: string) => (path.startsWith("/purchase-invoices/") ? h.detail : {})),
}));
vi.mock("../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vendor/scm/lib/flow-queries")>()),
  usePoSoCoverage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-1", role: "admin", permissions: ["*"] }, can: () => true, pageAccess: () => "edit" }),
}));
vi.mock("../hooks/useStaffLookup", () => ({ useStaffLookup: () => ({ nameOf: () => "" }) }));
vi.mock("../vendor/scm/components/FlowDocFilesCard", () => ({ FlowDocFilesCard: () => null }));
vi.mock("../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../vendor/scm/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../vendor/scm/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("./MobileRelationshipMap", () => ({ MobileRelationshipMap: () => null }));

import { MobileModuleDetail } from "./MobileModuleDetail";

const line = (id: string, po: string | null) => ({
  id, item_code: `IT-${id}`, material_name: "Foam", qty: 1, unit_price_sen: 0, line_total_sen: 0, source_po_number: po,
});

afterEach(() => cleanup());

describe("mobile PI detail: every PO the lines bill", () => {
  it("lines from two POs show both in the header", async () => {
    h.detail = {
      purchaseInvoice: {
        id: "pi-1", invoice_number: "HC-PI-2611-001", status: "POSTED", invoice_date: "2026-11-10",
        supplier: { code: "S-1", name: "Supplier Sdn Bhd" }, purchase_order: { po_number: "HC-PO-2610-125" },
        total_sen: 0, paid_sen: 0,
      },
      items: [line("a", "HC-PO-2610-202"), line("b", "HC-PO-2610-125")],
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <MobileModuleDetail moduleKey="purchase-invoices" row={{ id: "pi-1" }} title="Purchase Invoice" onBack={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("HC-PO-2610-125, HC-PO-2610-202")).toBeTruthy();
    expect(screen.getByText("POs (2)")).toBeTruthy();
  });
});
