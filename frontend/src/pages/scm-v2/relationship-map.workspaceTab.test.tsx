import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { useSoRelationshipMap } from "./so-relationship-map";
import { useDoRelationshipMap } from "./sales-doc-relationship-map";
import { DocumentFlowModal } from "../../vendor/scm/components/DocumentFlowModal";
import { markWorkspaceDocumentIntent } from "../../lib/workspaceTabs";

/* Owner 2026-09-27 (screenshot of the in-app tab strip): a document clicked on
   a relationship map opens in its own tab of THAT strip — not a browser tab. */

const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));
vi.mock("../../lib/workspaceTabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspaceTabs")>()),
  markWorkspaceDocumentIntent: vi.fn(),
}));

const flow = {
  nodes: [
    { key: "so", type: "so", id: "HC-SO-001", label: "HC-SO-001", status: null, isAnchor: false },
    { key: "do", type: "do", id: "do-1", label: "DO-2609-001", status: "DELIVERED", isAnchor: false },
    { key: "si1", type: "si", id: "si-1", label: "SI-1", status: "PAID", isAnchor: false },
    { key: "si2", type: "si", id: "si-2", label: "SI-2", status: "PAID", isAnchor: false },
  ],
  edges: [],
  amendments: [{ id: "am-9", amendmentNo: 2, status: "REQUESTED" }],
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

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const marked = vi.mocked(markWorkspaceDocumentIntent);
const open = vi.fn();
beforeEach(() => {
  navigate.mockClear();
  marked.mockClear();
  open.mockClear();
  window.open = open as unknown as typeof window.open;
});

/** Marked as a document open, then navigated to `path` in this window. */
const openedInStripTab = (path: string) => {
  expect(marked).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith(path);
  expect(marked.mock.invocationCallOrder[0]!).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
  expect(open).not.toHaveBeenCalled();
};

describe("relationship maps open documents in the in-app tab strip", () => {
  it("SO map: a DO opens in its own strip tab, and the map closes", () => {
    const r = renderHook(() => useSoRelationshipMap({ doc_no: "HC-SO-001" }), { wrapper }).result;
    let closes = false;
    act(() => { closes = r.current.onNodeClick(r.current.nodes.find((n) => n.type === "Delivery Order")!); });
    openedInStripTab("/scm/delivery-orders/do-1");
    expect(closes).toBe(true);
  });

  it("SO map: two invoices go through the chooser, and the pick opens in its own tab", () => {
    const r = renderHook(() => useSoRelationshipMap({ doc_no: "HC-SO-001" }), { wrapper }).result;
    act(() => { r.current.onNodeClick(r.current.nodes.find((n) => n.type === "Sales Invoice")!); });
    expect(navigate).not.toHaveBeenCalled();
    act(() => { r.current.pickChoice(r.current.choice!.docs[1]!); });
    openedInStripTab("/scm/sales-invoices/si-2");
    expect(r.current.choice).toBeNull();
  });

  it("SO map: an amendment chip opens in its own tab", () => {
    const r = renderHook(() => useSoRelationshipMap({ doc_no: "HC-SO-001" }), { wrapper }).result;
    act(() => { r.current.onAmendmentClick(r.current.amendments[0]!); });
    openedInStripTab("/scm/amendments/am-9");
  });

  it("DO map: the Sales Order opens in its own tab", () => {
    const r = renderHook(() => useDoRelationshipMap({ id: "do-1", do_number: "DO-2609-001", so_doc_no: "HC-SO-001" }), { wrapper }).result;
    act(() => { r.current.onNodeClick(r.current.nodes.find((n) => n.type === "Sales Order")!); });
    openedInStripTab("/scm/sales-orders/HC-SO-001");
  });

  it("the older document-flow map does the same", () => {
    const onClose = vi.fn();
    render(<MemoryRouter><DocumentFlowModal type="po" id="po-1" open onClose={onClose} /></MemoryRouter>);
    fireEvent.click(screen.getByText("DO-2609-001"));
    // This map's own (legacy) DO route; the router's alias sends it to the detail page.
    openedInStripTab("/mfg-delivery-orders/do-1");
    expect(onClose).toHaveBeenCalled();
  });
});
