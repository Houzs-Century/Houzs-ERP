import { money } from './types';
import { Badge } from './MobileSoList';
import type { PlanStop } from './MobilePlanningStop';

// MobileDeliveryPlanning — driver/helper run-sheet (list). Maps to prototype: #m-planning.
// Tabs Today / Tomorrow / History. Row -> MobilePlanningStop. Drivers see balance only.

export interface MobileDeliveryPlanningProps {
  day: 'today' | 'tomorrow' | 'history';
  stops: PlanStop[];
  driver_name: string;
  helper_name: string;
  route_date: string;
  onOpenMenu: () => void;
  onChangeDay: (d: 'today' | 'tomorrow' | 'history') => void;
  onOpenStop: (seq: number) => void;
}

export function MobileDeliveryPlanning(p: MobileDeliveryPlanningProps) {
  const days: ['today' | 'tomorrow' | 'history', string][] = [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['history', 'History']];
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <button onClick={p.onOpenMenu} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: '#16695f', background: 'none', border: 'none', cursor: 'pointer' }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>Menu
          </button>
          <span className="eyebrow">Transportation</span>
        </div>
        <div className="scr-title">Delivery Planning</div>
        <div className="money" style={{ fontSize: 11.5, color: '#767b6e', marginTop: 2 }}>Monday · {p.route_date} · {p.driver_name} + {p.helper_name}</div>
        <div className="chips" style={{ marginTop: 10, display: 'flex', gap: 7 }}>
          {days.map(([v, l]) => <button key={v} className={'chip' + (p.day === v ? ' on' : '')} onClick={() => p.onChangeDay(v)}>{l}</button>)}
        </div>
      </header>
      <div className="scroll">
        {/* LIST START: planning_stops (in delivery sequence) */}
        {p.stops.map((s) => {
          const title = s.kind === 'project' ? s.project_title! : s.customer_name!;
          const sub = s.kind === 'service' ? s.case_no! : s.kind === 'project' ? s.ref_no! : s.doc_no!;
          const tag = s.kind === 'service' ? `Service · ${s.service_type}` : s.kind === 'project' ? s.fair_type! : s.house_type!;
          return (
            <div key={s.seq} className="card" style={{ cursor: 'pointer', padding: 13 }} onClick={() => p.onOpenStop(s.seq)}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ width: 26, height: 26, flex: 'none', borderRadius: '50%', background: '#16695f', color: '#fff', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s.seq}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: s.kind === 'project' ? 13 : 14, fontWeight: 800, color: '#11140f' }}>{title}</div>
                  <div className="money" style={{ fontSize: 11, color: '#767b6e' }}>{sub}</div>
                </div>
                <span className="badge" style={{ background: '#f6efd9', color: '#8a6a2e' }}>{s.time_window}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                <Badge status={s.status} />
                <span className="badge" style={{ background: '#f0f1ed', color: '#5c6156' }}>{tag}</span>
              </div>
              {s.kind !== 'project' && s.balance_centi != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 11, padding: '9px 11px', background: '#f3ece0', border: '1px solid #e8dcc5', borderRadius: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#8a6a2e' }}>Balance to collect</span>
                  <span className="money" style={{ fontSize: 16, fontWeight: 800, color: '#8a4b12' }}>{money(s.balance_centi)}</span>
                </div>
              )}
            </div>
          );
        })}
        {/* LIST END */}
        {p.stops.length === 0 && <div className="empty"><div className="empty-t">No stops</div><div className="empty-s">Nothing scheduled for this day.</div></div>}
      </div>
    </div>
  );
}
