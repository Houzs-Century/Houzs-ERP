// ----------------------------------------------------------------------------
// CapexFinancingDialog — the Cash Flow's Capex & financing table (step 3 of the
// forecast port, owner 2026-11-24 「开始做第 3 步」; Hookka's keyed inputs).
// Money Finance plans to move outside the trading cycle, keyed per account and
// month for the current month and the eleven after it: + money in, − money
// out, in RM. The accounts are the ones the Cash Flow layout places under
// FUNDING IN / (OUT) — capex, loans and hire purchase, related-party and
// director loans, deposits, fixed deposits, shareholder funds — trade finance
// aside (its plan comes later), grouped as the layout places them. An account
// keyed earlier that the layout no longer offers is shown to be cleared: the
// server refuses the table while it carries one. Save sends the whole table,
// the months outside the twelve included. Forecast only: nothing posts; the
// amounts show in the Cash Flow's forecast column on their own account.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { Modal } from '../../../vendor/scm/components/Modal';
import { useToastOptional } from '../../../hooks/useToast';
import { parseMoneyToSen } from '../../../lib/money';
import { fmtMoneyAtRest } from '../../../vendor/scm/components/MoneyInput';
import { fmtSenPlain } from '../../../../../shared/src/vendor/shared/format';
import { useForecastInputs, useSaveForecastInputs, type ForecastInputs, type KeyedInputs } from '../../../vendor/scm/lib/cash-flow-forecast-queries';
import { monthName } from './statementColumns';
import f from './Forecast.module.css';

/** The table with one cell set (a number) or cleared (null); a month left empty goes. */
export function withInput(months: KeyedInputs, ym: string, code: string, sen: number | null): KeyedInputs {
  const cells = { ...(months[ym] ?? {}) };
  if (sen) cells[code] = sen; else delete cells[code];
  const next = { ...months };
  if (Object.keys(cells).length > 0) next[ym] = cells; else delete next[ym];
  return next;
}

/** The table with an account cleared in every month. */
export function withoutAccount(months: KeyedInputs, code: string): KeyedInputs {
  let next = months;
  for (const ym of Object.keys(months)) next = withInput(next, ym, code, null);
  return next;
}

/** One cell of the table, or nothing — a lookup that says a month or an account may be absent. */
export const inputOf = (months: Partial<Record<string, Partial<Record<string, number>>>>, ym: string, code: string): number | null => months[ym]?.[code] ?? null;

/** A month's net: money in less money out. */
export const netOf = (months: KeyedInputs, ym: string): number => Object.values(months[ym] ?? {}).reduce((s, v) => s + v, 0);

/** The rows: the offered accounts in their groups, then the ones to clear. */
export function inputRows(data: ForecastInputs): Array<{ kind: 'group'; id: string; label: string } | { kind: 'account'; code: string; name: string; offered: boolean }> {
  const out: Array<{ kind: 'group'; id: string; label: string } | { kind: 'account'; code: string; name: string; offered: boolean }> = [];
  let group = '';
  for (const a of data.accounts) {
    if (a.group.id !== group) { out.push({ kind: 'group', id: a.group.id, label: a.group.label }); group = a.group.id; }
    out.push({ kind: 'account', code: a.code, name: a.name, offered: true });
  }
  if (data.notOffered.length > 0) {
    out.push({ kind: 'group', id: 'not-offered', label: 'No longer on the Cash Flow layout — clear before saving' });
    for (const a of data.notOffered) out.push({ kind: 'account', code: a.code, name: a.name, offered: false });
  }
  return out;
}

const messageOf = (e: unknown): string => {
  const o = (e ?? {}) as { body?: unknown; message?: unknown };
  if (typeof o.body === 'string') {
    try {
      const b = JSON.parse(o.body) as { message?: unknown; error?: unknown };
      if (typeof b.message === 'string' && b.message) return b.message;
      if (typeof b.error === 'string' && b.error) return b.error;
    } catch { }
  }
  return typeof o.message === 'string' && o.message ? o.message : 'The table was not saved.';
};

