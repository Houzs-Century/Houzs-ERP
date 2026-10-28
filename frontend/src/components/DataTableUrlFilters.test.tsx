import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { DataTable, type Column } from "./DataTable";
import { parseUrlColFilters, serializeUrlColFilters } from "./dataTableUrlFilters";

/* Owner 2026-09-25: column filters live in the address, so a filtered list
   can be sent as a link. */

type Row = { id: string; party: string; status: string };
const rows: Row[] = [
  { id: "a", party: "Alpha", status: "Open" },
  { id: "b", party: "Bravo", status: "Paid" },
  { id: "c", party: "Charlie", status: "Open" },
];
const columns: Column<Row>[] = [
  { key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party },
  { key: "status", label: "Status", render: (r) => r.status, getValue: (r) => r.status },
];

const drawn = () => Array.from(document.querySelectorAll("tbody tr[data-vrow]")).map((tr) => tr.getAttribute("data-rowkey"));
const param = (id: string) => new URLSearchParams(window.location.search).get(`cf.${id}`);

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/list");
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

describe("URL column filters: encoding", () => {
  it("writes only the funnels that are set, and reads them back", () => {
    const s = serializeUrlColFilters({ status: ["Open"], party: [] });
    expect(s).toBe('{"status":["Open"]}');
    expect(parseUrlColFilters(s)).toEqual({ status: ["Open"] });
    expect(serializeUrlColFilters({ party: [] })).toBeNull();
  });

  it("a broken or odd link reads as no filter", () => {
    expect(parseUrlColFilters("{not json")).toBeNull();
    expect(parseUrlColFilters('["Open"]')).toBeNull();
    expect(parseUrlColFilters('{"status":[1,2]}')).toBeNull();
    expect(parseUrlColFilters(null)).toBeNull();
  });
});

describe("URL column filters: the table", () => {
  it("opens a link already filtered, and keeps the filter in the address", async () => {
    window.history.replaceState(null, "", `/list?cf.url-a=${encodeURIComponent('{"status":["Open"]}')}`);
    render(<DataTable tableId="url-a" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    await waitFor(() => expect(drawn()).toEqual(["a", "c"]));
    expect(param("url-a")).toBe('{"status":["Open"]}');
  });

  it("writes a funnel set on screen into the address", async () => {
    render(<DataTable tableId="url-b" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    fireEvent.click(screen.getByTitle("Filter & sort Status"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Paid/ }));
    await waitFor(() => expect(param("url-b")).toBe('{"status":["Paid"]}'));
  });

  it("leaves the address alone for a table with no filters", () => {
    render(<DataTable tableId="url-c" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(window.location.search).toBe("");
  });

  it("puts the funnels back when the page moves its own address (a tab click)", async () => {
    let go: (to: string) => void = () => undefined;
    const Tabs = () => { const nav = useNavigate(); go = nav; return null; };
    window.history.replaceState(null, "", `/list?cf.url-d=${encodeURIComponent('{"status":["Open"]}')}`);
    render(
      <BrowserRouter>
        <Tabs />
        <DataTable tableId="url-d" columns={columns} rows={rows} getRowKey={(r) => r.id} />
      </BrowserRouter>,
    );
    await waitFor(() => expect(drawn()).toEqual(["a", "c"]));
    // The router builds the new address from its own copy: the cf. param is gone...
    act(() => go("/list?tab=paid"));
    // ...and the table writes it back.
    await waitFor(() => expect(param("url-d")).toBe('{"status":["Open"]}'));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("paid");
  });
});
