import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssrOrderPoLine } from "./AssrOrderPoLine";
import { assrMergedPos, assrMergedPoText, assrOrderPoHref, assrOrderPos, assrOrderPoText } from "../vendor/scm/lib/assr/case-fields";

/* "Order PO" on a service case — the supplier purchase orders raised from the
 * case's SALES ORDER (server field `order_pos`, backend services/assrOrderPos.ts).
 *
 * Staff reported "create service case no have PO no record in the column".
 * The case's own `po_no` is a different fact — the SERVICE purchase order that
 * generate-po mints and costing reads — so it stays exactly as it was, and the
 * order's purchase orders get their own read-only line beside it. Desktop list,
 * desktop detail and the phone read the same field through one reader. */

const HOUZS_CASE = {
  company_id: 1,
  po_no: "SVC-PO-0042",
  order_pos: [
    { id: "0b6c-po-1", po_number: "HC-PO-008783" },
    { id: "0b6c-po-2", po_number: "HC-PO-008790" },
  ],
};

describe("assrOrderPos / assrOrderPoText", () => {
  test("reads the server's snake_case field", () => {
    expect(assrOrderPos(HOUZS_CASE)).toEqual(HOUZS_CASE.order_pos);
    expect(assrOrderPoText(HOUZS_CASE)).toBe("HC-PO-008783 · HC-PO-008790");
  });

  test("reads a camelCased payload too (the phone's get() accepts both)", () => {
    const row = { orderPos: [{ id: "x", poNumber: "PO-2607-004" }] };
    expect(assrOrderPos(row)).toEqual([{ id: "x", po_number: "PO-2607-004" }]);
  });

  test("absent, null or malformed reads as none — never po_no", () => {
    expect(assrOrderPoText({ po_no: "SVC-PO-0042" })).toBe("");
    expect(assrOrderPos({ order_pos: null })).toEqual([]);
    expect(assrOrderPos(null)).toEqual([]);
    expect(assrOrderPos({ order_pos: [{ id: "a" }, { po_number: "no-id" }, "junk"] })).toEqual([]);
  });

  test("the link opens the PO in the CASE's company", () => {
    // Service Cases are cross-company; the PO page is scoped to the tab's
    // active company, so the link seeds a new window with the case's company.
    expect(assrOrderPoHref({ id: "0b6c-po-1", po_number: "X" }, 2)).toBe("/scm/purchase-orders/0b6c-po-1?company=2");
    expect(assrOrderPoHref({ id: "a/b", po_number: "X" }, null)).toBe("/scm/purchase-orders/a%2Fb");
  });
});

/* The desktop list column "PO" is ONE value: the order POs and the service PO
 * (po_no) shown together, deduped so a service PO hand-typed as the order PO
 * without its company prefix does not double up. The data stays two fields. */
describe("assrMergedPos / assrMergedPoText", () => {
  test("order POs first, then the service PO when they differ", () => {
    const row = { order_pos: [{ id: "a", po_number: "2990-PO-2608-014" }], po_no: "APO/2609-001" };
    expect(assrMergedPoText(row)).toBe("2990-PO-2608-014 · APO/2609-001");
  });

  test("a service PO typed without its company prefix collapses into the order PO", () => {
    // HC-PO-009918 (order) and PO-009918 (hand-typed po_no) are the same PO.
    const row = { order_pos: [{ id: "a", po_number: "HC-PO-009918" }], po_no: "PO-009918" };
    expect(assrMergedPos(row)).toEqual([{ id: "a", po_number: "HC-PO-009918" }]);
    expect(assrMergedPoText(row)).toBe("HC-PO-009918");
  });

  test("a genuinely different service PO is kept", () => {
    const row = { order_pos: [{ id: "a", po_number: "HC-PO-009122" }], po_no: "SVC-PO-0042" };
    expect(assrMergedPoText(row)).toBe("HC-PO-009122 · SVC-PO-0042");
  });

  test("only one side present shows just that side; none shows nothing", () => {
    expect(assrMergedPoText({ order_pos: [{ id: "a", po_number: "HC-PO-009990" }] })).toBe("HC-PO-009990");
    expect(assrMergedPoText({ po_no: "PO-009635" })).toBe("PO-009635");
    expect(assrMergedPoText({})).toBe("");
  });

  test("reads a camelCased payload too (the phone)", () => {
    expect(assrMergedPoText({ orderPos: [{ id: "x", poNumber: "HC-PO-1" }], poNo: "PO-1" })).toBe("HC-PO-1");
  });
});

describe("AssrOrderPoLine (desktop case detail)", () => {
  test("each purchase order is a link to its PO page", () => {
    render(<AssrOrderPoLine row={HOUZS_CASE} />);
    expect(screen.getByText("Order PO")).toBeTruthy();
    const a = screen.getByText("HC-PO-008783").closest("a");
    expect(a?.getAttribute("href")).toBe("/scm/purchase-orders/0b6c-po-1?company=1");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("HC-PO-008790").closest("a")?.getAttribute("href")).toBe("/scm/purchase-orders/0b6c-po-2?company=1");
    // The service PO is not repeated here.
    expect(screen.queryByText("SVC-PO-0042")).toBeNull();
  });

  test("no purchase order renders a dash, no link", () => {
    const { container } = render(<AssrOrderPoLine row={{ company_id: 1, order_pos: [] }} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
  });
});

/* The two screens are 8,800 and 3,400 lines and cannot be mounted without a
 * router, a query client and the whole detail fetch — same reason as
 * case-fields.canonical.test.ts. What must hold is WHERE they read it. */
const code = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("where Order PO appears", () => {
  const desktop = code("src/pages/ServiceCases.tsx");
  const mobile = code("src/mobile/MobileServiceCase.tsx");

  test("desktop list: one merged PO column after DO No, filterable; the two split columns are gone", () => {
    const doCol = desktop.indexOf('key: "do_numbers"');
    const poCol = desktop.indexOf('key: "po"');
    expect(doCol).toBeGreaterThan(-1);
    expect(poCol).toBeGreaterThan(doCol);
    const block = desktop.slice(poCol, poCol + 600);
    expect(block).toContain('label: "PO"');
    expect(block).toContain("filterable: true");
    expect(block).toContain("assrMergedPoText(r)");
    // the list no longer carries the two separate PO columns
    expect(desktop).not.toContain('key: "order_pos"');
    expect(desktop).not.toContain('key: "po_no"');
  });

  test("desktop detail: the read-only line sits above the editable PO No", () => {
    const line = desktop.indexOf("<AssrOrderPoLine row={c} />");
    const edit = desktop.indexOf('label="PO No"');
    expect(line).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(line);
    expect(edit - line).toBeLessThan(200);
  });

  test("mobile: Order PO shown read-only above PO No", () => {
    const kv = mobile.indexOf('<KV label="Order PO" value={assrOrderPoText(c) || "—"} mono />');
    const po = mobile.indexOf('<KV label="PO No"');
    expect(kv).toBeGreaterThan(-1);
    expect(po).toBeGreaterThan(kv);
  });
});
