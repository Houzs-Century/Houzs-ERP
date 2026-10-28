import { useState } from 'react';

// MobileLogin — role picker + sign in. Maps to prototype: #login.
// Engineer replaces the demo role <select> with real auth; onLogin(role) -> route to that role's home.

export type Role = 'owner' | 'sales' | 'purchasing' | 'warehouse' | 'driver' | 'logistics' | 'pms';
const ROLE_LABELS: [Role, string][] = [
  ['owner', 'Owner / IT Admin — all modules'],
  ['sales', 'Salesperson — Sales Orders'],
  ['purchasing', 'Purchasing — Purchase Orders'],
  ['warehouse', 'Warehouse — Inventory'],
  ['driver', 'Driver / Helper — Delivery Planning'],
  ['logistics', 'Logistics Admin — Transportation'],
  ['pms', 'Projects / PMS — Projects'],
];

export function MobileLogin({ onLogin }: { onLogin: (role: Role) => void }) {
  const [role, setRole] = useState<Role>('owner');
  return (
    <div className="hz-m screen" style={{ background: '#13201c' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 30px', color: '#fff' }}>
        <div style={{ width: 70, height: 70, borderRadius: 20, background: 'linear-gradient(160deg,#23242a,#0e0f12)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 22, boxShadow: 'inset 0 0 0 1px rgba(216,168,90,.16)' }}>
          <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
            <span style={{ width: 6, height: 12, background: '#2a6f63', borderRadius: 2 }} />
            <span style={{ width: 6, height: 20, background: '#3f9c8c', borderRadius: 2 }} />
            <span style={{ width: 6, height: 26, background: '#d8a85a', borderRadius: 2 }} />
          </div>
        </div>
        <div style={{ fontSize: 26, fontWeight: 800 }}>Houzs Century</div>
        <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.34em', color: '#d8a85a', marginTop: 6 }}>ERP · MOBILE</div>
        <div style={{ marginTop: 30 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(231,234,228,.55)' }}>Sign in as (demo position)</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: '100%', marginTop: 7, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(231,234,228,.18)', borderRadius: 12, padding: '13px 14px', color: '#fff', fontFamily: 'inherit', fontSize: 14, appearance: 'none' }}>
            {ROLE_LABELS.map(([v, l]) => <option key={v} value={v} style={{ color: '#111' }}>{l}</option>)}
          </select>
        </div>
        <button className="btn" style={{ marginTop: 16 }} onClick={() => onLogin(role)}>Sign in</button>
      </div>
    </div>
  );
}
