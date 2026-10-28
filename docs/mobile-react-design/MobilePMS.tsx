import { useState } from 'react';
import { money } from './types';
import { Badge } from './MobileSoList';

// MobilePMS — Project (PMS) detail. Rich. Maps to prototype: #project.
// Dark header. 9-stage pipeline (h-scroll). Setup & Dismantle are SEPARATE, each with
// driver + contact + time + vehicle. Floor plans clickable. P&L role-gated (finance_visible prop).

export interface PmsProject {
  title: string;
  stage: 'Planning' | 'Live' | 'Settled';
  start_date: string; end_date: string;   // DDMMYYYY
  venue: string; organizer: string; branding: string;
  pic_name: string; sales_attending: string;
  setup: { driver: string; contact: string; time: string; vehicle: string };
  dismantle: { driver: string; contact: string; time: string; vehicle: string };
  revenue_centi: number; cost_centi: number;   // margin_centi computed
}

const PIPELINE = ['Confirmed', 'Setup', 'Floorplan', '3D', 'Stocks Transfer', 'Setup/Dismantle', 'Filled Floorplan', 'Event Complete', 'Done'];

export function MobilePMS({ project, finance_visible = true, onBack }: { project: PmsProject; finance_visible?: boolean; onBack: () => void }) {
  const [open, setOpen] = useState<string | null>('Setup & dismantle');
  const margin = project.revenue_centi - project.cost_centi;
  const Acc = ({ id, children }: { id: string; children: React.ReactNode }) => (
    <div className="card" style={{ padding: 0 }}>
      <button onClick={() => setOpen(open === id ? null : id)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 13px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <span className="card-t">{id}</span><span style={{ color: '#9aa093' }}>{open === id ? '\u2212' : '+'}</span>
      </button>
      {open === id && <div style={{ borderTop: '1px solid #eceee9', padding: '12px 13px' }}>{children}</div>}
    </div>
  );
  const Crew = ({ label, c }: { label: string; c: PmsProject['setup'] }) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: label === 'Dismantle' ? '#a16a2e' : '#16695f', marginBottom: 6 }}>{label}</div>
      <div className="row" style={{ padding: '6px 0' }}><span className="row-l">Driver &amp; contact</span><span className="row-v">{c.driver} ({c.contact})</span></div>
      <div className="row" style={{ padding: '6px 0' }}><span className="row-l">Start time</span><span className="row-v money">{c.time}</span></div>
      <div className="row" style={{ padding: '6px 0', borderBottom: 'none' }}><span className="row-l">Vehicle</span><span className="row-v">{c.vehicle}</span></div>
    </div>
  );
  return (
    <div className="hz-m screen">
      <header className="hdr" style={{ background: '#15161a', borderBottom: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#d8a85a', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; Projects</button>
          <Badge status={project.stage} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', marginTop: 6, lineHeight: 1.3 }}>{project.title}</div>
      </header>
      <div className="scroll">
        <div className="card"><div className="card-b">
          <div className="fld-l" style={{ marginBottom: 8 }}>Pipeline</div>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
            {PIPELINE.map((st, i) => <span key={st} style={{ flex: 'none', fontSize: 10, fontWeight: 700, padding: '5px 9px', borderRadius: 20, background: i < 2 ? '#e2f0e9' : '#f4f6f3', color: i < 2 ? '#2f8a5b' : '#9aa093' }}>{st}</span>)}
          </div>
        </div></div>
        <div className="card"><div className="card-h"><span className="card-t">Project</span></div>
          <div className="row"><span className="row-l">Dates</span><span className="row-v money">{project.start_date} – {project.end_date}</span></div>
          <div className="row"><span className="row-l">Venue</span><span className="row-v">{project.venue}</span></div>
          <div className="row"><span className="row-l">Organizer</span><span className="row-v">{project.organizer}</span></div>
          <div className="row"><span className="row-l">Branding</span><span className="row-v">{project.branding}</span></div>
        </div>
        <div className="card"><div className="card-h"><span className="card-t">Team</span></div>
          <div className="row"><span className="row-l">PIC</span><span className="row-v">{project.pic_name}</span></div>
          <div className="row"><span className="row-l">Sales attending</span><span className="row-v">{project.sales_attending}</span></div>
        </div>
        <Acc id="Setup & dismantle">
          <Crew label="Setup" c={project.setup} />
          <Crew label="Dismantle" c={project.dismantle} />
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <div style={{ width: 56, height: 56, borderRadius: 9, background: 'linear-gradient(135deg,#eceee9,#e3e6e0)' }} />
            <div style={{ width: 56, height: 56, borderRadius: 9, background: 'linear-gradient(135deg,#eceee9,#e3e6e0)' }} />
          </div>
        </Acc>
        <Acc id="Floor plans & layout">
          <button style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, background: '#15161a', border: 'none', borderRadius: 12, padding: '13px 14px', cursor: 'pointer', color: '#fff', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit' }}>3D floor plan &rsaquo;</button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 9 }}>
            <div style={{ border: '1px solid #d6d9d2', borderRadius: 11, overflow: 'hidden', cursor: 'pointer' }}><div style={{ height: 70, background: 'linear-gradient(135deg,#eceee9,#e3e6e0)' }} /><div style={{ padding: '7px 9px', fontSize: 11, fontWeight: 700 }}>Unfilled plan</div></div>
            <div style={{ border: '1px solid #d6d9d2', borderRadius: 11, overflow: 'hidden', cursor: 'pointer' }}><div style={{ height: 70, background: 'linear-gradient(135deg,#eceee9,#e3e6e0)' }} /><div style={{ padding: '7px 9px', fontSize: 11, fontWeight: 700 }}>Filled plan</div></div>
          </div>
        </Acc>
        {finance_visible && (
          <div className="card" style={{ border: '1px solid #e8dcc5', background: '#fbf7ef' }}>
            <div className="card-h" style={{ borderColor: '#efe3cd' }}><span className="card-t" style={{ color: '#8a4b12' }}>P&amp;L (finance)</span><span className="badge" style={{ background: '#f3ece0', color: '#a16a2e' }}>Owner / Director only</span></div>
            <div className="row" style={{ borderColor: '#efe3cd' }}><span className="row-l">Revenue</span><span className="row-v money">{money(project.revenue_centi)}</span></div>
            <div className="row" style={{ borderColor: '#efe3cd' }}><span className="row-l">Cost</span><span className="row-v money" style={{ color: '#8a4b12' }}>{money(project.cost_centi)}</span></div>
            <div className="row" style={{ borderBottom: 'none' }}><span className="row-l">Margin</span><span className="row-v money" style={{ color: '#2f8a5b' }}>{money(margin)}</span></div>
          </div>
        )}
      </div>
    </div>
  );
}
