// The in-visit funnel memory the DataTable default now uses (owner 2026-09-16):
// a funnel survives a client-side remount but a fresh page load opens clean, and
// it never touches localStorage. Reset simulates the fresh bundle evaluation.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  primeInVisitColFilters,
  resetInVisitColFilters,
  useInVisitClientSearch,
  useInVisitColFilters,
  useKeptColFilters,
  type ColFilters,
} from "./dataTableColFilterMemory";

afterEach(() => {
  cleanup();
  resetInVisitColFilters();
  localStorage.clear();
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

type SearchApi = { value: string; set: (v: string) => void };
let searchApi: SearchApi;

function SearchProbe({ idKey, enabled = true }: { idKey: string; enabled?: boolean }) {
  const [value, set] = useInVisitClientSearch(idKey, enabled);
  searchApi = { value, set };
  return <span data-testid="s">{value}</span>;
}

describe("useInVisitClientSearch", () => {
  it("keeps the text across a remount this visit, and drops it on reset", () => {
    const first = render(<SearchProbe idKey="s1" />);
    act(() => searchApi.set("ali"));
    expect(first.getByTestId("s").textContent).toBe("ali");
    first.unmount();

    const second = render(<SearchProbe idKey="s1" />);
    expect(second.getByTestId("s").textContent).toBe("ali");
    second.unmount();

    resetInVisitColFilters();
    const third = render(<SearchProbe idKey="s1" />);
    expect(third.getByTestId("s").textContent).toBe("");
  });

  it("is per mount when disabled, and never reads what an enabled table stored", () => {
    const first = render(<SearchProbe idKey="s2" />);
    act(() => searchApi.set("ali"));
    first.unmount();
    const second = render(<SearchProbe idKey="s2" enabled={false} />);
    expect(second.getByTestId("s").textContent).toBe("");
  });
});

let keptApi: Api;

function KeptProbe({ idKey, enabled = true }: { idKey: string; enabled?: boolean }) {
  const [value, set] = useKeptColFilters(idKey, enabled);
  keptApi = { value, set };
  return <span data-testid="k">{JSON.stringify(value)}</span>;
}

describe("useKeptColFilters", () => {
  it("writes dt:funnels:<idKey>, reads it back on a fresh mount, removes it when cleared", () => {
    const first = render(<KeptProbe idKey="k1" />);
    act(() => keptApi.set({ status: ["Open"] }));
    expect(JSON.parse(localStorage.getItem("dt:funnels:k1") ?? "null")).toEqual({ status: ["Open"] });
    first.unmount();

    const second = render(<KeptProbe idKey="k1" />);
    expect(second.getByTestId("k").textContent).toBe(JSON.stringify({ status: ["Open"] }));
    act(() => keptApi.set({}));
    expect(localStorage.getItem("dt:funnels:k1")).toBeNull();
  });

  it("reads a damaged or foreign value as no filter", () => {
    localStorage.setItem("dt:funnels:k2", "{not json");
    expect(render(<KeptProbe idKey="k2" />).getByTestId("k").textContent).toBe("{}");
    cleanup();
    localStorage.setItem("dt:funnels:k3", JSON.stringify({ status: "Open", n: [1], ok: ["A"], empty: [] }));
    expect(render(<KeptProbe idKey="k3" />).getByTestId("k").textContent).toBe(JSON.stringify({ ok: ["A"] }));
  });

  it("touches no storage while disabled", () => {
    localStorage.setItem("dt:funnels:k4", JSON.stringify({ status: ["Open"] }));
    const view = render(<KeptProbe idKey="k4" enabled={false} />);
    expect(view.getByTestId("k").textContent).toBe("{}");
    act(() => keptApi.set({ status: ["Closed"] }));
    expect(JSON.parse(localStorage.getItem("dt:funnels:k4") ?? "null")).toEqual({ status: ["Open"] });
  });

  it("re-reads the new key when the idKey moves (company resolves after mount)", () => {
    localStorage.setItem("dt:funnels:c1:k5", JSON.stringify({ status: ["Closed"] }));
    const view = render(<KeptProbe idKey="k5" />);
    expect(view.getByTestId("k").textContent).toBe("{}");
    view.rerender(<KeptProbe idKey="c1:k5" />);
    expect(view.getByTestId("k").textContent).toBe(JSON.stringify({ status: ["Closed"] }));
    // The empty pre-scoping value must not have been written over the scoped key.
    expect(JSON.parse(localStorage.getItem("dt:funnels:c1:k5") ?? "null")).toEqual({ status: ["Closed"] });
  });
});
