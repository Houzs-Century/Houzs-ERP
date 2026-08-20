import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* MobileSearch — the phone's global search palette.
 *
 * The rule these tests pin: EVERY hit the server returns is accounted for on
 * screen. The phone lists only the five record types it has a screen for
 * (TYPE_ORDER); the five SCM documents — purchase order, GRN, delivery order,
 * sales invoice, purchase invoice — are desktop-only and used to be dropped
 * silently. Dropped silently is the defect: the "No matches" line is gated on
 * the RAW hit count, so a search for a DO number returned hits, suppressed the
 * empty state, filtered every hit out, and rendered a BLANK screen. */

const { searchResult } = vi.hoisted(() => ({
  searchResult: {
    current: {
      term: "",
      hits: [] as any[],
      loading: false,
      error: null as unknown,
      degradedNotice: null as string | null,
    },
  },
}));

vi.mock("../lib/globalSearch", () => ({
  GLOBAL_SEARCH_MIN_LENGTH: 2,
  useGlobalSearchResults: () => searchResult.current,
}));

import { MobileSearch } from "./MobileSearch";

afterEach(cleanup);

function hit(type: string, id: string, title: string) {
  return { type, id, title, subtitle: "Acme Sdn Bhd", date: "2026-08-14" };
}

function show(hits: any[], term = "DO-2607") {
  searchResult.current = { term, hits, loading: false, error: null, degradedNotice: null };
  render(<MobileSearch onBack={() => {}} onNavigate={() => {}} />);
}

/* HighlightedText wraps the matched keyword in its own <mark>, so a doc number
   is split across nodes. Match on the whole title element's textContent. */
function title(docNo: string): HTMLElement {
  return screen.getByText((_t, el) => {
    if (!el || el.tagName !== "SPAN") return false;
    return (el.textContent ?? "") === docNo;
  });
}
function queryTitle(docNo: string): HTMLElement | null {
  return screen.queryByText((_t, el) => {
    if (!el || el.tagName !== "SPAN") return false;
    return (el.textContent ?? "") === docNo;
  });
}

describe("MobileSearch accounts for every hit", () => {
  it("renders SCM documents the phone cannot open instead of dropping them", () => {
    show([
      hit("delivery_order", "DO-2607-005", "DO-2607-005"),
      hit("grn", "GRN-2607-001", "GRN-2607-001"),
    ]);

    // The information must reach the screen: the operator searched a DO number
    // and it exists.
    expect(title("DO-2607-005")).toBeTruthy();
    expect(title("GRN-2607-001")).toBeTruthy();
    // And it must say why it cannot be opened here, rather than look broken.
    expect(screen.getAllByText(/desktop/i).length).toBeGreaterThan(0);
  });

  it("never renders an empty screen when the server returned hits", () => {
    show([hit("sales_invoice", "SI-2608-011", "SI-2608-011")]);

    const body = document.body.textContent ?? "";
    // Either the hit renders or an explanation does — silence is the bug.
    expect(body).toContain("SI-2608-011");
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it("does not offer a dead tap: an SCM hit is not a button", () => {
    const onNavigate = vi.fn();
    searchResult.current = {
      term: "DO-2607",
      hits: [hit("delivery_order", "DO-2607-005", "DO-2607-005")],
      loading: false,
      error: null,
      degradedNotice: null,
    };
    render(<MobileSearch onBack={() => {}} onNavigate={onNavigate} />);

    expect(queryTitle("DO-2607-005")).toBeTruthy();
    expect(queryTitle("DO-2607-005")!.closest("button")).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("still shows the honest empty state when there are genuinely no hits", () => {
    show([], "zzzz");
    expect(screen.getByText(/No matches for "zzzz"/)).toBeTruthy();
  });

  it("keeps routing the five types the phone does own", () => {
    const onNavigate = vi.fn();
    searchResult.current = {
      term: "SO-2608",
      hits: [hit("sales_order", "SO-2608-001", "SO-2608-001")],
      loading: false,
      error: null,
      degradedNotice: null,
    };
    render(<MobileSearch onBack={() => {}} onNavigate={onNavigate} />);
    const card = title("SO-2608-001").closest("button");
    expect(card).toBeTruthy();
    card!.click();
    expect(onNavigate).toHaveBeenCalledWith({ kind: "sales_order", docNo: "SO-2608-001" });
  });
});
