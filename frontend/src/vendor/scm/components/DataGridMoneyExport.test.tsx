// The DataGrid Export writes a money column the way AutoCount prints it: a NUMBER in
// ringgit (so the sheet sums it) shown #,##0.00 — never the sen integer, never
// "RM 1,234.00" text, never a blank cell because the cell renders JSX.
// docs/bugs/0928-datagrid-export-wrote-money-as-rm-text-or-blank-cells-and-ha.md
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DataGrid, type DataGridColumn } from "./DataGrid";

const h = vi.hoisted(() => ({ books: [] as Array<{ Sheets: Record<string, Record<string, { t?: string; v?: unknown; z?: string }>> }> }));

vi.mock("../../../lib/xlsx-runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../lib/xlsx-runtime")>();
  return { ...real, writeFileXLSX: (wb: (typeof h.books)[number]) => { h.books.push(wb); } };
});

type Row = { id: string; doc: string; totalSen: number; unitSen: number };
const rows: Row[] = [
  { id: "1", doc: "HC-PO-009304", totalSen: 1_500_000, unitSen: 5 },
  { id: "2", doc: "HC-PO-009305", totalSen: 12_345, unitSen: 250_000 },
];
const fmt = (sen: number) => `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const columns: DataGridColumn<Row>[] = [
  { key: "doc", label: "Doc No", accessor: (r) => r.doc },
  { key: "total", label: "Total", accessor: (r) => <b>{fmt(r.totalSen)}</b>, exportValue: (r) => r.totalSen / 100, exportFormat: "money" },
  { key: "unit", label: "Unit Price", accessor: (r) => fmt(r.unitSen), exportValue: (r) => r.unitSen / 100, exportFormat: "rate" },
];

afterEach(() => { h.books.length = 0; localStorage.clear(); });

describe("DataGrid Export — money columns", () => {
  test("a money column leaves as a ringgit number shown #,##0.00, a rate as #,##0.00##", async () => {
    render(<DataGrid rows={rows} columns={columns} storageKey="money-export-test" rowKey={(r) => r.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    await waitFor(() => expect(h.books).toHaveLength(1));
    const ws = h.books[0]!.Sheets["Sheet1"]!;
    expect(ws["A1"]!.v).toBe("Doc No");
    expect(ws["B2"]).toMatchObject({ t: "n", v: 15000, z: "#,##0.00" });
    expect(ws["B3"]).toMatchObject({ t: "n", v: 123.45, z: "#,##0.00" });
    expect(ws["C2"]).toMatchObject({ t: "n", v: 0.05, z: "#,##0.00##" });
    expect(ws["A2"]!.z).toBeUndefined();
  });
});
