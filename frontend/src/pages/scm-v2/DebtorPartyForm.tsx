// ----------------------------------------------------------------------------
// DebtorPartyForm — the one form behind New and Edit of an Other Debtor's own
// data (owner 2026-09-21: other debtor 做，他要填的资料就和 supplier 的一样):
// identity, contact and the structured address, in the supplier master's
// order, so the INVOICE a debtor bill prints can carry an address in BILL TO.
// A blank box on Edit clears the field. Only the name is required.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { DEBTOR_PARTY_GROUPS, type DebtorPartyValues } from '../../vendor/scm/lib/debtor-party';
import styles from './SalesOrderDetail.module.css';

const groupTitle: React.CSSProperties = {
  fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)',
  margin: '0 0 var(--space-2)',
};
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-3)' };

export const DebtorPartyForm = ({ mode, initial, saving, onSubmit, onCancel }: {
  mode: 'new' | 'edit';
  initial: DebtorPartyValues;
  saving: boolean;
  onSubmit: (values: DebtorPartyValues) => void | Promise<void>;
  onCancel: () => void;
}) => {
  const [v, setV] = useState<DebtorPartyValues>(initial);
  const set = (key: keyof DebtorPartyValues, value: string) => setV((prev) => ({ ...prev, [key]: value }));
  const canSave = v.name.trim().length > 0 && !saving;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', fontSize: 'var(--fs-13)' }}>
      {DEBTOR_PARTY_GROUPS.map((g) => (
        <div key={g.title}>
          <div style={groupTitle}>{g.title}</div>
          <div style={grid}>
            {g.fields.map((f) => (
              <label key={f.key} className={styles.field} style={f.wide ? { gridColumn: '1 / -1' } : undefined}>
                <span className={styles.fieldLabel}>{f.label}</span>
                <input
                  className={styles.fieldInput}
                  value={v[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  autoFocus={f.key === 'name'}
                />
              </label>
            ))}
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void onSubmit(v)} disabled={!canSave}>
          {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save'}
        </Button>
      </div>
    </div>
  );
};
