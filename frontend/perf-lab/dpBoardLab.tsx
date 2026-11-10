/* The Delivery Planning board at production size, in a real browser.
   `?scenario=dp-board&rows=3000` renders the REAL DeliveryPlanningBoard with
   3,000 generated orders (production has about 2,800) and its default 31-ish
   columns. `&limit=200` reproduces the old first-page "Load more" cap.

   The network is stubbed at `fetch`: every side query (staff, helpers,
   localities, row marks) answers an empty list, so the board renders from the
   rows alone. window.__lab drives what the 30 s change poll and the 2-minute
   re-read do to the rows; perf-lab/tests/dp-board.desktop.spec.ts times them. */
import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DeliveryPlanningBoard } from "../src/vendor/scm/components/DeliveryPlanningBoard";
import { ConfirmProvider } from "../src/vendor/scm/components/ConfirmDialog";
import { NotifyProvider } from "../src/vendor/scm/components/NotifyDialog";
import type { PlanningOrder } from "../src/vendor/scm/lib/delivery-planning-queries";

const STATES = ["PENDING_DELIVERY", "PENDING_SCHEDULE", "OVERDUE", "DELIVERED"] as const;
const REGIONS = ["CN", "NT", "ST", "EM", "SG"] as const;
const NAMES = ["Tan Ah Kow", "Lim Mei Ling", "Muthu Raj", "Siti Aminah", "Wong Kar Wai", "Lee Chong Wei"];

function day(offset: number): string {
  const d = new Date(Date.UTC(2026, 10, 10 + offset));
  return d.toISOString().slice(0, 10);
}

export function makeOrder(i: number): PlanningOrder {
  const region = REGIONS[i % REGIONS.length]!;
  const doc = `HC-SO-26${String(1 + (i % 12)).padStart(2, "0")}-${String(i).padStart(4, "0")}`;
  const due = i % 17 === 0 ? null : day((i % 120) - 30);
  return {
    row_type: "so", dp_job_type: null, dp_no: null, assr_id: null, ref: null, job_kind: null,
    so_doc_no: doc, debtor_code: `C${1000 + (i % 900)}`, debtor_name: `${NAMES[i % NAMES.length]} ${i}`,
    phone: `60${120000000 + i}`, agent: null, salesperson_id: null, venue: i % 3 ? "Mid Valley" : null,
    branding: i % 2 ? "HOUZS" : "2990", status: "OPEN", delivery_state: STATES[i % 4]!,
    delivery_state_override: null, delivery_message_status: null, disposal_request: null,
    dp_remark: i % 5 === 0 ? `Call before ${i % 12 + 1}pm, lift access only` : null,
    balance_sen: (i * 7919) % 500000, balance_sen_live: null, local_total_sen: 100000 + ((i * 104729) % 900000),
    so_date: day(-60 + (i % 50)), customer_delivery_date: due, ac_sales_exemption_expiry: null,
    sales_exemption_expiry: null, amend_date_from_customer: null, amended_delivery_date: null,
    amend_reason: null, amend_reason_from_customer: null, effective_delivery_date: due,
    processing_date: null, po_locked: false, days_left: due ? (i % 120) - 30 : null,
    address: `${i} Jalan Bukit ${i % 40}, Taman Indah`, postcode: String(40000 + (i % 9000)),
    building_type: i % 2 ? "Condo" : "Landed", possession_date: null, house_type: null,
    replacement_disposal: null, referral: null, so_ref: `pg${String(i).padStart(4, "0")}`,
    po_nos: i % 4 === 0 ? [`HC-PO-${i}`] : [], time_range: i % 3 ? "9am-12pm" : null,
    time_confirmed: i % 2 === 0, arrival_at: null, departure_at: null, shipout_date: null,
    customer_delivered_date: null, eta_arriving_port: null, delivery_substatus: null,
    arrives_em_warehouse_date: null, em_delivery_status: null, consignment_no: null, vessel_voyage: null,
    etd_port_klang: null, bs_delivery_date: null, esb_remarks: null, bs_remarks: null, ctn: null,
    em_delivered_date: null, do_date: null, has_pod: false, delivered_at: null,
    stock_status: i % 3 ? "READY" : "PARTIAL", stock_remark: i % 3 ? "All in stock" : "Waiting sofa",
    is_main_ready: i % 3 !== 0, is_ship_ready: i % 4 !== 0, company_code: "HC", remark_locked: false,
    region, regions: [region], warehouse_id: null, warehouse_code: "WH1", warehouse_name: "Klang",
    customer_state: "Selangor", customer_country: "MY", delivered_qty: 0, remaining_qty: 1 + (i % 6),
    crew: { driver: null, helper: null, lorry: null, lorry_plate: null },
    delivery_orders: i % 2 ? [{ id: `do${i}`, do_number: `HC-DO-${i}`, status: "OPEN" }] : [],
  } as unknown as PlanningOrder;
}

declare global {
  interface Window {
    __lab: { refetchSame(): void; refetchClone(): void; refreshOne(): void };
  }
}

const params = new URLSearchParams(window.location.search);
const ROWS = Number(params.get("rows") ?? 3000);
const LIMIT = params.get("limit") ? Number(params.get("limit")) : undefined;

function stubSideQueries() {
  const real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/")) {
      return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return real(input as RequestInfo, init);
  }) as typeof window.fetch;
}
if (params.get("scenario") === "dp-board") stubSideQueries();

const sched = { mutate: () => undefined, isPending: false } as unknown as Parameters<typeof DeliveryPlanningBoard>[0]["sched"];
const regionTabs = [{ key: "ALL", label: "All" }, ...REGIONS.map((r) => ({ key: r, label: r }))];
const noop = () => undefined;

export function DpBoardLab() {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [orders, setOrders] = useState<PlanningOrder[]>(() => Array.from({ length: ROWS }, (_, i) => makeOrder(i)));
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    window.__lab = {
      // A poll that found nothing: react-query's structural sharing hands back the SAME array.
      refetchSame: () => setOrders((p) => p),
      // A re-read whose payload equals the old one, WITHOUT structural sharing: every row a new object.
      refetchClone: () => setOrders((p) => p.map((o) => ({ ...o }))),
      // The 30 s poll re-read one changed order: one new row object, every other row the same.
      refreshOne: () => setOrders((p) => p.map((o, i) => (i === 3 ? { ...o, dp_remark: `edited ${Date.now()}` } : o))),
    };
  }, []);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: orders.length };
    for (const o of orders) c[o.delivery_state] = (c[o.delivery_state] ?? 0) + 1;
    return c;
  }, [orders]);
  return (
    <main data-scenario="dp-board">
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConfirmProvider>
            <NotifyProvider>
                <DeliveryPlanningBoard
                  orders={orders}
                  counts={counts}
                  regionTabs={regionTabs}
                  activeRegion="ALL"
                  onRegionChange={noop}
                  stateTabs={{ activeState: "ALL", onStateChange: noop }}
                  selectedKeys={sel}
                  onToggle={(k) => setSel((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                  onToggleAll={(keys, all) => setSel((p) => { const n = new Set(p); for (const k of keys) { if (all) n.delete(k); else n.add(k); } return n; })}
                  onClearSelection={() => setSel(new Set())}
                  sched={sched}
                  drivers={[]}
                  lorries={[]}
                  initialRowLimit={LIMIT}
                  storageKey="perf-dp-board"
                />
            </NotifyProvider>
          </ConfirmProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </main>
  );
}
