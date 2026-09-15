/* The PO line import dialog (owner ruling 2026-09-15): the preview must show
 * every change as document, line, field, old, new; every refused row with its
 * reason; the counts; and PO-level estimate dates ONCE per purchase order. And
 * nothing is sent to apply before Confirm. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoLineImportPreview } from "../../vendor/scm/lib/po-line-import";

const h = vi.hoisted(() => ({ authed: vi.fn() }));
vi.mock("../../vendor/scm/lib/authed-fetch", () => ({
  authedFetch: (...a: unknown[]) => h.authed(...a),
  humanApiError: (_s: number, b: string) => b,
}));

import { PoLineImportModal, PoLineImportPreviewView } from "./PoLineImportModal";
import { utils, writeXLSX } from "../../lib/xlsx-runtime";

const L1 = "11111111-0000-4000-8000-000000000001";
const PO = "aaaaaaaa-0000-4000-8000-000000000001";

const preview: PoLineImportPreview = {
  rows: [
    { rowNumber: 2, docNo: "PO-000100", lineId: L1, itemCode: "BED-K", status: "changes", changes: [
      { field: "deliveryDate", old: "2026-09-01", new: "2026-09-20" },
      { field: "remarks", old: null, new: "chase supplier" },
    ] },
    { rowNumber: 3, docNo: "PO-000100", lineId: "l2", itemCode: "BED-Q", status: "unchanged" },
    { rowNumber: 4, docNo: "PO-000999", lineId: "l3", itemCode: "SOFA-1", status: "rejected", code: "po_locked", reason: "PO-000999: PO has a Goods Receipt" },
  ],
  poChanges: [{ poId: PO, docNo: "PO-000100", field: "estimateDeliveryDate1", old: null, new: "2026-10-15", lineValues: { [L1]: null, l2: null }, rowNumbers: [2, 3] }],
  poRejections: [{ docNo: "PO-000300", field: "estimateDeliveryDate2", reason: "rows disagree: row 7 2026-10-01, row 8 2026-10-02", rowNumbers: [7, 8] }],
  lineChanges: [
    { lineId: L1, docNo: "PO-000100", field: "deliveryDate", old: "2026-09-01", new: "2026-09-20" },
    { lineId: L1, docNo: "PO-000100", field: "remarks", old: null, new: "chase supplier" },
  ],
  counts: { rows: 3, changed: 1, unchanged: 1, rejected: 1, poChanges: 1, poRejected: 1 },
};

afterEach(cleanup);
/* A block body: a hook that RETURNS the mock hands vitest a teardown to call. */
beforeEach(() => { h.authed.mockReset(); });

