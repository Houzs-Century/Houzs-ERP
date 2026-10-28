import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../lib/storageIdentity";
import { useIdleSessionFilter } from "./useIdleSessionFilter";

const HOUR = 60 * 60 * 1000;

function Probe() {
  const [f, patch] = useIdleSessionFilter("mobile-calendar", { brand: "all", org: "all" }, HOUR);
  return (
    <>
      <output data-testid="brand">{f.brand}</output>
      <button onClick={() => patch({ brand: "AKEMI" })}>set</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  clearBrowserStorageIdentity();
  sessionStorage.clear();
});

describe("useIdleSessionFilter", () => {
  it("persists a change and restores it on remount (open-a-project-and-back)", async () => {
    bindBrowserStorageIdentity(7);
    render(<Probe />);
    fireEvent.click(screen.getByText("set"));
    await waitFor(() => {
      const rec = JSON.parse(sessionStorage.getItem("filters:mobile-calendar:u7:c0") as string);
      expect(rec.v.brand).toBe("AKEMI");
      expect(typeof rec.t).toBe("number");
    });
    cleanup();
    render(<Probe />);
    expect(screen.getByTestId("brand").textContent).toBe("AKEMI");
  });

  it("restores a value changed less than an hour ago", () => {
    bindBrowserStorageIdentity(7);
    sessionStorage.setItem("filters:mobile-calendar:u7:c0",
      JSON.stringify({ v: { brand: "ZANOTTI", org: "all" }, t: Date.now() - 30 * 60 * 1000 }));
    render(<Probe />);
    expect(screen.getByTestId("brand").textContent).toBe("ZANOTTI");
  });

  it("drops a value untouched for more than an hour", () => {
    bindBrowserStorageIdentity(7);
    sessionStorage.setItem("filters:mobile-calendar:u7:c0",
      JSON.stringify({ v: { brand: "ZANOTTI", org: "all" }, t: Date.now() - 61 * 60 * 1000 }));
    render(<Probe />);
    expect(screen.getByTestId("brand").textContent).toBe("all");
    expect(sessionStorage.getItem("filters:mobile-calendar:u7:c0")).toBeNull();
  });

  it("does not leak another user's filter", () => {
    sessionStorage.setItem("filters:mobile-calendar:u7:c0",
      JSON.stringify({ v: { brand: "ZANOTTI", org: "all" }, t: Date.now() }));
    bindBrowserStorageIdentity(8);
    render(<Probe />);
    expect(screen.getByTestId("brand").textContent).toBe("all");
  });
});
