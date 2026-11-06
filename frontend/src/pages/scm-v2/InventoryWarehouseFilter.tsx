import { useState } from 'react';
import { ChevronDown, Warehouse as WarehouseIcon } from 'lucide-react';
import type { Warehouse } from '../../vendor/scm/lib/inventory-queries';
import styles from './Inventory.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* ════════════════════════════════════════════════════════════════════════
   WarehouseFilter — compact SEARCHABLE multi-select for the Balances view
   (ask A, owner 2026-07-24 "compact searchable dropdown, not big cards";
   any number of warehouses, owner 2026-11-06).
   Shows the warehouse SHORT code-name (`code`, e.g. "KL WAREHOUSE") as the
   label; the long `name` rides along as a muted sub-line inside the picker
   only. Click to open, type to filter in place, tick any, or "All warehouses".
   ════════════════════════════════════════════════════════════════════════ */
export const WarehouseFilter = ({
  warehouses, value, onChange,
}: {
  warehouses: Warehouse[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const chosen = warehouses.filter((w) => value.includes(w.id));
  const label = chosen.length === 0 ? 'All warehouses' : chosen.length === 1 ? chosen[0]!.code : `${chosen.length} warehouses`;
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? warehouses.filter((w) => w.code.toLowerCase().includes(ql) || w.name.toLowerCase().includes(ql))
    : warehouses;
  const close = () => { setOpen(false); setQ(''); };
  return (
    <div className={styles.whFilter}>
      <button type="button" className={styles.whFilterButton} data-active={value.length > 0}
        onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <WarehouseIcon {...ICON} />
        <span className={styles.whFilterLabel} title={chosen.map((w) => w.code).join(', ')}>{label}</span>
        <ChevronDown size={14} strokeWidth={1.75} />
      </button>
      {open && (
        <>
          <div className={styles.whFilterBackdrop} onClick={close} />
          <div className={styles.whFilterPanel} role="listbox" aria-multiselectable="true">
            <input autoFocus className={styles.whFilterSearch} placeholder="Search warehouse…"
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') close(); }} />
            <div className={styles.whFilterList}>
              <button type="button" className={styles.whFilterOption} data-active={value.length === 0}
                onClick={() => { onChange([]); close(); }}>
                All warehouses
              </button>
              {filtered.map((w) => (
                <label key={w.id} className={styles.whFilterOption} data-active={value.includes(w.id)}>
                  <span className={styles.whFilterOptionTick}>
                    <input type="checkbox" checked={value.includes(w.id)}
                      onChange={() => onChange(value.includes(w.id) ? value.filter((id) => id !== w.id) : [...value, w.id])} />
                    <span className={styles.whFilterOptionCode}>{w.code}</span>
                  </span>
                  {w.name && w.name !== w.code && <span className={styles.whFilterOptionSub}>{w.name}</span>}
                </label>
              ))}
              {filtered.length === 0 && <div className={styles.whFilterEmpty}>No warehouse matches.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
