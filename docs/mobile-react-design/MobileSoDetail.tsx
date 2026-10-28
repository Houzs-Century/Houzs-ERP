import { useState } from 'react';
import { SalesOrder, money } from './types';
import { Badge } from './MobileSoList';
import { useConfirm } from './ConfirmDialog';

// MobileSoDetail — Sales Order detail.
// FIDELITY RULE: this IS the create form, rendered LOCKED (.fld-ro). Tapping Edit
// unlocks fields in place (.fld-ro -> .fld-i); action bar -> Discard / Save changes.
// KPI strip (Total / Paid / Balance) on top. Action bar depends on status.
// NEVER a separate summary screen. Maps to prototype screen: #so-detail (= #so-new locked).

export interface MobileSoDetailProps {
  order: SalesOrder;
  onBack: () => void;
  onIssueDo: (order: SalesOrder) => void;   // SO -> Delivery Order convert
  onCancelOrder: (order: SalesOrder) => void;
  onSaveChanges?: (order: SalesOrder) => void;
}

export function MobileSoDetail({ order, onBack, onIssueDo, onCancelOrder, onSaveChanges }: MobileSoDetailProps) {
  const [editing, setEditing] = useState(false);
  const { confirm, node: confirmNode } = useConfirm();
  const balance_centi = order.total_centi - order.paid_centi;

  // One field renderer: locked (.fld-ro) vs editable (.fld-i) — the whole "Edit" behaviour.
  const Field = ({ label, value }: { label: string; value: string }) => (
    <div className="fld">
      <span className="fld-l">{label}</span>
      {editing ? <input className="fld-i" defaultValue={value} /> : <div className="fld-ro">{value}</div>}
    </div>
  );

  const askCancel = () => confirm({
    title: 'Cancel this order?',
    body: `${order.doc_no} will be voided. This can't be undone.`,
    confirmLabel: 'Cancel order', destructive: true,
    onConfirm: () => onCancelOrder(order),
  });

  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn-ghost" style={{ border: 'none', background: 'none', padding: 0, color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }} onClick={onBack}>&lsaquo; Sales Orders</button>
          <Badge status={editing ? 'Draft' : order.status} />
        </div>
        <div className="eyebrow" style={{ marginTop: 7 }}>{order.doc_no} · {order.customer_so_no}</div>
        <div className="scr-title">{order.customer_name}</div>
      </header>

      <div className="scroll">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#eef1ec', border: '1px solid #e3e6e0', borderRadius: 10, padding: '9px 11px', marginBottom: 12, fontSize: 11, color: '#5c6156' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          {editing ? 'Editing — Save or discard below.' : 'Locked view — tap Edit to change. Same form as New SO.'}
        </div>

        {/* KPI strip */}
        <div style={{ display: 'flex', gap: 9, marginBottom: 12 }}>
          {([['Total', order.total_centi, '#0c3f39'], ['Paid', order.paid_centi, '#0c3f39'], ['Balance', balance_centi, '#b23a3a']] as [string, number, string][]).map(([l, v, col]) => (
            <div key={l} className="card" style={{ flex: 1, minWidth: 0, margin: 0 }}>
              <div className="card-b" style={{ padding: '10px 11px' }}>
                <span className="fld-l">{l}</span>
                <div className="money" style={{ fontSize: 14, fontWeight: 800, color: col, whiteSpace: 'nowrap', marginTop: 3 }}>{money(v)}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Customer */}
        <div className="card"><div className="card-h"><span className="card-t">Customer</span></div><div className="card-b">
          <Field label="Customer name" value={order.customer_name} />
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><Field label="Phone" value={order.phone} /></div><div style={{ flex: 1 }}><Field label="Email" value={order.email} /></div></div>
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><Field label="Customer type" value={order.customer_type} /></div><div style={{ flex: 1 }}><Field label="Salesperson" value={order.salesperson_name} /></div></div>
          <Field label="Customer SO ref" value={order.customer_so_no} />
        </div></div>

        {/* Order info */}
        <div className="card"><div className="card-h"><span className="card-t">Order info</span></div><div className="card-b">
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><Field label="Building type" value={order.building_type} /></div><div style={{ flex: 1 }}><Field label="Venue" value={order.venue_name} /></div></div>
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><Field label="Processing date" value={order.processing_date} /></div><div style={{ flex: 1 }}><Field label="Delivery date" value={order.customer_delivery_date} /></div></div>
          <Field label="Sales location" value={order.sales_location} />
          <Field label="Note" value={order.note} />
        </div></div>

        {/* Delivery address */}
        <div className="card"><div className="card-h"><span className="card-t">Delivery address</span></div><div className="card-b">
          <Field label="Address" value={`${order.address1}, ${order.address2}, ${order.city}, ${order.customer_state} ${order.postcode}`} />
        </div></div>

        {/* Line items */}
        <div className="card"><div className="card-h"><span className="card-t">Line items</span><span className="card-sub">{order.items.length} line{order.items.length > 1 ? 's' : ''}</span></div>
          {order.items.map((it, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '11px 13px', borderTop: i ? '1px solid #eceee9' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#11140f' }}>{it.description}</div>
                <div style={{ fontSize: 11.5, color: '#767b6e', marginTop: 2 }}>{it.variants}</div>
                <div className="money" style={{ fontSize: 10, color: '#9aa093', marginTop: 3 }}>SKU {it.item_code}</div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div className="money" style={{ fontSize: 13, fontWeight: 700, color: '#0c3f39' }}>{money(it.unit_price_centi * it.qty)}</div>
                <div className="money" style={{ fontSize: 11, color: '#767b6e', marginTop: 2 }}>&times;{it.qty}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Payments */}
        {/* Live build (changelog #69): this card header also carries a standalone
            "+ Add Payment" control on a SUBMITTED, non-cancelled SO that is not
            SHIPPED+/child-locked (paymentLocked) — reachable even when Edit is
            locked by the processing-date lock, because payment is never gated by
            the processing lock (desktop parity: PaymentsTable locked = isLocked
            only). Opens AddPaymentSheet → POST /:docNo/payments. Omitted from
            this simplified static mirror (no backend/mutations here). */}
        <div className="card"><div className="card-h"><span className="card-t">Payments</span><span className="card-sub">{order.payments.length}</span></div>
          {order.payments.length ? order.payments.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '11px 13px', borderTop: i ? '1px solid #eceee9' : 'none' }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{p.payment_method}</div>
                <div className="money" style={{ fontSize: 10.5, color: '#767b6e', marginTop: 2 }}>{p.payment_date} · {p.account_name} · {p.collected_by}</div>
                {p.approval_code && <div className="money" style={{ fontSize: 10, color: '#9aa093' }}>Approval {p.approval_code}</div>}
              </div>
              <div className="money" style={{ fontSize: 13, fontWeight: 700, color: '#0c3f39' }}>{money(p.amount_centi)}</div>
            </div>
          )) : <div style={{ padding: '11px 13px', fontSize: 11.5, color: '#9aa093' }}>No payments recorded</div>}
        </div>
      </div>

      {/* Action bar — status-dependent */}
      <div className="actbar">
        {editing ? (
          <>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditing(false)}>Discard</button>
            <button className="btn" style={{ flex: 1.4 }} onClick={() => { setEditing(false); onSaveChanges?.(order); }}>Save changes</button>
          </>
        ) : order.status === 'Draft' ? (
          <>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditing(true)}>Edit Draft</button>
            <button className="btn" style={{ flex: 1.3 }}>Create Sales Order</button>
          </>
        ) : order.status === 'Cancelled' ? (
          <div style={{ textAlign: 'center', fontSize: 11.5, color: '#9aa093', width: '100%' }}>This order was cancelled.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
            <button className="btn" onClick={() => onIssueDo(order)}>Issue Delivery Order</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditing(true)}>Edit</button>
              <button className="btn btn-danger" style={{ flex: 1 }} onClick={askCancel}>Cancel Order</button>
            </div>
          </div>
        )}
      </div>
      {confirmNode}
    </div>
  );
}
