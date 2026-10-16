// HC-0003: Sales, Service Cases and Activity log exported only the page on
// screen. Export now walks every page for the current filter.
import { expect, test } from "vitest";
import { fetchAllPages, toCSV } from "./csv";

const TOTAL = 451; // more than two 200-row pages

const fakeList = (filter: string) => {
  const calls: number[] = [];
  const fetchPage = async (page: number, perPage: number) => {
    calls.push(page);
    const ids = Array.from({ length: TOTAL }, (_, i) => i).slice((page - 1) * perPage, page * perPage);
    return { data: ids.map((id) => ({ id, filter })), total: TOTAL };
  };
  return { calls, fetchPage };
};

test("exported row count equals the filtered total", async () => {
  const { calls, fetchPage } = fakeList("status=draft");
  const rows = await fetchAllPages(fetchPage);
  expect(rows).toHaveLength(TOTAL);
  expect(new Set(rows.map((r) => r.id)).size).toBe(TOTAL);
  expect(calls).toEqual([1, 2, 3]);
  const csv = toCSV(rows, [{ key: "id", label: "ID", getValue: (r) => r.id }]);
  expect(csv.split("\r\n")).toHaveLength(TOTAL + 1); // header + rows
});

test("stops on an empty page even if total is stale", async () => {
  let n = 0;
  const rows = await fetchAllPages(async () => ({ data: n++ === 0 ? [{ id: 1 }] : [], total: 999 }));
  expect(rows).toHaveLength(1);
  expect(n).toBe(2);
});
