import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

/* Owner 2026-11-17 (Trip Pay): a table scrolled under the pinned page header
   showed its header row ON TOP of the page title. The thead is z-30 and the
   PageHeader z-20, so the table box must be its own stacking context. */

type Row = { id: string };
const columns: Column<Row>[] = [{ key: "a", label: "A", render: () => "a", getValue: () => "a" }];

afterEach(cleanup);

describe("DataTable stacking", () => {
  it("keeps the sticky header inside an isolated table box", () => {
    render(<DataTable<Row> tableId="t-stacking" columns={columns} rows={[{ id: "1" }]} getRowKey={(r) => r.id} />);
    const box = document.querySelector("thead")?.closest("table")?.parentElement?.parentElement;
    expect(box?.className.split(/\s+/)).toContain("isolate");
  });
});
