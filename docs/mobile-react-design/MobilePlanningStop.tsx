import { useState } from 'react';
import { money } from './types';
import { Badge } from './MobileSoList';

// MobilePlanningStop — Delivery Planning stop detail. ONE component, three kinds.
// Maps to prototype: #plan-detail (kind = 'delivery' | 'service' | 'project').
// Tracking is always On the way -> Arrived -> POD photo (completion). Drivers see
// balance_centi ONLY (never total). Project (Setup/Dismantle Fair) has NO balance.

export interface StopLine { item_code: string; description: string; variants: string; qty: number; }
export interface PlanStop {
  seq: number;
  kind: 'delivery' | 'service' | 'project';
  status: 'Scheduled' | 'On the way' | 'Arrived' | 'Delivered' | 'Late';
  time_window: string;        // "09:00-10:00"
  route_date: string;         // DDMMYYYY
  driver_name: string;
  helper_name: string;
  phone: string;
  postcode: string;
  // delivery / service
  customer_name?: string;
  address?: string;
  house_type?: string;
  // delivery
  doc_no?: string;            // DO no
  move_type?: string;
  balance_centi?: number;     // shown for delivery/service only
  items?: StopLine[];
  // service
  case_no?: string;
  service_type?: 'Pickup' | 'Delivery';
  problem?: string;
  solution?: string;
  product?: { item_code: string; description: string; variants: string };
  // project
  project_title?: string;
  fair_type?: 'Setup Fair' | 'Dismantle Fair';
  ref_no?: string;
  venue_name?: string;
  organizer?: string;
  site_pic?: string;
}

const svg = (d: string) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />;

