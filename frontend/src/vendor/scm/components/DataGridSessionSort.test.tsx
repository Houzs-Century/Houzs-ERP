/* DataGrid `sortForSessionOnly` (owner 2026-09-14, docs/bugs/0888).

   A header sort is normally SAVED with the grid layout and restored on the next
   visit. The amendment queues open Requested-first, and a saved Status sort had
   put Requested at the bottom for whoever once clicked that header. With the
   prop, the header sort lasts for the visit only. */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DataGrid, type DataGridColumn } from "./DataGrid";

type QRow = { id: string; name: string; rank: number };
const qRows: QRow[] = [
  { id: "1", name: "Alpha", rank: 3 },
  { id: "2", name: "Bravo", rank: 1 },
  { id: "3", name: "Charlie", rank: 2 },
];
const qColumns: DataGridColumn<QRow>[] = [
  { key: "name", label: "Name", accessor: (r) => r.name, searchValue: (r) => r.name },
];
const byRank = (a: QRow, b: QRow) => a.rank - b.rank;

const rowTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("tr[data-vrow]")].map((tr) => tr.textContent);

const draw = (storageKey: string, sortForSessionOnly: boolean) =>
  render(
    <DataGrid
      rows={qRows}
      columns={qColumns}
      storageKey={storageKey}
      rowKey={(r) => r.id}
      defaultSort={byRank}
      sortForSessionOnly={sortForSessionOnly}
    />,
  );

afterEach(() => {
  localStorage.clear();
});

describe("DataGrid sortForSessionOnly", () => {
  test("without it, a clicked header sort is remembered for the next visit (existing contract)", () => {
    const first = draw("ds-remembered", false);
    fireEvent.click(screen.getByRole("button", { name: "Name" })); // asc
    first.unmount();
    expect(rowTexts(draw("ds-remembered", false).container)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("with it, a header still sorts this visit, and the next visit opens on the default again", () => {
    const first = draw("ds-session", true);
    fireEvent.click(screen.getByRole("button", { name: "Name" })); // asc
    expect(rowTexts(first.container)).toEqual(["Alpha", "Bravo", "Charlie"]);
    first.unmount();
    expect(rowTexts(draw("ds-session", true).container)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  test("with it, a sort saved before the grid opted in is not applied on open", () => {
    const saved = draw("ds-stale", false);
    const header = screen.getByRole("button", { name: "Name" });
    fireEvent.click(header); // asc
    fireEvent.click(header); // desc — saved, the shape a user's browser already holds
    saved.unmount();
    expect(rowTexts(draw("ds-stale", true).container)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });
});
