import { useState, ReactNode } from 'react';
import { Role } from './MobileLogin';

// MobileShell — app frame: role-based bottom tabs + center Menu sheet + nav stack.
// Tabs: Orders · Service · (center Menu) · Calendar · Profile. Center Menu opens the grouped-module sheet.
// The engineer swaps `screens` mapping for real routes; this shows the navigation model verbatim.

export interface TabDef { id: string; label: string; icon: ReactNode; }
export interface MenuGroup { group: string; items: [string, string][]; } // [screenId, label]

const svg = (p: ReactNode) => <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;
const ICONS = {
  orders: svg(<><path d="M7 3h7l4 4v14H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4" /><path d="M9.5 12.5h5M9.5 16h3" /></>),
  service: svg(<path d="M15.3 7.3a3.8 3.8 0 0 1-4.9 4.9l-5.1 5.1a1.8 1.8 0 0 1-2.6-2.6l5.1-5.1a3.8 3.8 0 0 1 4.9-4.9l-2.3 2.3a1 1 0 0 0 0 1.4l1.2 1.2a1 1 0 0 0 1.4 0Z" />),
  calendar: svg(<><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>),
  profile: svg(<><circle cx="12" cy="8" r="3.7" /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" /></>),
  menu: <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>,
};

export interface MobileShellProps {
  role: Role;
  current: string;
  menu: MenuGroup[];              // groups filtered to the role's permissions
  onNavigate: (screenId: string) => void;   // resets to a root
  children: ReactNode;           // the active screen
}

export function MobileShell({ role, current, menu, onNavigate, children }: MobileShellProps) {
  const [sheet, setSheet] = useState(false);
  const leftTabs: TabDef[] = role === 'logistics' || role === 'driver'
    ? [{ id: 'planning', label: 'Planning', icon: ICONS.orders }, { id: 'service', label: 'Service', icon: ICONS.service }]
    : [{ id: 'so-list', label: 'Orders', icon: ICONS.orders }, { id: 'service', label: 'Service', icon: ICONS.service }];
  const rightTabs: TabDef[] = [{ id: 'calendar', label: 'Calendar', icon: ICONS.calendar }, { id: 'profile', label: 'Profile', icon: ICONS.profile }];
  const Tab = (t: TabDef) => (
    <button key={t.id} className={'tab' + (current === t.id ? ' on' : '')} onClick={() => { onNavigate(t.id); setSheet(false); }}>
      {t.icon}<span className="tl">{t.label}</span>
    </button>
  );
  return (
    <div className="hz-m" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      {children}
      {/* bottom tab bar */}
      <div className="navwrap">
        <div className="tabbar">
          {leftTabs.map(Tab)}
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            <button className="disc" onClick={() => setSheet((s) => !s)} aria-label="Menu">{ICONS.menu}</button>
          </div>
          {rightTabs.map(Tab)}
        </div>
      </div>
      {/* menu sheet */}
      {sheet && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(17,20,15,.4)', display: 'flex', alignItems: 'flex-end' }} onClick={(e) => { if (e.target === e.currentTarget) setSheet(false); }}>
          <div style={{ width: '100%', maxHeight: '86%', background: '#fff', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ width: 40, height: 4, borderRadius: 3, background: '#c2c6bd', margin: '8px auto' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 16px 10px' }}>
              <div><div className="eyebrow">Menu</div><div style={{ fontSize: 16, fontWeight: 800 }}>Where to next?</div></div>
              <button onClick={() => setSheet(false)} style={{ width: 32, height: 32, borderRadius: 9, border: '1px solid #d6d9d2', background: '#fff', cursor: 'pointer' }}>&times;</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '0 14px 16px' }}>
              {menu.map((g) => (
                <div key={g.group} style={{ border: '1px solid #e6e8e2', background: '#f6f7f4', borderRadius: 15, padding: 11, marginBottom: 11 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.13em', textTransform: 'uppercase', color: '#a16a2e', marginBottom: 8 }}>{g.group}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {g.items.map(([id, label]) => (
                      <button key={id} onClick={() => { onNavigate(id); setSheet(false); }} style={{ border: '1px solid #e0e3dc', background: '#fff', borderRadius: 11, padding: 10, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#11140f', textAlign: 'left' }}>{label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
