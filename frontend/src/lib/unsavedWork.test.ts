import { describe, expect, it, vi } from "vitest";

describe("unsavedWork", () => {
  it("reads an editor URL as unsaved work", async () => {
    vi.resetModules();
    const { hasUnsavedWork } = await import("./unsavedWork");
    const at = (pathname: string, search = "") => hasUnsavedWork({ pathname, search });
    expect(at("/scm/sales-orders/HC-SO-1")).toBe(false);
    expect(at("/scm/sales-orders/HC-SO-1", "?print=1")).toBe(false);
    expect(at("/scm/sales-orders/HC-SO-1", "?edit=1")).toBe(true);
    expect(at("/scm/delivery-orders/new", "?edit=abc")).toBe(true);
    expect(at("/scm/sales-orders/new")).toBe(true);
    expect(at("/scm/grns/from-po")).toBe(true);
    expect(at("/scm/sales-orders/HC-SO-1", "?edit=0")).toBe(false);
    // A document number that merely CONTAINS the word is not an editor.
    expect(at("/scm/products/renewal-kit")).toBe(false);
  });

  it("counts every holder until each releases", async () => {
    vi.resetModules();
    const { hasUnsavedWork, holdUnsavedWork } = await import("./unsavedWork");
    const loc = { pathname: "/scm/sales-orders/HC-SO-1", search: "" };
    const a = holdUnsavedWork();
    const b = holdUnsavedWork();
    a();
    a();
    expect(hasUnsavedWork(loc)).toBe(true);
    b();
    expect(hasUnsavedWork(loc)).toBe(false);
  });
});
