import { SalesOrder, money } from './types';

// MobileSoList — Sales Orders list. Data: SalesOrder[] (subset of fields used below).
// Maps to prototype screen: #so-list.
//
// Owner-locked 4-line SO card (mirrors the shipped frontend/src/mobile/MobileSalesOrders.tsx):
//   L1  {customer name} + {phone}                 ·  {status badge}
//   L2  {SO-no} · {ref}  (values only, no labels)  ·  {warehouse name, far right}
//   L3  Processing {date} -> Delivery {date}       ·  [Stock chip][Planning chip]
//   L4  Balance {amount}                           ·  {total, bold}
// NO customer-state line.

const statusColor: Record<string, [string, string]> = {
  Draft: ['#f4f6f3', '#767b6e'], Submitted: ['#e1efed', '#0c3f39'],
  Confirmed: ['#e2f0e9', '#2f8a5b'], Cancelled: ['#f8eaea', '#b23a3a'],
};

export function Badge({ status }: { status: string }) {
  const c = statusColor[status] ?? ['#f4f6f3', '#767b6e'];
  return <span className="badge" style={{ background: c[0], color: c[1] }}>{status}</span>;
}

// Small pill for the Stock / Delivery-planning chips on Line 3. Tones match the
// shipped card's b-green / b-amber / b-red / b-grey badge palette.
type ChipTone = 'green' | 'amber' | 'red' | 'grey';
const chipColor: Record<ChipTone, [string, string]> = {
  green: ['#e2f0e9', '#2f8a5b'], amber: ['#fbf0dc', '#9a6a12'],
  red: ['#f8eaea', '#b23a3a'], grey: ['#f4f6f3', '#767b6e'],
};
function MiniChip({ tone, label }: { tone: ChipTone; label: string }) {
  const c = chipColor[tone];
  return <span className="badge" style={{ background: c[0], color: c[1] }}>{label}</span>;
}

// Stock chip — Ready (green) when every non-cancelled line is stocked, else Pending (grey).
function StockChip({ ready }: { ready: boolean }) {
  return <MiniChip tone={ready ? 'green' : 'grey'} label={ready ? 'Ready' : 'Pending'} />;
}

// Delivery-planning chip — 4 states: Pending schedule = amber, Pending delivery = grey,
// Overdue = red, Delivered = green.
type PlanningState = 'PENDING_SCHEDULE' | 'PENDING_DELIVERY' | 'OVERDUE' | 'DELIVERED';
function PlanningChip({ state }: { state: PlanningState }) {
  if (state === 'DELIVERED') return <MiniChip tone="green" label="Delivered" />;
  if (state === 'OVERDUE') return <MiniChip tone="red" label="Overdue" />;
  if (state === 'PENDING_SCHEDULE') return <MiniChip tone="amber" label="Pending schedule" />;
  return <MiniChip tone="grey" label="Pending delivery" />;
}

// The list row extends SalesOrder with the fields the shipped card renders that
// live outside the base type: warehouse name, stock-ready aggregate, and the
// delivery-planning state.
type SoListRow = SalesOrder & {
  warehouse_name: string;
  is_fully_ready: boolean;
  planning_state: PlanningState;
};

export interface MobileSoListProps {
  orders: SoListRow[];
  onOpenMenu: () => void;
  onNew: () => void;
  onOpen: (doc_no: string) => void;
}

