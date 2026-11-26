
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetInVisitColFilters } from "./components/dataTableColFilterMemory";

afterEach(() => {
  cleanup();
  resetInVisitColFilters();
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const stale = [...url.searchParams.keys()].filter((k) => k.startsWith("cf."));
  if (stale.length > 0) {
    for (const k of stale) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url);
  }
});
