import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { SoListPoCell } from "./SoSourceChips";
import { SourcePosRowMobile } from "../mobile/source-chips";


const HC_SO_011733 = { source_po_union: [], converted_po_nos: ["HC-PO-008783"], source_po_adj: false };

describe("SoListPoCell (desktop PO No. column)", () => {
  test("a raised-only order shows its purchase order, not a dash", () => {
    render(<SoListPoCell row={HC_SO_011733} />);
    const chip = screen.getByText("HC-PO-008783");
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("title")).toContain("Raised PO");
    expect(screen.queryByText("—")).toBeNull();
  });

  test("a goods-source PO wears the solid dress and says so", () => {
    render(<SoListPoCell row={{ source_po_union: ["HC-PO-000111"], converted_po_nos: [] }} />);
    expect(screen.getByText("HC-PO-000111").getAttribute("title")).toContain("Source PO");
  });

  test("a PO that is BOTH raised and the goods source is chipped once, as the source", () => {
    render(<SoListPoCell row={{ source_po_union: ["HC-PO-000111"], converted_po_nos: ["HC-PO-000111"] }} />);
    expect(screen.getAllByText("HC-PO-000111")).toHaveLength(1);
    expect(screen.getByText("HC-PO-000111").getAttribute("title")).toContain("Source PO");
  });

  test("many POs to one SO overflow explicitly — never the first one in silence", () => {
    render(<SoListPoCell row={{
      source_po_union: ["HC-PO-1", "HC-PO-2"],
      converted_po_nos: ["HC-PO-3", "HC-PO-4", "HC-PO-5"],
    }} />);
    expect(screen.getByText("HC-PO-1")).toBeTruthy();
    expect(screen.getByText("HC-PO-3")).toBeTruthy();
    expect(screen.queryByText("HC-PO-4")).toBeNull();
    const more = screen.getByText("+2");
    expect(more.getAttribute("title")).toBe(
      "All purchase orders on this sales order: HC-PO-1, HC-PO-2, HC-PO-3, HC-PO-4, HC-PO-5",
    );
  });

  test("a genuinely PO-less order still reads as a dash", () => {
    render(<SoListPoCell row={{ source_po_union: [], converted_po_nos: [] }} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("SourcePosRowMobile (mobile Orders card)", () => {
  test("the same raised-only order shows the same purchase order on the phone", () => {
    render(<SourcePosRowMobile pos={[]} raised={["HC-PO-008783"]} />);
    expect(screen.getByText("HC-PO-008783").getAttribute("title")).toContain("Raised PO");
  });

  test("a raised PO already shown as the goods source is not repeated", () => {
    render(<SourcePosRowMobile pos={["HC-PO-000111"]} raised={["HC-PO-000111"]} />);
    expect(screen.getAllByText("HC-PO-000111")).toHaveLength(1);
  });

  test("nothing to show still renders nothing (card idiom, not a dash)", () => {
    const { container } = render(<SourcePosRowMobile pos={[]} raised={[]} />);
    expect(container.textContent).toBe("");
  });
});
