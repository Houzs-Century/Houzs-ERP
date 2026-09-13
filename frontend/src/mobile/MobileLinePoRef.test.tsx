/* The phone twin of the desktop "PO" column on goods-receipt and
 * purchase-invoice lines (#26; owner 2026-09-12: 电脑版本有的，手机版本都要有).
 * Tapping the order opens it through the same flow navigation the Relationship
 * Map uses, and only when this user may open purchase orders. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileLinePoRef, mobileLinePoRefFor } from "./MobileLinePoRef";

afterEach(cleanup);

describe("mobileLinePoRefFor", () => {
  it("is offered on goods receipts and purchase invoices only", () => {
    const line = { source_po_id: "po-1", source_po_number: "HC-PO-010007" };
    expect(mobileLinePoRefFor("grns", line)).toEqual({ id: "po-1", number: "HC-PO-010007" });
    expect(mobileLinePoRefFor("purchase-invoices", line)).toEqual({ id: "po-1", number: "HC-PO-010007" });
    expect(mobileLinePoRefFor("mfg-purchase-orders", line)).toBeUndefined();
    expect(mobileLinePoRefFor("delivery-orders-mfg", line)).toBeUndefined();
  });
  it("a line with no PO on those two documents is null (renders a dash)", () => {
    expect(mobileLinePoRefFor("grns", {})).toBeNull();
  });
});

describe("MobileLinePoRef", () => {
  it("opens the purchase order when the user may", () => {
    const open = vi.fn();
    render(<MobileLinePoRef poRef={{ id: "po-1", number: "HC-PO-010007" }} nav={{ can: () => true, open }} />);
    fireEvent.click(screen.getByRole("button", { name: /HC-PO-010007/ }));
    expect(open).toHaveBeenCalledWith({ kind: "module", moduleKey: "mfg-purchase-orders", id: "po-1" });
  });
  it("shows the number but is inert when the user may not open purchase orders", () => {
    render(<MobileLinePoRef poRef={{ id: "po-1", number: "HC-PO-010007" }} nav={{ can: () => false, open: vi.fn() }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("HC-PO-010007")).toBeTruthy();
  });
  it("no PO -> a dash, never a guessed header PO", () => {
    render(<MobileLinePoRef poRef={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
  it("renders nothing on documents that do not carry the row", () => {
    const { container } = render(<MobileLinePoRef poRef={undefined} />);
    expect(container.textContent).toBe("");
  });
});

import { MobileLinePoFacts, mobilePiPoPriceNotice } from "./MobileLinePoRef";

describe("MobileLinePoFacts — PO ref, and on an invoice the PO price beside the PI price", () => {
  it("purchase invoice line: PO ref + PO price with the difference", () => {
    render(<MobileLinePoFacts moduleKey="purchase-invoices" line={{ source_po_id: "po-1", source_po_number: "HC-PO-1", po_unit_price_sen: 80_000, unit_price_sen: 83_000 }} />);
    expect(screen.getByText("HC-PO-1")).toBeTruthy();
    expect(screen.getByText(/PO RM\s?800\.00/)).toBeTruthy();
    expect(screen.getByText(/\+RM\s?30\.00 vs PO/)).toBeTruthy();
  });
  it("purchase invoice line with no PO: says no PO link", () => {
    render(<MobileLinePoFacts moduleKey="purchase-invoices" line={{ po_unit_price_sen: null, unit_price_sen: 900 }} />);
    expect(screen.getByText("no PO link")).toBeTruthy();
  });
  it("goods receipt line: PO ref only, no price row", () => {
    render(<MobileLinePoFacts moduleKey="grns" line={{ source_po_id: "po-1", source_po_number: "HC-PO-1", po_unit_price_sen: 80_000, unit_price_sen: 83_000 }} />);
    expect(screen.queryByText(/vs PO|PO RM/)).toBeNull();
  });
});

describe("mobilePiPoPriceNotice — the phone's at-a-glance line", () => {
  it("names how many lines differ and the net, as information", () => {
    const n = mobilePiPoPriceNotice([
      { qty: 1, unit_price_sen: 83_000, po_unit_price_sen: 80_000 },
      { qty: 2, unit_price_sen: 22_500, po_unit_price_sen: 20_000 },
      { qty: 1, unit_price_sen: 5_000, po_unit_price_sen: 5_000 },
    ]);
    expect(n).toMatch(/^2 lines billed at a different price from the PO \(net \+RM\s?80\.00\)\. For reference only\.$/);
  });
  it("nothing differs -> no notice", () => {
    expect(mobilePiPoPriceNotice([{ qty: 1, unit_price_sen: 213_800, po_unit_price_sen: 0 }])).toBeNull();
  });
});
