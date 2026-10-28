// MobileCalendar — month grid with brand/section/organizer filters. Maps to prototype: #calendar.
// Tapping a day cell with events (or a "+N more" overflow, or a holiday bar) opens a DaySheet
// bottom sheet listing that day's projects, tasks and public holidays.
import { useState } from 'react';

export interface CalEvent {
  day: number;
  kind: 'project' | 'task' | 'holiday';
  status: 'Confirmed' | 'Pending' | 'Cancelled' | null;
  title: string;
  sub?: string | null;
  organizer?: string | null;
}
const BAR: Record<string, string> = { Confirmed: '#2f8a5b', Pending: '#cf9a2e', Cancelled: '#b23a3a' };
const TASK_COLOR = '#a16a2e';
const HOLIDAY_COLOR = '#7a5c86';
const barColor = (e: CalEvent) =>
  e.kind === 'holiday' ? HOLIDAY_COLOR : e.kind === 'task' ? TASK_COLOR : BAR[e.status || 'Confirmed'];

// Sample data — a few projects, a task, and a public holiday for the designer to eyeball.
const SAMPLE_EVENTS: CalEvent[] = [
  { day: 3, kind: 'project', status: 'Confirmed', title: '[HOUZS] Skyline Wedding', sub: 'Grand Ballroom', organizer: 'Amelia Tan' },
  { day: 8, kind: 'project', status: 'Pending', title: '[HOUZS] Corporate Gala', sub: 'KLCC Hall 3', organizer: 'Ravi Kumar' },
  { day: 12, kind: 'project', status: 'Confirmed', title: '[HOUZS] Garden Party', sub: 'Botanical Lawn', organizer: 'Amelia Tan' },
  { day: 12, kind: 'project', status: 'Cancelled', title: '[HOUZS] Product Launch', sub: 'Atrium', organizer: 'Ravi Kumar' },
  { day: 12, kind: 'task', status: null, title: 'Task · Confirm floral order', sub: 'PRJ-0142' },
  { day: 12, kind: 'project', status: 'Pending', title: '[HOUZS] Charity Dinner', sub: 'Riverside Marquee', organizer: 'Lim Wei' },
  { day: 21, kind: 'project', status: 'Confirmed', title: '[HOUZS] Anniversary Party', sub: 'Rooftop Terrace', organizer: 'Lim Wei' },
  { day: 24, kind: 'holiday', status: null, title: 'National Day', sub: 'Public holiday' },
];

