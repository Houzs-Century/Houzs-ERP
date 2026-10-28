import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExhibitionSalesTable } from "./ExhibitionSalesTable";
import type { SalesEntry } from "../Sales";

const entry = (over: Partial<SalesEntry>): SalesEntry => ({
  id: 1, doc_no: null, project_id: 9, project_code: null, project_name: null, ref_no: "R-1",
  customer_name: "Tan", customer_code: null, customer_address: null, customer_address_2: null,
  customer_postcode: null, customer_state: null, customer_phone: null, customer_phone_2: null,
  customer_email: null, amount: 1000, deposit_amount: 300, deposit_payment_type: null, currency: "MYR",
  occurred_at: "2026-09-20", processing_date: null, delivery_date: null, status_2: null, venue: null,
  warehouse: null, branding: null, po_doc_no: null, payment_status: null, source: null, remarks: null,
  notes: null, status: "draft", autocount_doc_no: null, autocount_doc_type: null, pushed_at: null,
  push_error: null, sales_person_id: null, sales_person_name: "Aina", sales_person_email: null,
  created_by: 7, created_by_name: null, created_by_email: null, created_at: "", updated_at: "", archived_at: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});
afterEach(cleanup);

const handlers = () => ({ onEdit: vi.fn(), onSubmit: vi.fn(), onVoid: vi.fn(), onDelete: vi.fn() });

describe("ExhibitionSalesTable", () => {
  it("shows the balance still to chase and who sold it", () => {
    render(<ExhibitionSalesTable rows={[entry({})]} meId={7} canManage={false} canLogSale {...handlers()} />);
    expect(screen.getByText("Aina")).toBeTruthy();
    expect(screen.getByTitle("Balance to chase post-event")).toBeTruthy();
  });

  it("the creator may submit, edit and delete their own draft; nobody else may", () => {
    const h = handlers();
    const { unmount } = render(<ExhibitionSalesTable rows={[entry({})]} meId={7} canManage={false} canLogSale {...h} />);
    fireEvent.click(screen.getByTitle("Submit"));
    expect(h.onSubmit).toHaveBeenCalled();
    expect(screen.getByTitle("Delete")).toBeTruthy();
    expect(screen.queryByTitle("Void")).toBeNull();
    unmount();
    render(<ExhibitionSalesTable rows={[entry({})]} meId={8} canManage={false} canLogSale {...handlers()} />);
    expect(screen.queryByTitle("Submit")).toBeNull();
    expect(screen.queryByTitle("Edit")).toBeNull();
  });

  it("a quick log offers Complete to anyone who can log a sale", () => {
    const h = handlers();
    render(<ExhibitionSalesTable rows={[entry({ customer_name: "(quick log)" })]} meId={1} canManage={false} canLogSale {...h} />);
    fireEvent.click(screen.getByText("Complete"));
    expect(h.onEdit).toHaveBeenCalled();
  });
});
