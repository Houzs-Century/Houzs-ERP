import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { useDoRelationshipMap } from "./sales-doc-relationship-map";
import { usePoRelationshipMap } from "./po-relationship-map";
import { DocumentFlowModal } from "../../vendor/scm/components/DocumentFlowModal";

/* Owner 2026-09-27: every document page's relationship map (not only the Sales
   Order's) opens a linked document in a new tab, on this tab's company. */

const flow = {
  nodes: [
    { key: "so", type: "so", id: "HC-SO-001", label: "HC-SO-001", status: null, isAnchor: false },
    { key: "do", type: "do", id: "do-1", label: "DO-2609-001", status: "DELIVERED", isAnchor: false },
    { key: "po", type: "po", id: "po-1", label: "PO-2609-001", status: "RECEIVED", isAnchor: false },
    { key: "si1", type: "si", id: "si-1", label: "SI-1", status: "PAID", isAnchor: false },
    { key: "si2", type: "si", id: "si-2", label: "SI-2", status: "PAID", isAnchor: false },
  ],
  edges: [],
  amendments: [],
  poAmendments: [],
};

vi.mock("../../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/flow-queries")>()),
  useDocumentFlow: () => ({ data: flow, isLoading: false, isError: false }),
  useCandidatePos: () => ({ data: undefined }),
  usePoSoCoverage: () => ({ data: undefined }),
}));
vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({ can: () => true, pageAccess: () => "full" }),
}));
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../lib/activeCompany", () => ({ getActiveCompanyId: () => 2 }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const open = vi.fn();
beforeEach(() => {
  open.mockClear();
  window.open = open as unknown as typeof window.open;
});

describe("the other documents' maps open in a new tab", () => {
  it("Delivery Order map: the Sales Order opens in a new tab and the map stays open", () => {
    const r = renderHook(() => useDoRelationshipMap({ id: "do-1", do_number: "DO-2609-001", so_doc_no: "HC-SO-001" }), { wrapper }).result;
    let closed = true;
    act(() => { closed = r.current.onNodeClick(r.current.nodes.find((n) => n.type === "Sales Order")!); });
    expect(open).toHaveBeenCalledWith("/scm/sales-orders/HC-SO-001?company=2", "_blank", "noopener,noreferrer");
    expect(closed).toBe(false);
  });

  it("Delivery Order map: several invoices, the picked one opens in a new tab", () => {
    const r = renderHook(() => useDoRelationshipMap({ id: "do-1", do_number: "DO-2609-001", so_doc_no: "HC-SO-001" }), { wrapper }).result;
    act(() => { r.current.onNodeClick(r.current.nodes.find((n) => n.type === "Sales Invoice")!); });
    act(() => { r.current.pickChoice(r.current.choice!.docs[0]!); });
    expect(open).toHaveBeenCalledWith("/scm/sales-invoices/si-1?company=2", "_blank", "noopener,noreferrer");
    expect(r.current.choice).toBeNull();
  });

  it("Purchase Order map: a linked Sales Order opens in a new tab", () => {
    const r = renderHook(() => usePoRelationshipMap({ id: "po-1", po_number: "PO-2609-001" }), { wrapper }).result;
    let closed = true;
    act(() => { closed = r.current.onNodeClick(r.current.nodes.find((n) => n.type === "Sales Order")!); });
    expect(open).toHaveBeenCalledWith("/scm/sales-orders/HC-SO-001?company=2", "_blank", "noopener,noreferrer");
    expect(closed).toBe(false);
  });

  it("the legacy document-flow map (older document pages) opens a node in a new tab and stays open", () => {
    const onClose = vi.fn();
    render(<MemoryRouter><DocumentFlowModal type="po" id="po-1" open onClose={onClose} /></MemoryRouter>);
    fireEvent.click(screen.getByText("DO-2609-001"));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/do-1.*\?company=2$/), "_blank", "noopener,noreferrer");
    expect(onClose).not.toHaveBeenCalled();
  });
});
