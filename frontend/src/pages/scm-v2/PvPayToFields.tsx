// The bank a voucher pays into, as three fields in the voucher form's own grid
// (pv-pay-to.ts says why). Used by the new-voucher form and the detail page's edit.

import type { PayTo } from './pv-pay-to';
import styles from './SalesOrderDetail.module.css';

const FIELDS: Array<{ key: keyof PayTo; label: string; placeholder: string }> = [
  { key: 'bank', label: 'Bank', placeholder: 'e.g. MAYBANK' },
  { key: 'accountNo', label: 'Account no.', placeholder: 'The payee’s account number' },
  { key: 'accountName', label: 'Account name', placeholder: 'The name the account is in' },
];

export function PvPayToFields({ value, onChange }: { value: PayTo; onChange: (next: PayTo) => void }) {
  return (
    <>
      {FIELDS.map((f) => (
        <label key={f.key} className={styles.field}>
          <span className={styles.fieldLabel}>{f.label}</span>
          <input type="text" className={styles.fieldInput} value={value[f.key]} aria-label={f.label}
            placeholder={f.placeholder} maxLength={120}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
        </label>
      ))}
    </>
  );
}