function AmountCell({ valueSen, label, onCommit, readOnly }: { valueSen: number | null; label: string; onCommit: (sen: number | null) => void; readOnly: boolean }) {
  const [draft, setDraft] = useState(fmtMoneyAtRest(valueSen));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(fmtMoneyAtRest(valueSen)); }, [valueSen, focused]);
  const commit = () => {
    const r = parseMoneyToSen(draft, label, { allowNegative: true });
    if (!r.ok) { setDraft(fmtMoneyAtRest(valueSen)); return; }
    const sen = r.empty ? null : r.sen;
    if ((sen ?? null) !== (valueSen ?? null)) onCommit(sen === 0 ? null : sen);
    setDraft(fmtMoneyAtRest(sen === 0 ? null : sen));
  };
  return (
    <input
      type="text" inputMode="decimal" aria-label={label} readOnly={readOnly}
      className={`${f.box} ${readOnly ? '' : f.boxOpen} ${valueSen != null ? f.boxTyped : ''} ${valueSen != null && valueSen < 0 ? f.loss : ''}`}
      value={draft}
      onFocus={() => { setFocused(true); setDraft(valueSen == null ? '' : (valueSen / 100).toFixed(2)); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { setDraft(fmtMoneyAtRest(valueSen)); e.currentTarget.blur(); } }}
    />
  );
}

export function CapexFinancingDialog({ onClose, canWrite }: { onClose: () => void; canWrite: boolean }) {
  const q = useForecastInputs(true);
  const save = useSaveForecastInputs();
  const toast = useToastOptional();
  const [months, setMonths] = useState<KeyedInputs | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (q.data && months === null) setMonths(q.data.months); }, [q.data, months]);
  const rows = useMemo(() => (q.data ? inputRows(q.data) : []), [q.data]);
  const dirty = q.data != null && months != null && JSON.stringify(months) !== JSON.stringify(q.data.months);
  const shown = q.data?.shown ?? [];

  const doSave = async () => {
    if (!months) return;
    setError(null);
    try {
      await save.mutateAsync(months);
      toast?.success('Capex & financing saved · the forecast shows it on each account in its month');
      onClose();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Modal title="Capex & financing" onClose={onClose} ariaLabel="Capex & financing" width="min(1480px, 100%)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div className={f.note} style={{ padding: 0, borderTop: 0 }}>
          Money planned outside the trading cycle, in RM: + money in (a loan drawn, capital put in), − money out (equipment bought, a loan repaid).
          The accounts are the ones the Cash Flow layout places under Funding in / (out); trade finance has its own plan.
          The amounts show in the Cash Flow&apos;s forecast column on their own account in their month. Forecast only — nothing posts.
        </div>
        {q.isError && <p role="alert" className={f.alert}>The table did not load. Close it and try again.</p>}
        {!q.data && !q.isError && <p className={f.empty}>Loading…</p>}
        {q.data && months && (
          rows.length === 0
            ? <p className={f.empty}>No capex or financing account on the Cash Flow layout: place them under Funding in / (out) with Layout.</p>
            : (
              <div className={f.card}>
                <div className={f.scroll}>
                  <table className={f.table} aria-label="Capex and financing by month">
                    <thead>
                      <tr>
                        <th className={`${f.name} ${f.nameHead}`}>Account</th>
                        {shown.map((ym) => <th key={ym} className={f.th}>{monthName(`${ym}-01`)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (r.kind === 'group' ? (
                        <tr key={`g:${r.id}`} className={f.catRow}><td colSpan={1 + shown.length} className={f.name}>{r.label}</td></tr>
                      ) : (
                        <tr key={r.code} className={f.row} data-row={`acc:${r.code}`}>
                          <td className={f.name} style={{ paddingLeft: 30 }}>
                            {r.code} · {r.name}
                            {!r.offered && canWrite && (
                              <button type="button" className={f.toggle} style={{ marginLeft: 10 }} onClick={() => setMonths((m) => (m ? withoutAccount(m, r.code) : m))}>Clear</button>
                            )}
                          </td>
                          {shown.map((ym) => (
                            <td key={ym} className={f.cell}>
                              <AmountCell
                                valueSen={inputOf(months, ym, r.code)} label={`${ym} ${r.code} amount`} readOnly={!canWrite || !r.offered}
                                onCommit={(sen) => setMonths((m) => (m ? withInput(m, ym, r.code, sen) : m))}
                              />
                            </td>
                          ))}
                        </tr>
                      )))}
                      <tr className={f.strongRow} data-row="net">
                        <td className={f.name}>Net (money in less money out)</td>
                        {shown.map((ym) => {
                          const v = netOf(months, ym);
                          return <td key={ym} className={`${f.cell} ${v < 0 ? f.loss : ''}`}>{fmtSenPlain(v)}</td>;
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
        )}
        {error && <p role="alert" className={f.alert}>{error}</p>}
        {!canWrite && q.data && <p className={f.hint}>You can read this table; changing it needs the payment vouchers&apos; write permission.</p>}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {dirty && <span className={f.unsaved}>Unsaved changes</span>}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => void doSave()} disabled={!canWrite || !dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

