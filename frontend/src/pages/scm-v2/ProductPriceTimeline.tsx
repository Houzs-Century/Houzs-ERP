import { useState, useRef } from 'react';
import { fmtSen } from '@2990s/shared';
import { Button } from '../../components/Button';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { todayMyt } from '../../vendor/scm/lib/dates';
import styles from './Products.module.css';
import {
  useMfgProductPriceChanges,
  useCreateMfgProductPriceChange,
  type MfgProductRow,
  type MfgProductPriceChangeRow,
} from '../../vendor/scm/lib/mfg-products-queries';

/* Effective-dated SELLING price timeline (Pricing "Option B", ph.2). Lives on the
   SKU detail drawer: shows the current price, a "Next: RM X from <date>" badge for
   the pending change, the dated history (date · RM · who), and an "add future
   price" form. Money is integer sen (MoneyInput + fmtSen). Mirrors the
   maintenance-config effective-date editor's shape.

   NOTE the price amount is held in a REF, not just state: MoneyInput commits on
   blur, and a click on Schedule blurs the field first — reading the ref in the
   handler avoids the stale-closure race a disabled-by-amount button would hit.

   In its own file so Products.tsx (at its size ceiling) does not grow. */
export const ProductPriceTimeline = ({ row }: { row: MfgProductRow }) => {
  const q = useMfgProductPriceChanges(row.id);
  const create = useCreateMfgProductPriceChange();
  const [effDate, setEffDate] = useState(todayMyt());
  const [amountSen, setAmountSen] = useState<number | null>(null);
  const amountRef = useRef<number | null>(null);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const today = todayMyt();
  const history = q.data?.history ?? [];
  const pending = q.data?.pending ?? null;
  const current = q.data?.currentSellPriceSen ?? row.sell_price_sen ?? null;

  const setAmount = (sen: number | null) => { amountRef.current = sen; setAmountSen(sen); };
  const save = () => {
    setFormError(null);
    const amount = amountRef.current;
    if (!effDate) { setFormError('Pick an effective date.'); return; }
    if (amount == null || !Number.isInteger(amount) || amount < 0) { setFormError('Enter a price.'); return; }
    create.mutate(
      { id: row.id, effectiveFrom: effDate, sellPriceSen: amount, notes: notes.trim() || undefined },
      {
        onSuccess: () => { setAmount(null); setNotes(''); setEffDate(todayMyt()); },
        onError: (e) => setFormError(e instanceof Error ? e.message : 'Could not schedule the price.'),
      },
    );
  };

  const h3 = {
    fontSize: 'var(--fs-12)', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.06em', color: '#767b6e', marginBottom: 'var(--space-2)',
  };
  const fieldLabel = {
    fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.04em', color: '#767b6e', marginBottom: 4, display: 'block',
  };
  const inputBox = {
    background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-sm)',
    padding: '4px 8px', fontSize: 'var(--fs-13)', outline: 'none',
  };

  return (
    <section style={{ marginBottom: 'var(--space-5)' }}>
      <h3 style={h3}>Selling price timeline</h3>

      {/* Current + pending badges — "today = current, <future> = new". */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '3px 10px',
          background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-pill)',
          fontSize: 'var(--fs-12)', color: '#3a3f36',
        }}>
          <span style={{ color: '#767b6e', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)', fontWeight: 700 }}>Now</span>
          {fmtSen(current)}
        </span>
        {pending && (
          <span style={{
            display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '3px 10px',
            background: 'rgba(232, 107, 58, 0.08)', border: '1px solid rgba(232, 107, 58, 0.35)',
            borderRadius: 'var(--radius-pill)', fontSize: 'var(--fs-12)', color: '#b64a1e',
          }}>
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)', fontWeight: 700 }}>Next</span>
            {fmtSen(pending.sellPriceSen)} from {pending.effectiveFrom}
          </span>
        )}
      </div>

      {/* Add a future price. */}
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <div>
          <label style={fieldLabel}>Effective from</label>
          <DateField value={effDate} onChange={(iso) => setEffDate(iso)} style={{ ...inputBox, fontFamily: 'var(--font-mono)' }}/>
        </div>
        <div>
          <label style={fieldLabel}>New price</label>
          <MoneyInput
            bare
            valueSen={amountSen}
            onCommit={setAmount}
            allowBlank
            selectOnFocus
            placeholder="0.00"
            style={{ ...inputBox, width: 120, textAlign: 'right' }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label style={fieldLabel}>Note (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. new-year list price"
            style={{ ...inputBox, width: '100%' }}
          />
        </div>
        <Button variant="primary" onClick={save} disabled={create.isPending}>
          {create.isPending ? 'Scheduling…' : 'Schedule price'}
        </Button>
      </div>
      {formError && (
        <p style={{ margin: '0 0 var(--space-3)', color: '#b3261e', fontSize: 'var(--fs-12)' }}>{formError}</p>
      )}

      {/* Dated history — newest first. */}
      {q.isLoading ? (
        <p style={{ color: '#767b6e', fontSize: 'var(--fs-13)' }}>Loading price timeline…</p>
      ) : history.length === 0 ? (
        <p style={{ color: '#767b6e', fontSize: 'var(--fs-13)' }}>
          No scheduled prices yet. The flat price {fmtSen(current)} applies until you schedule one.
        </p>
      ) : (
        <table className={styles.table} style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Effective from</th>
              <th style={{ textAlign: 'right' }}>Price</th>
              <th>Set by</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h: MfgProductPriceChangeRow) => {
              const isFuture = h.effective_from > today;
              return (
                <tr key={h.id} style={{ background: isFuture ? 'rgba(232, 107, 58, 0.06)' : undefined }}>
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{h.effective_from}</span>
                    {isFuture && (
                      <span className={styles.codeChip} style={{ marginLeft: 6, fontSize: 'var(--fs-11)' }}>Scheduled</span>
                    )}
                  </td>
                  <td className={styles.numCell}>{fmtSen(h.sell_price_sen)}</td>
                  <td style={{ color: '#3a3f36' }}>{h.created_by || '—'}</td>
                  <td style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>{h.notes || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
};
