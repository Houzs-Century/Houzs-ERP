// A handover rewrites who owns live Sales Orders, so the two things this test
// pins are the two that would hurt: the operator must SEE the orders before
// committing, and the run must be chunked to the batch cap the API enforces (a
// single 60-order POST is a 400, and a UI that sends it looks like a failure
// with no orders moved).
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn();
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  API_URL: "",
}));
/* The From picker lists ORDER HOLDERS, not the staff roster — the roster is
   scoped by a person's company link and hid the resigned reps the panel exists
   for. `alicia` is the resigned holder: inactive, and NOT in the pickable
   roster below, so a test that passes with her selectable is proving the fix. */
vi.mock("../../vendor/scm/lib/sales-order-queries", () => ({
  useSoHandoverHolders: () => ({
    data: [
      { staffId: "s-1", name: "alicia", staffCode: "ACIMP-ALI", active: false, orders: 30 },
      { staffId: "s-3", name: "Sim", staffCode: "EMP-3", active: true, orders: 2 },
    ],
    isLoading: false,
  }),
}));
vi.mock("../../vendor/scm/lib/admin-queries", () => ({
  usePickableStaff: () => ({
    data: [
      { id: "s-2", name: "Bernard", active: true },
      { id: "s-3", name: "Sim", active: true },
    ],
    isLoading: false,
  }),
}));

import { SalespersonHandover } from "./SalespersonHandover";

const preview = (count: number) => ({
  from: "s-1",
  total: count,
  truncated: false,
  batchMax: 25,
  orders: Array.from({ length: count }, (_, i) => ({
    docNo: `HC-SO-${i + 1}`,
    soDate: "2026-08-01",
    customer: "ACME",
    status: "DELIVERED",
  })),
});

beforeEach(() => authedFetch.mockReset());
afterEach(cleanup);

/* SearchableSelect is an input + a portalled <li> menu, so a pick is
   focus → (optionally type) → mousedown the row, not a <select> change. */
function pick(label: string, optionText: string | RegExp) {
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.focus(input);
  fireEvent.mouseDown(screen.getByText(optionText));
}
const pickFrom = (optionText: string | RegExp) =>
  pick("Orders currently with", optionText);

describe("SalespersonHandover", () => {
  /* The list is ORDER HOLDERS, biggest book first, with the count in the label
     — not the staff roster A→Z. `alicia` is inactive AND absent from the
     pickable roster, so her being here at all is the regression this pins:
     under the old source she was unselectable and her 30 orders unreachable. */
  it("lists who holds orders, most first, with the count", () => {
    render(<SalespersonHandover />);
    fireEvent.focus(screen.getByRole("textbox", { name: "Orders currently with" }));
    const rows = [...document.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual(["alicia (inactive) — 30", "Sim — 2"]);
  });

  it("shows the orders that would move before anything is written", async () => {
    authedFetch.mockResolvedValueOnce(preview(2));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive) — 30");
    await waitFor(() => expect(screen.getByText("HC-SO-1")).toBeTruthy());
    expect(screen.getByText("2")).toBeTruthy();          // the count
    expect(screen.getByText("HC-SO-2")).toBeTruthy();
    // Nothing written yet — the preview is a GET.
    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect(authedFetch.mock.calls[0][1]).toBeUndefined();
  });

  it("chunks the apply into batches of the API's cap", async () => {
    authedFetch.mockResolvedValueOnce(preview(30));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive) — 30");
    await waitFor(() => expect(screen.getByText("HC-SO-1")).toBeTruthy());

    pick("Hand them to", "Bernard");
    // The component re-previews after a run, so route by path rather than by
    // call order.
    authedFetch.mockImplementation((path: string) =>
      Promise.resolve(path === "/so-handover/apply" ? { moved: [], skipped: [] } : preview(0)),
    );
    fireEvent.click(screen.getByRole("button", { name: /Move to Bernard/ }));

    await waitFor(() => {
      const posts = authedFetch.mock.calls.filter((c) => c[0] === "/so-handover/apply");
      expect(posts).toHaveLength(2);
      expect(JSON.parse(posts[0][1].body).docNos).toHaveLength(25);
      expect(JSON.parse(posts[1][1].body).docNos).toHaveLength(5);
      expect(JSON.parse(posts[0][1].body)).toMatchObject({
        fromStaffId: "s-1",
        toStaffId: "s-2",
      });
    });
  });

  it("reports what was skipped instead of claiming a clean run", async () => {
    authedFetch.mockResolvedValueOnce(preview(1));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive) — 30");
    await waitFor(() => expect(screen.getByText("HC-SO-1")).toBeTruthy());

    pick("Hand them to", "Bernard");
    authedFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/so-handover/apply"
          ? {
              moved: [],
              skipped: [{ docNo: "HC-SO-1", reason: "No longer attributed to that salesperson." }],
            }
          : preview(1),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Move to Bernard/ }));

    await waitFor(() =>
      expect(screen.getByText(/Moved 0 orders · skipped 1/)).toBeTruthy(),
    );
    expect(screen.getByText(/No longer attributed/)).toBeTruthy();
  });
});

/* SHARING is the second operation on this panel (owner 2026-09-09, 全部平等，
   不设主). It writes a different column to a different endpoint and must NOT be
   able to move anybody's orders — which is the thing worth pinning, because both
   buttons sit in the same header over the same list. */
describe("SalespersonHandover — sharing", () => {
  const share = (optionText: string | RegExp) => pick("Also give access to", optionText);

  it("collects several people and posts them to /share, moving nothing", async () => {
    authedFetch.mockResolvedValueOnce(preview(2));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive) — 30");
    await waitFor(() => expect(screen.getByText("HC-SO-1")).toBeTruthy());

    share("Bernard");
    share("Sim");

    authedFetch.mockImplementation(() => Promise.resolve({ changed: [], skipped: [] }));
    fireEvent.click(screen.getByRole("button", { name: /Share with 2/ }));

    await waitFor(() => {
      const posts = authedFetch.mock.calls.filter((c) => c[0] === "/so-handover/share");
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0][1].body)).toMatchObject({
        staffIds: ["s-2", "s-3"],
        mode: "add",
      });
    });
    /* The whole point of the owner's ruling: sharing never touches attribution. */
    expect(authedFetch.mock.calls.filter((c) => c[0] === "/so-handover/apply")).toHaveLength(0);
  });

  it("sends mode=remove for a withdrawal, on the same list", async () => {
    authedFetch.mockResolvedValueOnce(preview(1));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive) — 30");
    await waitFor(() => expect(screen.getByText("HC-SO-1")).toBeTruthy());

    share("Bernard");
    authedFetch.mockImplementation(() => Promise.resolve({ changed: [{ docNo: "HC-SO-1" }], skipped: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    await waitFor(() =>
      expect(screen.getByText(/Withdrew access on 1 order/)).toBeTruthy(),
    );
    const posts = authedFetch.mock.calls.filter((c) => c[0] === "/so-handover/share");
    expect(JSON.parse(posts[0][1].body).mode).toBe("remove");
  });

  it("keeps the two actions independent — no share picked, no Share button", async () => {
    authedFetch.mockResolvedValueOnce(preview(1));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive) — 30");
    await waitFor(() => expect(screen.getByText("HC-SO-1")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Share with/ })).toBeNull();
    /* And the handover button is still gated by ITS own field, not by the
       sharing one. */
    expect(screen.getByRole("button", { name: /Move to/ }).hasAttribute("disabled")).toBe(true);
  });
});
