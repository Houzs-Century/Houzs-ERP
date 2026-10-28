import { useState } from 'react';
import { Badge } from './MobileSoList';

// MobilePOD — Proof of Delivery capture. Maps to prototype: #pod.
export interface PodLine { description: string; qty: number; }
export function MobilePOD({ doc_no, customer_name, status, lines, onBack, onConfirm }:
  { doc_no: string; customer_name: string; status: string; lines: PodLine[]; onBack: () => void; onConfirm: () => void }) {
  const [captured, setCaptured] = useState(false);
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; Delivery Orders</button>
          <Badge status={status} />
        </div>
        <div className="scr-title">Proof of Delivery</div>
        <div className="money" style={{ fontSize: 11.5, color: '#767b6e', marginTop: 2 }}>{doc_no} · {customer_name}</div>
      </header>
      <div className="scroll">
        <div className="fld-l" style={{ marginBottom: 8 }}>Items to deliver · {lines.length}</div>
        {lines.map((l, i) => (
          <div key={i} className="card" style={{ padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, border: '1.5px solid #16695f', flex: 'none' }} />
            <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 700 }}>{l.description}</div><div className="money" style={{ fontSize: 11, color: '#767b6e' }}>&times;{l.qty}</div></div>
          </div>
        ))}
        <div className="fld-l" style={{ margin: '16px 0 8px' }}>Delivery photos</div>
        <div style={{ display: 'flex', gap: 9 }}>
          <button onClick={() => setCaptured(true)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: '#16695f', border: 'none', borderRadius: 13, padding: 14, color: '#fff', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>Take photo
          </button>
          <div style={{ flex: 1, borderRadius: 13, minHeight: 70, background: captured ? 'linear-gradient(135deg,#d7ded6,#c7d0c4)' : 'linear-gradient(135deg,#eceee9,#e3e6e0)' }} />
        </div>
      </div>
      <div className="actbar"><button className="btn" style={{ opacity: captured ? 1 : .5 }} disabled={!captured} onClick={onConfirm}>Confirm delivered &rarr;</button></div>
    </div>
  );
}
