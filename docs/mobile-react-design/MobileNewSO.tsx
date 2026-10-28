import { useState } from 'react';
import { SalesOrder } from './types';

// MobileNewSO — create / edit a Sales Order. Same form body as MobileSODetail, but
// fields start editable (.fld-i). Maps to prototype: #so-new (mode 'new' | 'edit' | 'edit-draft').
// Action bar: new/edit-draft -> [Save draft][Create Sales Order]; edit -> [Save changes][Cancel Order].

export interface MobileNewSOProps {
  mode: 'new' | 'edit' | 'edit-draft';
  order?: Partial<SalesOrder>;      // prefill when editing
  onCancel: () => void;
  onSaveDraft: () => void;
  onSubmit: () => void;
}

export function MobileNewSO({ mode, order = {}, onCancel, onSaveDraft, onSubmit }: MobileNewSOProps) {
  const title = mode === 'edit' ? `Edit ${order.doc_no ?? ''}` : mode === 'edit-draft' ? 'Edit Draft' : 'New Sales Order';
  const F = ({ label, value, ph }: { label: string; value?: string; ph?: string }) => (
    <div className="fld"><span className="fld-l">{label}</span><input className="fld-i" defaultValue={value} placeholder={ph} /></div>
  );
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#767b6e', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <span className="badge" style={{ background: '#f4f6f3', color: '#767b6e' }}>Draft</span>
        </div>
        <div className="scr-title">{title}</div>
      </header>
      <div className="scroll">
        <div className="card"><div className="card-h"><span className="card-t">Customer</span></div><div className="card-b">
          <F label="Name *" value={order.customer_name} ph="Customer name" />
          <div style={{ display: 'flex', gap: 9 }}>
            <div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Phone *</span><div style={{ display: 'flex' }}><span style={{ display: 'flex', alignItems: 'center', padding: '0 8px', background: '#f4f6f3', border: '1px solid rgba(34,31,32,.16)', borderRight: 'none', borderRadius: '9px 0 0 9px', fontSize: 12, fontWeight: 700, color: '#767b6e' }}>+60</span><input className="fld-i" style={{ borderRadius: '0 9px 9px 0' }} placeholder="12-345 6789" /></div></div></div>
            <div style={{ flex: 1 }}><F label="Email *" ph="name@email.com" /></div>
          </div>
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><F label="Customer type" value="Retail" /></div><div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Salesperson</span><div className="fld-ro">{order.salesperson_name ?? 'Lim (me)'}</div></div></div></div>
          <F label="Customer SO ref" ph="Their PO / SO number" />
        </div></div>
        <div className="card"><div className="card-h"><span className="card-t">Order info</span></div><div className="card-b">
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><F label="Building type" value="Condominium" /></div><div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Venue</span><div className="fld-ro">{order.venue_name ?? 'KLCC · BIGHOME'}</div></div></div></div>
          <div style={{ display: 'flex', gap: 9 }}><div style={{ flex: 1 }}><F label="Processing date" ph="DDMMYYYY" /></div><div style={{ flex: 1 }}><F label="Delivery date" ph="DDMMYYYY" /></div></div>
          <F label="Note" ph="Internal note — SO detail only" />
        </div></div>
        <div className="card"><div className="card-h"><span className="card-t">Line items</span><span className="card-sub">1 line</span></div><div className="card-b">
          <div style={{ border: '1px solid #e3e6e0', borderRadius: 11, padding: 11, marginBottom: 9 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><div style={{ fontSize: 13, fontWeight: 700 }}>Oslo 3-seater</div><span style={{ color: '#b23a3a', fontSize: 16, cursor: 'pointer' }}>&times;</span></div>
            <div style={{ display: 'flex', gap: 9, marginTop: 8 }}><div style={{ flex: 1 }}><F label="Fabric" value="Charcoal" /></div><div style={{ flex: 1 }}><F label="Config" value="RHF chaise" /></div></div>
          </div>
          <button style={{ width: '100%', padding: 11, background: 'transparent', border: '1px dashed #16695f', borderRadius: 12, color: '#16695f', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>+ Add item</button>
        </div></div>
        {/* Payments — an SO can carry SEVERAL payments (deposit + balances). When
            opened from a scan, ONE payment row is seeded per scanned payment slip,
            each carrying its own slip. Sample: two seeded rows + add-more. */}
        <div className="card"><div className="card-h"><span className="card-t">Payments</span><span className="card-sub">2 payments</span></div><div className="card-b">
          {[
            { method: 'Cash', amount: '500.00', slip: 'Deposit slip' },
            { method: 'Merchant', amount: '950.00', slip: 'Balance slip' },
          ].map((p, i) => (
            <div key={i} style={{ border: '1px solid #e3e6e0', borderRadius: 11, padding: 11, marginBottom: 9 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 19, height: 19, borderRadius: 6, background: '#16695f', color: '#fff', fontSize: 10.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{p.method}</span>
                </div>
                <span style={{ color: '#b23a3a', fontSize: 16, cursor: 'pointer' }}>&times;</span>
              </div>
              <div style={{ display: 'flex', gap: 9, marginTop: 8 }}>
                <div style={{ flex: 1 }}><F label="Amount (RM)" value={p.amount} /></div>
                <div style={{ flex: 1 }}>
                  <div className="fld"><span className="fld-l">Slip</span>
                    <div style={{ height: 38, borderRadius: 9, border: '1px solid #bcdcd7', background: '#e1efed', color: '#16695f', fontSize: 11.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>{p.slip} &#10003;</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
          <button style={{ width: '100%', padding: 11, background: 'transparent', border: '1px dashed #16695f', borderRadius: 12, color: '#16695f', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>+ Add payment</button>
        </div></div>
      </div>
      <div className="actbar">
        {mode === 'edit'
          ? <><button className="btn" style={{ flex: 1 }} onClick={onSubmit}>Save changes</button><button className="btn btn-danger" style={{ flex: 1 }} onClick={onCancel}>Cancel Order</button></>
          : <><button className="btn btn-ghost" style={{ flex: 1 }} onClick={onSaveDraft}>Save draft</button><button className="btn" style={{ flex: 1.3 }} onClick={onSubmit}>Create Sales Order</button></>}
      </div>
    </div>
  );
}
