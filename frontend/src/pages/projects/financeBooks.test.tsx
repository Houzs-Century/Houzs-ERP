/* The books on the event page (owner 2026-10-01, payment-request item 5:
 * 某一行只要有了入账，就用入账的数字，取代原本手填的或自动算的). The server already
 * swapped the books' lines in (backend/src/scm/lib/event-books.ts); the page:
 *   • lists them with the document that posted them, and the typed / auto
 *     lines they replaced struck out;
 *   • offers no typed line in a row the books fill;
 *   • marks a books row 入账 and lets nobody type over it;
 *   • shows the quick Rental box read-only once Finance has booked rental. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../hooks/useDialog", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), alert: vi.fn(async () => undefined) }),
}));
vi.mock("../../api/client", () => ({
  api: { post: vi.fn(), patch: vi.fn(), del: vi.fn(), putBinary: vi.fn(), fetchBlobUrl: vi.fn() },
}));

import { FinanceAttachmentsSection, SnapshotRow } from "./financeLedgerParts";
import { QuickRentalField } from "./specFields";
import type { FinanceBooks, FinanceLine } from "./types";
import type { useToast } from "../../hooks/useToast";

const toast: ReturnType<typeof useToast> = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };

const line = (over: Partial<FinanceLine>): FinanceLine => ({
  id: 1, project_id: 7, kind: "cost", category: "rental", description: null, amount: 0,
  occurred_at: null, r2_key: null, file_name: null, mime_type: null, notes: null,
  created_by_name: null, created_at: "2026-10-01", ...over,
});

const booksRental = line({
  id: -1_000_000_000, category: "rental", amount: 8000, occurred_at: "2026-10-05", source: "books",
  doc_no: "PV-2610-001", account_code: "900-R032", account_name: "RENTAL - EXHIBITION", description: "RENTAL - EXHIBITION",
});
const booksTransport = line({
  id: -1_000_000_001, category: "transport_fee", amount: 1200, occurred_at: "2026-10-06", source: "books",
  doc_no: "HC-API-2610-001", account_code: "900-T031", account_name: "TRANSPORT FEE", description: "Lorry 5-ton",
});
const books: FinanceBooks = {
  ok: true,
  reason: null,
  rows: ["rental", "transport_fee"],
  closed_categories: ["rental", "transport", "transport_fee"],
  replaced: [
    line({ id: 11, category: "rental", amount: 7500, description: "Rental (snapshot)" }),
    line({ id: 12, category: "transport_fee", amount: 900, auto_source: "auto:transport" }),
  ],
};

describe("the cost lines under the snapshot", () => {
  it("lists the books with the document that posted them, and the lines they replaced struck out", () => {
    render(
      <FinanceAttachmentsSection
        projectId={7}
        lines={[booksRental, booksTransport, line({ id: 21, category: "setup", amount: 1200, description: "Carpenter" })]}
        books={books}
        adding={false}
        onAddOpen={vi.fn()}
        onAddClose={vi.fn()}
        onChange={vi.fn()}
        toast={toast}
      />,
    );
    const box = screen.getByTestId("books-lines");
    expect(within(box).getByText("From the books · 入账 (2)")).toBeTruthy();
    expect(within(box).getByText("PV-2610-001")).toBeTruthy();
    expect(within(box).getByText("HC-API-2610-001")).toBeTruthy();
    expect(box.textContent).toContain("900-R032 RENTAL - EXHIBITION");
    expect(box.textContent).toContain("Lorry 5-ton");
    expect(box.textContent).toContain("Rental · Rental (snapshot) — typed, replaced by the books");
    expect(box.textContent).toContain("Transport Fee — auto, replaced by the books");
    // The typed setup line stays an ordinary, editable cost line; the books' lines are not in that list.
    expect(screen.getByText("Cost lines (1)")).toBeTruthy();
  });

  it("offers no typed line in a row the books fill", () => {
    render(
      <FinanceAttachmentsSection
        projectId={7}
        lines={[booksRental]}
        books={books}
        adding
        onAddOpen={vi.fn()}
        onAddClose={vi.fn()}
        onChange={vi.fn()}
        toast={toast}
      />,
    );
    const options = within(screen.getByRole("combobox")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain("rental");
    expect(options).not.toContain("transport");
    expect(options).not.toContain("transport_fee");
    expect(options).toContain("setup");
  });

  it("shows nothing extra when the event has no money in the books", () => {
    render(
      <FinanceAttachmentsSection
        projectId={7}
        lines={[]}
        books={{ ok: true, reason: null, rows: [], closed_categories: [], replaced: [] }}
        adding={false}
        onAddOpen={vi.fn()}
        onAddClose={vi.fn()}
        onChange={vi.fn()}
        toast={toast}
      />,
    );
    expect(screen.queryByTestId("books-lines")).toBeNull();
  });
});

describe("a snapshot row the books fill", () => {
  it("is marked 入账 and cannot be typed over", () => {
    render(<SnapshotRow label="Rental" value={8000} books />);
    expect(screen.getByText("入账")).toBeTruthy();
    fireEvent.click(screen.getByText("Rental"));
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});

describe("the quick Rental box", () => {
  it("shows Finance's rental read-only, with the document numbers", () => {
    render(<QuickRentalField projectId={7} financeLines={[booksRental]} onSaved={vi.fn()} toast={toast} />);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByText("8,000.00")).toBeTruthy();
    expect(screen.getByTitle("From the books — PV-2610-001")).toBeTruthy();
  });

  it("stays a typed box while the books carry no rental", () => {
    render(<QuickRentalField projectId={7} financeLines={[line({ id: 3, amount: 7500 }), booksTransport]} onSaved={vi.fn()} toast={toast} />);
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("7500");
  });
});