describe("PoLineImportPreviewView", () => {
  it("lists each change as doc, line, field, old, new, highlighted; refused rows carry their reason", () => {
    render(<PoLineImportPreviewView preview={preview} ignoredHeaders={["Qty", "Unit Price"]} missingHeaders={[]} />);
    const lines = screen.getByRole("region", { name: "Lines" });
    const changed = lines.querySelectorAll('tr[data-status="change"]');
    expect(changed).toHaveLength(2);
    expect(changed[0]!.textContent).toContain("PO-000100");
    expect(changed[0]!.textContent).toContain("BED-K");
    expect(changed[0]!.textContent).toContain("Delivery Date");
    expect(changed[0]!.textContent).toContain("2026-09-01");
    expect(changed[0]!.textContent).toContain("2026-09-20");
    expect(changed[1]!.textContent).toMatch(/Remarks\s*blank\s*chase supplier/);
    expect(within(lines).getByText(/Refused: PO-000999: PO has a Goods Receipt/)).toBeTruthy();
    expect(screen.getByText(/Ignored columns .*Qty, Unit Price/)).toBeTruthy();
  });

  it("hides unchanged rows until asked", () => {
    render(<PoLineImportPreviewView preview={preview} ignoredHeaders={[]} missingHeaders={[]} />);
    const lines = screen.getByRole("region", { name: "Lines" });
    expect(lines.querySelectorAll('tr[data-status="unchanged"]')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Show unchanged rows"));
    expect(lines.querySelectorAll('tr[data-status="unchanged"]')).toHaveLength(1);
  });

  it("shows the estimate date once per PO, with how many lines it sets, and the PO-level refusal", () => {
    render(<PoLineImportPreviewView preview={preview} ignoredHeaders={[]} missingHeaders={[]} />);
    const po = screen.getByRole("region", { name: "Purchase order dates" });
    const row = po.querySelector('tr[data-status="po-change"]')!;
    expect(row.textContent).toContain("Estimate Delivery Date");
    expect(row.textContent).toContain("sets all 2 lines");
    expect(row.textContent).toContain("2026-10-15");
    expect(po.querySelector('tr[data-status="po-rejected"]')!.textContent).toContain("rows disagree");
  });

  it("shows the counts", () => {
    render(<PoLineImportPreviewView preview={preview} ignoredHeaders={[]} missingHeaders={[]} />);
    for (const label of ["Rows read", "Lines changing", "Unchanged", "Rows refused", "PO dates changing", "PO dates refused"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

const xlsxFile = (rows: unknown[][]) => {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), "PO lines");
  const bytes = writeXLSX(wb, { type: "array" }) as ArrayBuffer;
  const file = new File([bytes], "po-lines.xlsx");
  /* jsdom's File has no arrayBuffer(); the browser's does. */
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes });
  return file;
};

describe("PoLineImportModal — file to preview to confirm", () => {
  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PoLineImportModal open onClose={() => {}} />
      </QueryClientProvider>,
    );

  it("parses the xlsx, previews ONLY the import columns, and applies nothing before Confirm", async () => {
    h.authed.mockImplementation(async (path: string) => {
      if (path.endsWith("/preview")) return preview;
      return { ok: true, linesUpdated: 1, purchaseOrdersUpdated: 1, poLevelChanges: 1, autocountEditsQueued: 1 };
    });
    mount();
    const file = xlsxFile([
      ["Doc No", "Line ID", "Item Code", "Qty", "Delivery Date", "Remarks"],
      ["PO-000100", L1, "BED-K", 99, 46285, "chase supplier"],
    ]);
    fireEvent.change(screen.getByLabelText("Choose the edited PO lines file"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("region", { name: "Lines" })).toBeTruthy());
    expect(h.authed).toHaveBeenCalledTimes(1);
    const [path, init] = h.authed.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/mfg-purchase-orders/line-import/preview");
    const sent = JSON.parse(String(init.body)) as { rows: Array<{ rowNumber: number; lineId: string; values: Record<string, unknown> }> };
    expect(sent.rows).toEqual([{ rowNumber: 2, docNo: "PO-000100", lineId: L1, values: { deliveryDate: 46285, remarks: "chase supplier" } }]);

    fireEvent.click(screen.getByRole("button", { name: "Confirm 3 changes" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 line updated"));
    const [applyPath, applyInit] = h.authed.mock.calls[1] as [string, RequestInit];
    expect(applyPath).toBe("/mfg-purchase-orders/line-import/apply");
    const body = JSON.parse(String(applyInit.body)) as { lineChanges: unknown[]; poChanges: Array<Record<string, unknown>> };
    expect(body.lineChanges).toEqual(preview.lineChanges);
    expect(body.poChanges).toEqual([{ poId: PO, docNo: "PO-000100", field: "estimateDeliveryDate1", old: null, new: "2026-10-15", lineValues: { [L1]: null, l2: null } }]);
  });

  it("a conflict at Confirm stays on the preview and lists what moved", async () => {
    h.authed.mockImplementation(async (path: string) => {
      if (path.endsWith("/preview")) return preview;
      throw Object.assign(new Error("conflict"), {
        status: 409,
        body: JSON.stringify({ error: "import_conflict", message: "Some purchase orders changed after the preview, so nothing was imported. Preview the file again.", conflicts: [{ docNo: "PO-000100", lineId: L1, field: "deliveryDate", reason: "Delivery Date on BED-K changed since the preview (it is now 2026-09-05)." }] }),
      });
    });
    mount();
    fireEvent.change(screen.getByLabelText("Choose the edited PO lines file"), {
      target: { files: [xlsxFile([["Doc No", "Line ID", "Remarks"], ["PO-000100", L1, "x"]])] },
    });
    await waitFor(() => screen.getByRole("button", { name: "Confirm 3 changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm 3 changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nothing was imported");
    expect(alert.textContent).toContain("it is now 2026-09-05");
  });

  it("a file that is not a PO lines export is refused before anything is sent", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Choose the edited PO lines file"), {
      target: { files: [xlsxFile([["Customer", "Phone"], ["A", "1"]])] },
    });
    expect((await screen.findByRole("alert")).textContent).toContain('no "Line ID" column');
    expect(h.authed).not.toHaveBeenCalled();
  });
});
