/* The POS Admin menu's reads and writes (GET/PUT/POST/PATCH /api/pos-admin/*),
 * typed once here for every tab. Money is integer sen on the wire; the tabs
 * show RM. */
import { api } from "../../api/client";
import { useQuery, type QueryState } from "../../hooks/useQuery";
import { normalizePosSettings, type PosSettings, type PosSettingsGroup } from "../../vendor/shared/pos-settings";

export const POS_ADMIN = "/api/pos-admin";

export type PosBarcodeKind = "FACTORY" | "GENERATED" | "EXTRA";

export type PosItem = {
  id: number;
  product_id: string;
  item_code: string;
  name: string;
  category: string | null;
  uom: string;
  price_sen: number;
  cost_sen: number | null;
  preset_discount_type: "PCT" | "RM" | null;
  preset_discount_value: number | null;
  foc_allowed: boolean;
  max_manual_disc_pct: number | null;
  stock_source_warehouse_id: string | null;
  receipt_name: string | null;
  active: boolean;
  barcodes: { barcode: string; kind: PosBarcodeKind; id: number | null }[];
  stock_qty: number;
  sku_price_sen: number | null;
  event_prices: { project_id: number; price_sen: number }[];
  updated_at: string;
};

export type SkuCandidate = {
  product_id: string;
  code: string;
  name: string;
  category: string | null;
  barcode: string | null;
  sell_price_sen: number | null;
  cost_price_sen: number | null;
  stock_qty: number;
  pos_item_id: number | null;
  pos_active: boolean | null;
};

export type LabelRow = {
  product_id: string;
  code: string;
  name: string;
  category: string | null;
  factory_barcode: string | null;
  own_barcode: string | null;
  status: "FACTORY" | "GENERATED" | "NONE";
  sell_price_sen: number | null;
  is_pos_item: boolean;
};

export type PosCashier = {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  role: "PARTTIME" | "SUPERVISOR";
  max_discount_pct: number;
  working_hours_note: string | null;
  bank_note: string | null;
  active: boolean;
  last_login_at: string | null;
  events: { project_id: number; name: string }[];
  created_at: string;
};

export type PosEventLink = {
  id: number;
  catalog_scope: "ALL" | "PICK";
  stock_source_warehouse_id: string | null;
  sst_default: boolean;
  receipt_header: string | null;
  catalog_version: number;
  pushed_at: string | null;
  cashiers: { id: number; name: string; code: string }[];
  item_ids: number[];
  price_overrides: { pos_item_id: number; price_sen: number }[];
};

export type PosEvent = {
  project_id: number;
  code: string | null;
  name: string;
  start_date: string | null;
  end_date: string | null;
  venue: string | null;
  event_type_slug: string | null;
  event_type_name: string | null;
  type_label: string;
  status: "RUNNING" | "UPCOMING" | "ENDED" | "NOT LINKED";
  link: PosEventLink | null;
  terminals: { id: number; code: string; device_name: string | null; prepared_at: string | null; last_sync_at: string | null; active: boolean }[];
};

export type PosTerminal = {
  id: number;
  code: string;
  device_name: string | null;
  platform: string | null;
  project_id: number | null;
  project_name: string | null;
  printer: string | null;
  prepared_at: string | null;
  last_seen_at: string | null;
  last_sync_at: string | null;
  pending_count: number;
  pending_amount_sen: number;
  receipt_counter: number;
  app_version: string | null;
  status: string;
  active: boolean;
};

const list = <T,>(raw: unknown): T[] => (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data) ? ((raw as { data: T[] }).data) : []);

export const useAdminItems = (enabled = true): QueryState<PosItem[]> =>
  useQuery<PosItem[]>(`${POS_ADMIN}/items`, () => api.get<unknown>(`${POS_ADMIN}/items`).then(list<PosItem>), [], { enabled });

export const useAdminCashiers = (enabled = true): QueryState<PosCashier[]> =>
  useQuery<PosCashier[]>(`${POS_ADMIN}/cashiers`, () => api.get<unknown>(`${POS_ADMIN}/cashiers`).then(list<PosCashier>), [], { enabled });

export const useAdminEvents = (enabled = true): QueryState<PosEvent[]> =>
  useQuery<PosEvent[]>(`${POS_ADMIN}/events`, () => api.get<unknown>(`${POS_ADMIN}/events`).then(list<PosEvent>), [], { enabled });

export const useAdminTerminals = (enabled = true): QueryState<PosTerminal[]> =>
  useQuery<PosTerminal[]>(`${POS_ADMIN}/terminals`, () => api.get<unknown>(`${POS_ADMIN}/terminals`).then(list<PosTerminal>), [], { enabled });

export type SettingsResponse = { settings: PosSettings; updated: Partial<Record<PosSettingsGroup, string>> };

export const useAdminSettings = (enabled = true): QueryState<SettingsResponse> =>
  useQuery<SettingsResponse>(
    `${POS_ADMIN}/settings`,
    () =>
      api.get<unknown>(`${POS_ADMIN}/settings`).then((raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SettingsResponse>;
        return { settings: normalizePosSettings((r.settings ?? {}) as Partial<Record<PosSettingsGroup, unknown>>), updated: r.updated ?? {} };
      }),
    [],
    { enabled },
  );

export type LabelsResponse = { total: number; page: number; data: LabelRow[] };

export const useAdminLabels = (search: string, missingOnly: boolean, page: number): QueryState<LabelsResponse> =>
  useQuery<LabelsResponse>(
    `${POS_ADMIN}/labels`,
    () => {
      const q = new URLSearchParams();
      if (search) q.set("search", search);
      if (missingOnly) q.set("missing", "1");
      q.set("page", String(page));
      return api.get<unknown>(`${POS_ADMIN}/labels?${q.toString()}`).then((raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LabelsResponse>;
        return { total: Number(r.total ?? 0), page: Number(r.page ?? 1), data: Array.isArray(r.data) ? r.data : [] };
      });
    },
    [search, missingOnly, page],
    { keepPreviousData: true },
  );

export const rm = (sen: number | null | undefined): string => (sen == null ? "" : (sen / 100).toFixed(2));
export const toSen = (rmText: string): number | null => {
  const n = Number(String(rmText).replace(/[^0-9.-]/g, ""));
  return rmText.trim() === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
};
