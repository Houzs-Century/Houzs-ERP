// The in-visit funnel memory the DataTable default now uses (owner 2026-09-16):
// a funnel survives a client-side remount but a fresh page load opens clean, and
// it never touches localStorage. Reset simulates the fresh bundle evaluation.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  primeInVisitColFilters,
  resetInVisitColFilters,
  useInVisitColFilters,
  type ColFilters,
} from "./dataTableColFilterMemory";

afterEach(() => {
  cleanup();
  resetInVisitColFilters();
});

type Api = { value: ColFilters; set: (v: ColFilters) => void };
let api: Api;

function Probe({ idKey }: { idKey: string }) {
  const [value, set] = useInVisitColFilters(idKey);
  api = { value, set };
  return <span data-testid="v">{JSON.stringify(value)}</span>;
}

describe("useInVisitColFilters", () => {
  it("is empty on a fresh mount when the store is empty", () => {
    const { getByTestId } = render(<Probe idKey="k1" />);
    expect(getByTestId("v").textContent).toBe("{}");
  });

  it("reads a value the store was primed with (a funnel set earlier this visit)", () => {
    primeInVisitColFilters("k2", { status: ["Open"] });
    const { getByTestId } = render(<Probe idKey="k2" />);
    expect(getByTestId("v").textContent).toBe(JSON.stringify({ status: ["Open"] }));
  });

  it("keeps a set value across an unmount/remount, and drops it on reset", () => {
    const first = render(<Probe idKey="k3" />);
    act(() => api.set({ status: ["Open"] }));
    expect(first.getByTestId("v").textContent).toBe(JSON.stringify({ status: ["Open"] }));
    first.unmount();

    // A client-side remount (module stays loaded) reads the kept value.
    const second = render(<Probe idKey="k3" />);
    expect(second.getByTestId("v").textContent).toBe(JSON.stringify({ status: ["Open"] }));
    second.unmount();

    // A fresh bundle evaluation (page load / F5) reads clean.
    resetInVisitColFilters();
    const third = render(<Probe idKey="k3" />);
    expect(third.getByTestId("v").textContent).toBe("{}");
  });

  it("drops the bucket when the funnel is cleared to empty", () => {
    primeInVisitColFilters("k4", { status: ["Open"] });
    const { getByTestId, unmount } = render(<Probe idKey="k4" />);
    act(() => api.set({}));
    expect(getByTestId("v").textContent).toBe("{}");
    unmount();
    // Cleared to empty → the bucket is gone, so a remount stays clean.
    const again = render(<Probe idKey="k4" />);
    expect(again.getByTestId("v").textContent).toBe("{}");
  });

  it("re-reads the new bucket when the idKey moves (company resolves after mount)", () => {
    // The pre-scoping key holds nothing; the scoped key holds a funnel.
    primeInVisitColFilters("c1:k5", { status: ["Closed"] });
    const view = render(<Probe idKey="k5" />);
    expect(view.getByTestId("v").textContent).toBe("{}");
    // idKey gains its c<company>: prefix → the hook re-reads the scoped bucket.
    view.rerender(<Probe idKey="c1:k5" />);
    expect(view.getByTestId("v").textContent).toBe(JSON.stringify({ status: ["Closed"] }));
  });
});
