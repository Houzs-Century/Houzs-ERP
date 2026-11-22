/* After posting or cancelling a GRN, PI, DO, SI or PO the list row showed its old status until the page was reopened:
   the paged lists ('grns-paged', ...) are siblings of the root key a row action refreshed. Any successful write now
   marks every paged list stale. Ported from Conts ERP #1126. */
import { describe, expect, test } from "vitest";
import { MutationObserver } from "@tanstack/react-query";
import { isPagedListKey, queryClient } from "./queryClient";

describe("a write marks the paged document lists stale", () => {
  test("only keys whose root ends in -paged count as paged lists", () => {
    expect(isPagedListKey(["grns-paged", 1, 50])).toBe(true);
    expect(isPagedListKey(["grns"])).toBe(false);
    expect(isPagedListKey(["grn-detail", "x"])).toBe(false);
  });

  test("a successful mutation invalidates every paged list but leaves other reads alone", async () => {
    queryClient.setQueryData(["purchase-invoices-paged", 1, 50], { rows: [] });
    queryClient.setQueryData(["purchase-invoice-detail", "pi-1"], { id: "pi-1" });
    await new MutationObserver(queryClient, { mutationFn: async () => "ok" }).mutate();
    expect(queryClient.getQueryState(["purchase-invoices-paged", 1, 50])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["purchase-invoice-detail", "pi-1"])?.isInvalidated).toBe(false);
  });

  test("a failed mutation leaves the lists alone", async () => {
    queryClient.setQueryData(["grns-paged", 1, 50], { rows: [] });
    await new MutationObserver(queryClient, { mutationFn: async () => { throw new Error("refused"); } }).mutate().catch(() => {});
    expect(queryClient.getQueryState(["grns-paged", 1, 50])?.isInvalidated).toBe(false);
  });
});
