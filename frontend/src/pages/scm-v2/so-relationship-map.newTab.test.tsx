import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { useSoRelationshipMap } from "./so-relationship-map";
import { docTabUrl } from "../../lib/openDocInNewTab";

/* Owner 2026-09-27: on the Sales Order's relationship map, clicking a DO or any
   other linked document opens it in a NEW tab, on this tab's company, and the
   map stays open. */

const flow = {
  nodes: [
    { key: "so", type: "so", id: "SO-1", label: "HC-SO-001", status: null, isAnchor: true },
    { key: "do1", type: "do", id: "do-1", label: "DO-2609-001", status: "DELIVERED", isAnchor: false },
    { key: "si1", type: "si", id: "si-1", label: "SI-2609-001", status: "PAID", isAnchor: false },
    { key: "si2", type: "si", id: "si-2", label: "SI-2609-002", status: "PAID", isAnchor: false },
  ],
  edges: [],
  amendments: [{ id: "am-9", amendmentNo: 2, status: "REQUESTED" }],
};

vi.mock("../../vendor/scm/lib/flow-queries", () => ({
  useDocumentFlow: () => ({ data: flow, isLoading: false }),
  useCandidatePos: () => ({ data: undefined }),
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

const setup = () => renderHook(() => useSoRelationshipMap({ doc_no: "HC-SO-001" }), { wrapper }).result;
const node = (r: ReturnType<typeof setup>, type: string) => r.current.nodes.find((n) => n.type === type)!;

describe("SO relationship map opens linked documents in a new tab", () => {
  it("a single DO opens in a new tab on this tab's company, and the map stays open", () => {
    const r = setup();
    let closed = true;
    act(() => { closed = r.current.onNodeClick(node(r, "Delivery Order")); });
    expect(open).toHaveBeenCalledWith("/scm/delivery-orders/do-1?company=2", "_blank", "noopener,noreferrer");
    expect(closed).toBe(false);
  });

  it("several invoices: the chooser's pick opens in a new tab and the chooser closes", () => {
    const r = setup();
    act(() => { r.current.onNodeClick(node(r, "Sales Invoice")); });
    expect(open).not.toHaveBeenCalled();
    expect(r.current.choice?.docs).toHaveLength(2);
    act(() => { r.current.pickChoice(r.current.choice!.docs[1]!); });
    expect(open).toHaveBeenCalledWith("/scm/sales-invoices/si-2?company=2", "_blank", "noopener,noreferrer");
    expect(r.current.choice).toBeNull();
  });

  it("an amendment chip opens in a new tab too", () => {
    const r = setup();
    let closed = true;
    act(() => { closed = r.current.onAmendmentClick(r.current.amendments[0]!); });
    expect(open).toHaveBeenCalledWith("/scm/amendments/am-9?company=2", "_blank", "noopener,noreferrer");
    expect(closed).toBe(false);
  });
});

describe("docTabUrl", () => {
  it("adds the company to a path with or without a query, and nothing when unknown", () => {
    expect(docTabUrl("/scm/grns/1", 1)).toBe("/scm/grns/1?company=1");
    expect(docTabUrl("/scm/list?x=1", 2)).toBe("/scm/list?x=1&company=2");
    expect(docTabUrl("/scm/grns/1", null)).toBe("/scm/grns/1");
  });
});
