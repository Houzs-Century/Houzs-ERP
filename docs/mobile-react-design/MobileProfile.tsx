// MobileProfile — identity + settings list. Maps to prototype: #profile.
// Sub-screens (Personal details / Notifications / Language / Help & Support / My Team) are
// rendered as pushed detail routes by the shell; each is a simple settings page (stub prop `onOpen`).
import { money } from './types';

export interface ProfileData { member_name: string; position_title: string; venue_name: string; language: string; mtd_orders: number; mtd_sales_centi: number; }

export function MobileProfile({ me, onOpen, onLogout }:
  { me: ProfileData; onOpen: (page: string) => void; onLogout: () => void }) {
  const initials = me.member_name.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const Item = ({ label, right }: { label: string; right?: string }) => (
    <div className="row" style={{ cursor: 'pointer' }} onClick={() => onOpen(label)}>
      <span className="row-l" style={{ color: '#11140f', fontWeight: 600 }}>{label}</span>
      <span style={{ color: right ? '#767b6e' : '#c2c6bd', fontSize: right ? 13 : 16 }}>{right ?? '\u203a'}</span>
    </div>
  );
  return (
    <div className="hz-m screen">
      <header className="hdr" style={{ background: '#15161a', borderBottom: 'none' }}><div className="scr-title" style={{ color: '#fff' }}>Profile</div></header>
      <div className="scroll">
        <div className="card" style={{ background: '#15161a', border: 'none' }}><div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          <span style={{ width: 52, height: 52, flex: 'none', borderRadius: '50%', background: '#23242a', color: '#d8a85a', fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials}</span>
          <div><div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{me.member_name}</div><div style={{ fontSize: 11.5, color: '#9aa093', marginTop: 2 }}>{me.position_title} · {me.venue_name}</div></div>
        </div></div>
        <div style={{ display: 'flex', gap: 9, margin: '12px 0' }}>
          <div className="card" style={{ flex: 1, margin: 0 }}><div className="card-b" style={{ textAlign: 'center', padding: 11 }}><div className="money" style={{ fontSize: 15, fontWeight: 800 }}>{me.mtd_orders}</div><div className="fld-l" style={{ marginTop: 3 }}>Orders MTD</div></div></div>
          <div className="card" style={{ flex: 1, margin: 0 }}><div className="card-b" style={{ textAlign: 'center', padding: 11 }}><div className="money" style={{ fontSize: 15, fontWeight: 800 }}>{money(me.mtd_sales_centi)}</div><div className="fld-l" style={{ marginTop: 3 }}>Sales MTD</div></div></div>
        </div>
        <div className="fld-l" style={{ margin: '6px 2px 8px' }}>Account</div>
        <div className="card"><Item label="Personal details" /><Item label="Notifications" /><Item label="Language" right={me.language} /><Item label="My Team" /></div>
        <div className="fld-l" style={{ margin: '14px 2px 8px' }}>App</div>
        <div className="card"><Item label="Help & Support" /></div>
        <button className="btn btn-danger" style={{ marginTop: 16 }} onClick={onLogout}>Log out</button>
        <div className="money" style={{ textAlign: 'center', fontSize: 10, color: '#a4a99c', marginTop: 12 }}>Houzs ERP · Mobile v1.0</div>
      </div>
    </div>
  );
}
