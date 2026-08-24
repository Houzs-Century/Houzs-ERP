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
vi.mock("../../vendor/scm/lib/admin-queries", () => ({
  useStaff: () => ({
    data: [
      { id: "s-3", name: "Sim", active: true },
      { id: "s-1", name: "alicia", active: false },
      { id: "s-2", name: "Bernard", active: true },
    ],
    isLoading: false,
  }),
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
  it("lists the full roster A→Z and marks who is no longer active", () => {
    render(<SalespersonHandover />);
    fireEvent.focus(screen.getByRole("textbox", { name: "Orders currently with" }));
    const rows = [...document.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual(["alicia (inactive)", "Bernard", "Sim"]);
  });

  it("shows the orders that would move before anything is written", async () => {
    authedFetch.mockResolvedValueOnce(preview(2));
    render(<SalespersonHandover />);
    pickFrom("alicia (inactive)");
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
    pickFrom("alicia (inactive)");
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
    pickFrom("alicia (inactive)");
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
