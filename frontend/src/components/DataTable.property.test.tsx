import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { DataTable, type Column } from "./DataTable";

type Row = { id: string; party: string; ref: string | null };

const columns: Column<Row>[] = [
  { key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party },
  { key: "ref", label: "Customer ref", render: (r) => r.ref, getValue: (r) => r.ref ?? "" },
];

const word = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
const rowsArb = fc.uniqueArray(
  fc.record({ id: word, party: word, ref: fc.option(word, { nil: null }) }),
  { selector: (r) => r.id, maxLength: 12 },
);

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

describe("DataTable, any rows", () => {
  it("draws each row once, its text as given, and a dash for an empty cell", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const { container, unmount } = render(
          <DataTable tableId="property-rows" columns={columns} rows={rows} getRowKey={(r) => r.id} />,
        );
        try {
          for (const row of rows) {
            const drawn = container.querySelectorAll(`tr[data-rowkey="${row.id}"]`);
            expect(drawn).toHaveLength(1);
            expect(drawn[0].querySelector('td[data-col-key="party"]')?.textContent).toBe(row.party);
            expect(drawn[0].querySelector('td[data-col-key="ref"]')?.textContent).toBe(row.ref ?? "—");
          }
        } finally {
          unmount();
          localStorage.clear();
        }
      }),
      { numRuns: 25 },
    );
  });
});