const MOCK: SoListRow[] = [
  {
    doc_no: 'SO-2406-0231', status: 'Confirmed', customer_name: 'Tan Residence',
    phone: '012-345 6789', email: '', customer_type: '', salesperson_name: '',
    customer_so_no: 'PO-8841', building_type: '', venue_name: '',
    processing_date: '12 Jun', customer_delivery_date: '20 Jun',
    sales_location: '', note: '', address1: '', address2: '', city: '',
    customer_state: 'Selangor', postcode: '', total_centi: 1289000, paid_centi: 644500,
    items: [], payments: [],
    warehouse_name: 'Shah Alam', is_fully_ready: true, planning_state: 'PENDING_SCHEDULE',
  },
  {
    doc_no: 'SO-2406-0230', status: 'Submitted', customer_name: 'Lim Wei Siang',
    phone: '019-887 2210', email: '', customer_type: '', salesperson_name: '',
    customer_so_no: 'REF-2231', building_type: '', venue_name: '',
    processing_date: '08 Jun', customer_delivery_date: '15 Jun',
    sales_location: '', note: '', address1: '', address2: '', city: '',
    customer_state: 'Kuala Lumpur', postcode: '', total_centi: 458000, paid_centi: 0,
    items: [], payments: [],
    warehouse_name: 'Puchong', is_fully_ready: false, planning_state: 'PENDING_DELIVERY',
  },
  {
    doc_no: 'SO-2405-0198', status: 'Confirmed', customer_name: 'Sunrise Hotel Group',
    phone: '03-2201 5566', email: '', customer_type: '', salesperson_name: '',
    customer_so_no: 'SH-0044', building_type: '', venue_name: '',
    processing_date: '28 May', customer_delivery_date: '05 Jun',
    sales_location: '', note: '', address1: '', address2: '', city: '',
    customer_state: 'Johor', postcode: '', total_centi: 3240000, paid_centi: 3240000,
    items: [], payments: [],
    warehouse_name: 'Shah Alam', is_fully_ready: true, planning_state: 'OVERDUE',
  },
  {
    doc_no: 'SO-2405-0187', status: 'Confirmed', customer_name: 'Wong Family',
    phone: '016-778 9012', email: '', customer_type: '', salesperson_name: '',
    customer_so_no: '', building_type: '', venue_name: '',
    processing_date: '15 May', customer_delivery_date: '22 May',
    sales_location: '', note: '', address1: '', address2: '', city: '',
    customer_state: 'Penang', postcode: '', total_centi: 875000, paid_centi: 875000,
    items: [], payments: [],
    warehouse_name: 'Puchong', is_fully_ready: true, planning_state: 'DELIVERED',
  },
];

export function MobileSoList({ orders = MOCK, onOpenMenu, onNew, onOpen }: MobileSoListProps) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div className="eyebrow">Supply chain</div><div className="scr-title">Sales Orders</div></div>
          <button className="iconbtn" onClick={onNew} aria-label="New sales order">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
          <div className="searchbar" style={{ flex: 1 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input placeholder="Search customer · SO · reference" />
          </div>
          <button className="iconbtn" aria-label="Filter" onClick={onOpenMenu}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
          </button>
        </div>
      </header>
      <div className="scroll">
        {/* LIST START: sales_orders — one row per record */}
        {orders.map((r) => {
          const balance_centi = r.total_centi - r.paid_centi;
          const ref = r.customer_so_no;
          const warehouse = r.warehouse_name?.trim() || '—';
          return (
            <div key={r.doc_no} className="card" style={{ cursor: 'pointer', padding: '12px 13px' }} onClick={() => onOpen(r.doc_no)}>
              {/* Line 1 — customer name + phone / status badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: '#11140f' }}>{r.customer_name}</span>
                  {r.phone ? <span style={{ fontSize: 12, fontWeight: 600, color: '#16695f', marginLeft: 7 }}>{r.phone}</span> : null}
                </span>
                <Badge status={r.status} />
              </div>
              {/* Line 2 — SO-no · ref (values only) / warehouse far right (no icon) */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
                <span className="money" style={{ fontSize: 11.5, color: '#767b6e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.doc_no}{ref ? ` · ${ref}` : ''}</span>
                <span style={{ fontSize: 11.5, color: '#9aa093', fontWeight: 600, whiteSpace: 'nowrap', flex: 'none' }}>{warehouse}</span>
              </div>
              {/* Line 3 — Processing -> Delivery / stock + planning chips */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, fontSize: 11, color: '#414539', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  <span style={{ color: '#9aa093', fontWeight: 600 }}>Processing</span>
                  <span className="money" style={{ fontWeight: 600 }}>{r.processing_date}</span>
                  <span style={{ color: '#c2c6bd' }}>&rarr;</span>
                  <span style={{ color: '#9aa093', fontWeight: 600 }}>Delivery</span>
                  <span className="money" style={{ fontWeight: 600 }}>{r.customer_delivery_date}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 'none' }}>
                  <StockChip ready={r.is_fully_ready} />
                  <PlanningChip state={r.planning_state} />
                </span>
              </div>
              {/* Line 4 — Balance / total */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 9, paddingTop: 9, borderTop: '1px solid #f0f1ed' }}>
                <span style={{ fontSize: 10.5, color: '#9aa093' }}>Balance <span className="money" style={{ color: balance_centi > 0 ? '#414539' : '#9aa093', fontWeight: 700 }}>{money(balance_centi)}</span></span>
                <span className="money" style={{ fontSize: 17, fontWeight: 800, color: '#0c3f39' }}>{money(r.total_centi)}</span>
              </div>
            </div>
          );
        })}
        {/* LIST END */}
        {orders.length === 0 && (
          <div className="empty"><div className="empty-t">No sales orders</div><div className="empty-s">No orders in this range. Tap + to create one.</div></div>
        )}
      </div>
    </div>
  );
}
