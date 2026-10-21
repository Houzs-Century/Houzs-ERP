import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { useSoRelationshipMap } from "./so-relationship-map";
import { DocumentRelationshipMapModal } from "../../components/scm-v2/DocumentRelationshipMapModal";

/* 2990-0011 (Sim, 2026-10-20): 2990-SO-2606-001 came back on
   2990-DR-2610-001, but the SO's Relationship Map never showed the return. */

const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

const flow = {
  nodes: [
    { key: "so", type: "so", id: "2990-SO-2606-001", label: "2990-SO-2606-001", status: null, isAnchor: true },
    { key: "do", type: "do", id: "do-1", label: "2990-DO-2607-012", status: "DELIVERED", isAnchor: false },
    { key: "dr", type: "dr", id: "dr-1", label: "2990-DR-2610-001", status: "RECEIVED", isAnchor: false },
  ],
  edges: [],
  amendments: [],
  poAmendments: [],
};
vi.mock("../../vendor/scm/lib/flow-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/flow-queries")>()),
  useDocumentFlow: () => ({ data: flow, isLoading: false, isError: false }),
  useCandidatePos: () => ({ data: undefined }),
}));
const auth = { user: null as unknown, can: () => true, pageAccess: () => "full" };
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => auth }));
const notify = vi.fn();
vi.mock("../../vendor/scm/components/NotifyDialog", () => ({ useNotify: () => notify }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
beforeEach(() => {
  navigate.mockClear();
  notify.mockClear();
  auth.user = null;
});

describe("SO relationship map shows Delivery Returns", () => {
  it("lists the return and opens it", () => {
    const r = renderHook(() => useSoRelationshipMap({ doc_no: "2990-SO-2606-001" }), { wrapper }).result;
    expect(r.current.returns).toEqual([{ id: "dr-1", label: "2990-DR-2610-001", status: "RECEIVED" }]);
    let closes = false;
    act(() => { closes = r.current.onReturnClick(r.current.returns[0]!); });
    expect(navigate).toHaveBeenCalledWith("/scm/delivery-returns/dr-1");
    expect(closes).toBe(true);
  });

  it("tells Sales staff why the return will not open instead of routing them to Forbidden", () => {
    auth.user = { capabilities: { "org.sales.staff": true } };
    const r = renderHook(() => useSoRelationshipMap({ doc_no: "2990-SO-2606-001" }), { wrapper }).result;
    let closes = true;
    act(() => { closes = r.current.onReturnClick(r.current.returns[0]!); });
    expect(navigate).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(closes).toBe(false);
  });

  it("renders the return as a chip on the map", () => {
    render(
      <DocumentRelationshipMapModal
        open
        onClose={() => {}}
        nodes={[]}
        returns={[{ id: "dr-1", label: "2990-DR-2610-001", status: "RECEIVED" }]}
        onReturnClick={() => {}}
      />,
    );
    expect(screen.getByText("Returned off the Delivery Order")).toBeTruthy();
    expect(screen.getByText("2990-DR-2610-001")).toBeTruthy();
    expect(screen.getByText("Received")).toBeTruthy();
  });
});
