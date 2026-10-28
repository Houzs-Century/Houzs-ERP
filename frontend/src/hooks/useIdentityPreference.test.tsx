import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
} from "../lib/storageIdentity";
import {
  booleanPreference,
  booleanRecordPreference,
  enumPreference,
  pageSizePreference,
  useIdentityPreference,
} from "./useIdentityPreference";

const viewPreference = enumPreference(["list", "grid"] as const);

function Probe() {
  const [view, setView] = useIdentityPreference("test:view", "list", viewPreference);
  return (
    <>
      <output data-testid="value">{view}</output>
      <button onClick={() => setView("grid")}>grid</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  clearBrowserStorageIdentity();
  localStorage.clear();
});

describe("useIdentityPreference", () => {
  test("does not persist without an authenticated storage identity", () => {
    render(<Probe />);
    fireEvent.click(screen.getByText("grid"));
    expect(screen.getByTestId("value").textContent).toBe("list");
    expect(localStorage.length).toBe(0);
  });

  test("removes corrupt or invalid scoped values and returns the default", async () => {
    bindBrowserStorageIdentity(7);
    localStorage.setItem("test:view:u7:c0", "null");
    render(<Probe />);
    expect(screen.getByTestId("value").textContent).toBe("list");
    await waitFor(() => expect(localStorage.getItem("test:view:u7:c0")).toBeNull());
  });

  test("isolates users and updates immediately when identity changes", async () => {
    bindBrowserStorageIdentity(7);
    localStorage.setItem("test:view:u7:c0", JSON.stringify("grid"));
    render(<Probe />);
    expect(screen.getByTestId("value").textContent).toBe("grid");

    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(8);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("list"));

    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(7);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("grid"));
  });

  test("follows a cross-tab storage update", async () => {
    bindBrowserStorageIdentity(7);
    render(<Probe />);
    localStorage.setItem("test:view:u7:c0", JSON.stringify("grid"));
    window.dispatchEvent(new StorageEvent("storage", {
      key: "test:view:u7:c0",
      storageArea: localStorage,
    }));
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("grid"));
  });
});

describe("identity preference sanitizers", () => {
  test("accept only explicit enum, boolean and page-size values", () => {
    expect(viewPreference("grid")).toBe("grid");
    expect(viewPreference("admin")).toBeUndefined();
    expect(booleanPreference(false)).toBe(false);
    expect(booleanPreference(0)).toBeUndefined();
    expect(pageSizePreference([25, 50, 100])(50)).toBe(50);
    expect(pageSizePreference([25, 50, 100])(5000)).toBeUndefined();
  });

  test("accepts only bounded plain boolean records", () => {
    expect(booleanRecordPreference({ sales: true, admin: false })).toEqual({ sales: true, admin: false });
    expect(booleanRecordPreference(null)).toBeUndefined();
    expect(booleanRecordPreference({ sales: "yes" })).toBeUndefined();
    expect(booleanRecordPreference(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, true])))).toBeUndefined();
  });
});
