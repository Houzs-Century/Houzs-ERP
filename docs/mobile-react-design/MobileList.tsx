import { ListConfig, ListRow } from './types';
import { Badge } from './MobileSoList';

// Generic READ-ONLY list + detail engine. Use for EVERY module that is not
// Sales Order / Project / Service Case: Delivery Orders, Sales Invoices, Returns,
// PO, GRN, PI, Purchase Returns, Products, Suppliers, Inventory, Fleet, Drivers,
// Warehouse, Members, Positions, Departments.
// DO NOT add editors / line editing / create wizards to these.
// Maps to prototype: the shared list engine (#m-do, #m-si, #m-po, …) + generic #detail.

export interface MobileListProps {
  config: ListConfig;
  rows: ListRow[];
  onOpenMenu: () => void;
  onOpenRow: (row: ListRow) => void;
}

export function MobileList({ config, rows, onOpenMenu, onOpenRow }: MobileListProps) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 }}>
          <button onClick={onOpenMenu} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: '#16695f', background: 'none', border: 'none', cursor: 'pointer' }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>Menu
          </button>
          <span className="eyebrow">{config.eyebrow}</span>
        </div>
        <div className="scr-title" style={{ marginBottom: 11 }}>{config.title}</div>
        <div className="searchbar">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input placeholder={config.search_placeholder} />
        </div>
        {config.chips && (
          <div className="chips" style={{ marginTop: 10, display: 'flex', gap: 7, overflowX: 'auto' }}>
            {config.chips.map((c, i) => <button key={c.value} className={'chip' + (i === 0 ? ' on' : '')}>{c.label}</button>)}
          </div>
        )}
      </header>
      <div className="scroll">
        {/* LIST START — one row per record */}
        {rows.map((r, i) => (
          <div key={i} className="card" style={{ cursor: 'pointer', padding: '12px 13px' }} onClick={() => onOpenRow(r)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 800, color: '#11140f' }}>{String(r[config.title_key])}</span>
              {config.pill_key && <span style={{ flex: 'none' }}><Badge status={String(r[config.pill_key])} /></span>}
            </div>
            <div className="so-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', marginTop: 8 }}>
              {config.fields.map((f) => (
                <div key={f.key} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#9aa093' }}>{f.label}</div>
                  <div className="money" style={{ fontSize: 12, fontWeight: 600, color: '#11140f' }}>{String(r[f.key] ?? '—')}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {/* LIST END */}
        {rows.length === 0 && <div className="empty"><div className="empty-t">Nothing here yet</div></div>}
      </div>
    </div>
  );
}

// Generic READ-ONLY detail — a titled card of every field. No edit, no actions.
export interface MobileDetailProps {
  config: ListConfig;
  row: ListRow;
  onBack: () => void;
}

export function MobileDetail({ config, row, onBack }: MobileDetailProps) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; {config.title}</button>
          {config.pill_key && <Badge status={String(row[config.pill_key])} />}
        </div>
        <div className="eyebrow" style={{ marginTop: 7 }}>{config.eyebrow}</div>
        <div className="scr-title">{String(row[config.title_key])}</div>
      </header>
      <div className="scroll">
        <div className="card">
          {config.fields.map((f) => (
            <div className="row" key={f.key}><span className="row-l">{f.label}</span><span className="row-v money">{String(row[f.key] ?? '—')}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}
