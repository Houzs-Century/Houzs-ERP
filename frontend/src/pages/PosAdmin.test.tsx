/* The POS Admin page renders every tab on an empty company and on one with
   data, without a live backend: the reads are mocked at the hook layer. Pinned
   so a tab that throws on empty data, or on a row shape, is caught here and
   not at the owner's first click. */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import type { QueryState } from "../hooks/useQuery";
import { posSettingsDefaults } from "../vendor/shared/pos-settings";
import type { PosCashier, PosEvent, PosItem, PosTerminal, SettingsResponse } from "./pos-admin/posAdminApi";

const q = <T,>(data: T): QueryState<T> => ({ data, loading: false, fetching: false, placeholder: false, error: null, reload: () => {} });
let items: PosItem[] = [];
let cashiers: PosCashier[] = [];
let events: PosEvent[] = [];
let terminals: PosTerminal[] = [];

vi.mock("../api/client", () => ({ api: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(async () => ({})), patch: vi.fn(async () => ({})), put: vi.fn(async () => ({})), del: vi.fn(async () => ({})) } }));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));
vi.mock("../hooks/useDialog", () => ({ useDialog: () => ({ confirm: async () => true, prompt: async () => null }) }));
vi.mock("../vendor/scm/lib/inventory-queries", () => ({ useWarehouses: () => ({ data: [{ id: "w1", code: "KL", name: "KL Warehouse", is_active: true }] }) }));
vi.mock("./pos-admin/posAdminApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("./pos-admin/posAdminApi")>();
  return {
    ...real,
    useAdminItems: () => q(items),
    useAdminCashiers: () => q(cashiers),
    useAdminEvents: () => q(events),
    useAdminTerminals: () => q(terminals),
    useAdminSettings: () => q<SettingsResponse>({ settings: posSettingsDefaults(), updated: {} }),
    useAdminLabels: () => q({ total: 1, page: 1, data: [{ product_id: "p1", code: "PL-01", name: "Pillow", category: "ACCESSORY", factory_barcode: null, own_barcode: null, status: "NONE" as const, sell_price_sen: 5990, is_pos_item: false }] }),
  };
});

import { PosAdmin } from "./PosAdmin";

const mount = (tab: string) => render(<MemoryRouter initialEntries={[`/pos-admin?tab=${tab}`]}><PosAdmin /></MemoryRouter>);

const TABS = ["items", "labels", "cashiers", "events", "sst", "printer", "terminals", "general"];

describe("PosAdmin", () => {
  test("every tab renders on an empty company", () => {
    for (const tab of TABS) {
      const { unmount } = mount(tab);
      expect(screen.getByText("System · POS Admin")).toBeTruthy();
      unmount();
    }
    mount("items");
    expect(screen.getByText(/No POS items yet/)).toBeTruthy();
    expect(screen.getByText("Add from Inventory")).toBeTruthy();
  });

  test("the data tabs list their rows", () => {
    items = [{
      id: 1, product_id: "p1", item_code: "PL-01", name: "Pillow", category: "ACCESSORY", uom: "UNIT", price_sen: 5990, cost_sen: 2000,
      preset_discount_type: "PCT", preset_discount_value: 10, foc_allowed: true, max_manual_disc_pct: null, stock_source_warehouse_id: null, receipt_name: null,
      active: true, barcodes: [{ barcode: "9555000000019", kind: "FACTORY", id: null }], stock_qty: 12, sku_price_sen: 5990, event_prices: [{ project_id: 9, price_sen: 4990 }], updated_at: "2026-10-14T00:00:00Z",
    }];
    cashiers = [{ id: 1, code: "C01", name: "Aina", phone: "0123456789", role: "SUPERVISOR", max_discount_pct: 10, working_hours_note: null, bank_note: null, active: true, last_login_at: null, events: [{ project_id: 9, name: "AEON C&C" }], created_at: "2026-10-14T00:00:00Z" }];
    events = [{ project_id: 9, code: "HC-0099", name: "AEON C&C", start_date: "2026-10-10", end_date: "2026-10-20", venue: "AEON Tebrau", event_type_slug: "cash_carry", event_type_name: "Cash & Carry", type_label: "Cash & Carry", status: "RUNNING",
      link: { id: 1, catalog_scope: "ALL", stock_source_warehouse_id: null, sst_default: false, receipt_header: null, catalog_version: 2, pushed_at: null, cashiers: [{ id: 1, name: "Aina", code: "C01" }], item_ids: [], price_overrides: [{ pos_item_id: 1, price_sen: 4990 }] },
      terminals: [{ id: 1, code: "T01", device_name: "Tab A9", prepared_at: null, last_sync_at: null, active: true }] }];
    terminals = [{ id: 1, code: "T01", device_name: "Tab A9", platform: "Android tablet", project_id: 9, project_name: "AEON C&C", printer: null, prepared_at: null, last_seen_at: null, last_sync_at: null, pending_count: 3, pending_amount_sen: 12345, receipt_counter: 7, app_version: null, status: "NEW", active: true }];

    const a = mount("items");
    expect(screen.getByText("PL-01")).toBeTruthy();
    expect(screen.getByText("AUTO -10%")).toBeTruthy();
    expect(screen.getByText("RM 49.90")).toBeTruthy();
    a.unmount();

    const b = mount("cashiers");
    expect(screen.getByText("Aina")).toBeTruthy();
    expect(screen.getByText("SUPERVISOR")).toBeTruthy();
    expect(screen.getByText("AEON C&C")).toBeTruthy();
    b.unmount();

    const c = mount("events");
    expect(screen.getByText("RUNNING")).toBeTruthy();
    expect(screen.getByText("NOT PREPARED")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    fireEvent.click(screen.getByText("AEON C&C"));
    expect(screen.getByText("Cashiers assigned (= login tiles, max 8 shown)")).toBeTruthy();
    c.unmount();

    const d = mount("terminals");
    expect(screen.getByText("T01")).toBeTruthy();
    expect(screen.getByText("RM 123.45")).toBeTruthy();
    d.unmount();

    const e = mount("labels");
    expect(screen.getByText("NO BARCODE")).toBeTruthy();
    e.unmount();

    const f = mount("sst");
    expect(screen.getByText(/Live preview · 58 mm/)).toBeTruthy();
    expect(screen.getByText(/SALES INVOICE/)).toBeTruthy();
    f.unmount();

    mount("general");
    expect(screen.getByText("Cash")).toBeTruthy();
    expect(screen.getByText("QR / DuitNow")).toBeTruthy();
  });
});