export function MobilePlanningStop({ stop, onBack }: { stop: PlanStop; onBack: () => void }) {
  // 0 scheduled, 1 on the way, 2 arrived, 3 done — start from current status
  const initial = stop.status === 'Delivered' ? 3 : stop.status === 'Arrived' ? 2 : stop.status === 'On the way' ? 1 : 0;
  const [step, setStep] = useState(initial);
  const title = stop.kind === 'project' ? stop.project_title! : stop.customer_name!;
  const doneLabel = stop.kind === 'project' ? 'Complete' : stop.kind === 'service' && stop.service_type === 'Pickup' ? 'Collected' : 'Delivered';

  const Row = ({ l, v }: { l: string; v: string }) => <div className="row"><span className="row-l">{l}</span><span className="row-v money">{v}</span></div>;

  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; Delivery Planning</button>
          <Badge status={stop.status} />
        </div>
        <div className="scr-title" style={{ fontSize: stop.kind === 'project' ? 16 : 20, marginTop: 6 }}>{title}</div>
      </header>

      <div className="scroll">
        {/* Call + Navigate */}
        <div style={{ display: 'flex', gap: 9, marginBottom: 12 }}>
          <a href={`tel:${stop.phone}`} style={{ flex: 1, textAlign: 'center', padding: 11, border: '1px solid #d6d9d2', borderRadius: 11, background: '#fff', color: '#16695f', fontSize: 12.5, fontWeight: 700, textDecoration: 'none' }}>Call {stop.kind === 'project' ? 'PIC' : 'customer'}</a>
          <button className="btn btn-ghost" style={{ flex: 1 }}>Navigate</button>
        </div>

        {stop.kind === 'delivery' && (
          <>
            <div className="card"><div className="card-h"><span className="card-t">Delivery</span></div>
              <Row l="Window" v={`${stop.time_window} · ${stop.route_date}`} />
              <Row l="House type" v={stop.house_type!} />
              <Row l="Move" v={stop.move_type!} />
              <Row l="Address" v={`${stop.address} ${stop.postcode}`} />
              <Row l="Driver / Helper" v={`${stop.driver_name} / ${stop.helper_name}`} />
            </div>
            <div className="card"><div className="card-h"><span className="card-t">Goods to deliver</span><span className="card-sub">{stop.items!.length} line{stop.items!.length > 1 ? 's' : ''}</span></div>
              {stop.items!.map((it, i) => (
                <div key={i} style={{ padding: '11px 13px', borderTop: i ? '1px solid #eceee9' : 'none' }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{it.description}</div>
                  <div style={{ fontSize: 11.5, color: '#767b6e' }}>{it.variants}</div>
                  <div className="money" style={{ fontSize: 10, color: '#9aa093', marginTop: 2 }}>SKU {it.item_code} · &times;{it.qty}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {stop.kind === 'service' && (
          <>
            <div className="card"><div className="card-h"><span className="card-t">Service · {stop.service_type}</span></div>
              <Row l="Window" v={`${stop.time_window} · ${stop.route_date}`} />
              <Row l="Case" v={stop.case_no!} />
              <Row l="Address" v={`${stop.address} ${stop.postcode}`} />
            </div>
            <div style={{ background: '#fbf2f2', border: '1px solid #f0d9d9', borderRadius: 12, padding: '12px 13px', marginBottom: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: '#b23a3a', marginBottom: 5 }}>Reported problem</div>
              <div style={{ fontSize: 12.5, color: '#3f2626', lineHeight: 1.5 }}>{stop.problem}</div>
            </div>
            <div style={{ background: '#f1f7f4', border: '1px solid #cfe6dc', borderRadius: 12, padding: '12px 13px', marginBottom: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', color: '#2f8a5b', marginBottom: 5 }}>Resolution / action</div>
              <div style={{ fontSize: 12.5, color: '#20402f', lineHeight: 1.5 }}>{stop.solution}</div>
            </div>
            <div className="card"><div className="card-h"><span className="card-t">Product under service</span></div>
              <div style={{ padding: '11px 13px' }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{stop.product!.description}</div>
                <div style={{ fontSize: 11.5, color: '#767b6e' }}>{stop.product!.variants}</div>
                <div className="money" style={{ fontSize: 10, color: '#9aa093', marginTop: 2 }}>SKU {stop.product!.item_code}</div>
              </div>
            </div>
          </>
        )}

        {stop.kind === 'project' && (
          <>
            <div className="card"><div className="card-h"><span className="card-t">{stop.fair_type}</span></div>
              <Row l="Window" v={`${stop.time_window} · ${stop.route_date}`} />
              <Row l="Venue" v={stop.venue_name!} />
              <Row l="Organizer" v={stop.organizer!} />
              <Row l="Site PIC" v={stop.site_pic!} />
              <Row l="Reference" v={stop.ref_no!} />
            </div>
            <div className="card"><div className="card-h"><span className="card-t">Site drawings</span><span className="card-sub">confirm position</span></div>
              {['Floor plan', '3D drawing', 'Layout drawing'].map((d) => (
                <div key={d} className="row" style={{ cursor: 'pointer' }}><span className="row-v" style={{ color: '#16695f' }}>{d}</span><span style={{ color: '#16695f' }}>&rsaquo;</span></div>
              ))}
            </div>
            <div className="card"><div className="card-h"><span className="card-t">{stop.fair_type === 'Dismantle Fair' ? 'Dismantle photos' : 'Setup photos'}</span><span className="card-sub">POD · upload on site</span></div>
              <div style={{ padding: '12px 13px', display: 'flex', gap: 8 }}>
                <div style={{ width: 64, height: 64, border: '1.5px dashed #c2c6bd', borderRadius: 11, background: '#f8f9f6' }} />
                <div style={{ width: 64, height: 64, borderRadius: 11, background: 'linear-gradient(135deg,#eceee9,#e3e6e0)' }} />
              </div>
            </div>
          </>
        )}

        {/* Balance — delivery/service only, never project */}
        {stop.kind !== 'project' && stop.balance_centi != null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', background: '#f3ece0', border: '1px solid #e8dcc5', borderRadius: 12, marginBottom: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#8a6a2e' }}>Balance to collect</span>
            <span className="money" style={{ fontSize: 16, fontWeight: 800, color: '#8a4b12' }}>{money(stop.balance_centi)}</span>
          </div>
        )}

        {/* Tracking: On the way -> Arrived -> POD */}
        <div className="card"><div className="card-h"><span className="card-t">{stop.kind === 'project' ? 'Site tracking' : 'Delivery tracking'}</span><span className="card-sub">On the way &rarr; Arrived &rarr; POD</span></div>
          <div style={{ padding: '12px 13px' }}>
            {step >= 1 && <div style={{ fontSize: 12.5, fontWeight: 700, padding: '6px 0' }}>&#10003; On the way</div>}
            {step >= 2 && <div style={{ fontSize: 12.5, fontWeight: 700, padding: '6px 0', borderTop: '1px solid #eceee9' }}>&#10003; Arrived</div>}
            {step >= 3 && <div style={{ fontSize: 12.5, fontWeight: 700, padding: '6px 0', borderTop: '1px solid #eceee9' }}>&#10003; {doneLabel} — POD uploaded</div>}
            {step === 0 && <button className="btn btn-ghost" style={{ marginTop: 6 }} onClick={() => setStep(1)}>Start — I'm on the way</button>}
            {step === 1 && <button className="btn btn-ghost" style={{ marginTop: 6 }} onClick={() => setStep(2)}>Mark arrived</button>}
            {step === 2 && <button className="btn" style={{ marginTop: 6 }} onClick={() => setStep(3)}>Take POD photo — complete</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
