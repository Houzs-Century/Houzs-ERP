import { X } from 'lucide-react';
import { sortByText } from '../lib/sort-options';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

type StaffOption = { id: string; name?: string | null; staffCode?: string | null };

/* Several people from the staff list, as removable chips plus an "add" select
   (owner 2026-10-06: two or three people count a stock take together). The
   order is the order picked. A picked id the list does not carry (left the
   company) still shows, named by `nameOf`. Native select on purpose: it types
   to jump and works with the arrow keys like every other field. */
export function StaffMultiPick({
  options, value, onChange, nameOf, label, disabled,
}: {
  options: readonly StaffOption[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  nameOf: (id: string) => string;
  label: string;
  disabled: boolean;
}) {
  const remaining = sortByText(options.filter((o) => !value.includes(o.id)));
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {value.map((id) => (
        <span key={id} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 999, border: '1px solid var(--line)',
          background: 'var(--c-cream)', fontSize: 'var(--fs-12)',
        }}>
          {nameOf(id)}
          {!disabled && (
            <button type="button" aria-label={`Remove ${nameOf(id)}`}
              onClick={() => onChange(value.filter((x) => x !== id))}
              style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, lineHeight: 0 }}>
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <select
          aria-label={label}
          className={styles.fieldSelect}
          style={{ flex: '1 1 160px', minWidth: 160 }}
          value=""
          onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}
        >
          <option value="">{value.length ? '+ Add another…' : '— Pick who is counting —'}</option>
          {remaining.map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.staffCode || s.id}</option>
          ))}
        </select>
      )}
    </div>
  );
}