export function MobileCalendar({ month_label, events = SAMPLE_EVENTS, onOpenMenu, onPrev, onNext }:
  { month_label: string; events?: CalEvent[]; onOpenMenu: () => void; onPrev: () => void; onNext: () => void }) {
  const [mode, setMode] = useState<'Month' | 'Week'>('Month');
  const [daySheet, setDaySheet] = useState<number | null>(null);
  const byDay: Record<number, CalEvent[]> = {};
  events.forEach((e) => { (byDay[e.day] = byDay[e.day] || []).push(e); });
  const days = Array.from({ length: 35 }, (_, i) => i - 2); // simple 5-week grid, offset demo
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onPrev} className="iconbtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2"><path d="M15 6l-6 6 6 6" /></svg></button>
          <div className="scr-title" style={{ flex: 1, textAlign: 'center' }}>{month_label}</div>
          <button onClick={onNext} className="iconbtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg></button>
        </div>
        <div style={{ display: 'flex', background: '#f4f6f3', border: '1px solid #d6d9d2', borderRadius: 9, padding: 3, marginTop: 10 }}>
          {(['Month', 'Week'] as const).map((m) => <span key={m} onClick={() => setMode(m)} style={{ flex: 1, textAlign: 'center', fontSize: 11.5, fontWeight: 700, padding: '5px 0', borderRadius: 6, cursor: 'pointer', background: mode === m ? '#16695f' : 'transparent', color: mode === m ? '#fff' : '#767b6e' }}>{m}</span>)}
        </div>
        {/* Filters — brand on its own row, section + organizer share a row (native selects hold many dynamic values). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 9 }}>
          <select className="cal-sel" defaultValue="all" style={selStyle}>
            <option value="all">All brands</option>
          </select>
          <div style={{ display: 'flex', gap: 7 }}>
            <select className="cal-sel" defaultValue="all" style={{ ...selStyle, flex: 1 }}>
              <option value="all">All sections</option>
            </select>
            <select className="cal-sel" defaultValue="all" style={{ ...selStyle, flex: 1 }}>
              <option value="all">All organizers</option>
            </select>
          </div>
        </div>
        <div className="chips" style={{ marginTop: 9, display: 'flex', gap: 7 }}>
          <button className="chip" style={{ marginLeft: 'auto' }} onClick={onOpenMenu}>Menu</button>
        </div>
      </header>
      <div className="scroll">
        <div style={{ display: 'flex', gap: 14, marginBottom: 8, fontSize: 10.5 }}>
          {Object.entries(BAR).map(([k, c]) => <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />{k}</span>)}
        </div>
        <div style={{ border: '1px solid #e3e6e0', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', background: '#f4f6f3', fontSize: 9, fontWeight: 700, color: '#9aa093', textAlign: 'center' }}>
            {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => <div key={d} style={{ padding: '6px 0' }}>{d}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
            {days.map((d, i) => {
              const evs = d >= 1 && d <= 31 ? (byDay[d] || []) : [];
              const hasEvents = evs.length > 0;
              return (
                <div
                  key={i}
                  onClick={hasEvents ? () => setDaySheet(d) : undefined}
                  title={hasEvents ? "Tap to see this day's events" : undefined}
                  style={{ minHeight: 60, borderTop: '1px solid #eceee9', borderRight: (i % 7 !== 6) ? '1px solid #f0f1ed' : 'none', padding: 4, cursor: hasEvents ? 'pointer' : 'default' }}
                >
                  {d >= 1 && d <= 31 && <div style={{ fontSize: 10, fontWeight: 700, color: '#11140f' }}>{d}</div>}
                  {evs.slice(0, 2).map((e, j) => <div key={j} style={{ marginTop: 3, height: 5, borderRadius: 2, background: barColor(e) }} />)}
                  {evs.length > 2 && <div onClick={(ev) => { ev.stopPropagation(); setDaySheet(d); }} style={{ fontSize: 8, color: '#a16a2e', marginTop: 2, cursor: 'pointer' }}>+{evs.length - 2} more</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Day-detail bottom sheet — lists every event on the tapped day (projects, tasks, public holidays). */}
      {daySheet != null && (
        <DaySheet month_label={month_label} day={daySheet} events={byDay[daySheet] || []} onClose={() => setDaySheet(null)} />
      )}
    </div>
  );
}

// Bottom sheet mirroring the shipped DaySheet: public-holiday banner, then a card per project/task.
function DaySheet({ month_label, day, events, onClose }:
  { month_label: string; day: number; events: CalEvent[]; onClose: () => void }) {
  const holidays = events.filter((e) => e.kind === 'holiday');
  const items = events.filter((e) => e.kind !== 'holiday');
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'absolute', inset: 0, background: 'rgba(17,20,15,.4)', display: 'flex', alignItems: 'flex-end', zIndex: 20 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', background: '#fff', borderRadius: '16px 16px 0 0', maxHeight: '78%', display: 'flex', flexDirection: 'column', padding: '10px 14px 18px' }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: '#d6d9d2', margin: '0 auto 10px' }} />
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#16695f' }}>Day view</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#11140f' }}>{day} {month_label}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="iconbtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#767b6e" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>
        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9 }}>
          {holidays.length > 0 && (
            <div style={{ borderRadius: 10, border: '1px solid #c9cbe3', background: '#ecedf6', padding: '9px 12px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#474d79' }}>Public holiday</div>
              <div style={{ fontSize: 12.5, color: '#474d79', marginTop: 2 }}>{holidays.map((h) => h.title).join(', ')}</div>
            </div>
          )}
          {items.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9aa093', fontSize: 12, padding: '20px 0' }}>No projects or tasks on this day.</div>
          ) : (
            items.map((e, i) => (
              <div key={i} className="card" style={{ padding: '11px 13px', borderLeft: `4px solid ${barColor(e)}`, cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 800, color: '#11140f', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</span>
                  {e.status && (
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', padding: '3px 9px', borderRadius: 20, background: '#eef4f0', color: '#16695f', flex: 'none' }}>{e.status}</span>
                  )}
                </div>
                {(e.sub || e.organizer) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, fontSize: 11.5, color: '#767b6e', minWidth: 0 }}>
                    {e.sub && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{e.sub}</span>}
                    {e.sub && e.organizer && <span style={{ opacity: .4, flex: 'none' }}>·</span>}
                    {e.organizer && <span style={{ whiteSpace: 'nowrap', flex: 'none' }}>{e.organizer}</span>}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, color: '#3a3f34', background: '#fff',
  border: '1px solid #d6d9d2', borderRadius: 8, padding: '6px 8px',
};
