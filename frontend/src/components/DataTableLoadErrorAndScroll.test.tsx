import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataTable, type Column } from "./DataTable";

type Row = { id: string };
const columns: Column<Row>[] = [{ key: "id", label: "Id", render: (r) => r.id, getValue: (r) => r.id }];
const rows: Row[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 639px)" ? width < 640 : false,
      media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  localStorage.clear();
  /* jsdom has no CSS.escape; every browser does. */
  if (!(globalThis as { CSS?: { escape?: unknown } }).CSS?.escape) {
    (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v };
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
  if (originalInnerWidth) Object.defineProperty(window, "innerWidth", originalInnerWidth);
});

/* A list that failed to load showed "Failed to load" and the raw error with
   nothing to press (Conts-ERP #594): it now offers Retry, on the desktop table
   and the phone card view alike. */
describe("DataTable load error", () => {
  for (const [label, width] of [["desktop", 1280], ["phone", 375]] as const) {
    it(`offers a Retry that refetches the list (${label})`, async () => {
      setViewport(width);
      const qc = new QueryClient();
      const refetch = vi.spyOn(qc, "refetchQueries").mockResolvedValue(undefined);
      render(
        <QueryClientProvider client={qc}>
          <DataTable tableId={`load-error-${label}`} columns={columns} rows={[]} getRowKey={(r) => r.id} error="HTTP 503" />
        </QueryClientProvider>,
      );
      expect(screen.queryByText("Failed to load")).toBeNull();
      expect(screen.getByText("Couldn't load this list.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(refetch).toHaveBeenCalledWith({ type: "active" }));
    });
  }
});

/* Back to the Suppliers list scrolls to the supplier you opened. The app scrolls
   inside its <main> panel, not the window, so a row not drawn yet must be
   brought near through that panel (Conts-ERP #406). */
describe("DataTable scroll to a row that is not drawn yet", () => {
  it("scrolls the panel the table sits in, not the window", () => {
    setViewport(1280);
    const winScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = render(
      <main style={{ overflowY: "auto" }}>
        <DataTable tableId="scroll-to-row" columns={columns} rows={rows} getRowKey={(r) => r.id} scrollToRow={null} />
      </main>,
    );
    const main = view.container.querySelector("main") as HTMLElement;
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 600 });
    view.rerender(
      <main style={{ overflowY: "auto" }}>
        <DataTable tableId="scroll-to-row" columns={columns} rows={rows} getRowKey={(r) => r.id} scrollToRow={{ key: "80", nonce: 2 }} />
      </main>,
    );
    expect(main.scrollTop).toBeGreaterThan(0);
    expect(winScroll).not.toHaveBeenCalled();
  });
});
