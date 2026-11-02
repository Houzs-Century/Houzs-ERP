// ----------------------------------------------------------------------------
// FinanceTodoRules — Setup › To do rules (the owner's Claude Design redesign,
// Finance-1a-To-do, batch 2): which built-in rules fill To do, the month's
// routines (their amount and payee, which Finance fills; switched on or off),
// and the groups Finance added beside the four. Nothing is deleted here — a
// rule or routine is switched off.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { PageHeader } from '../../../components/Layout';
import { fmtSenPlain } from '../../../vendor/shared/format';
import styles from './FinanceTasks.module.css';
import { BUILT_IN_GROUPS } from './TaskDrawers';
import { useAddGroup, useAddRule, useSaveRulesOff, useTodoSettings, useUpdateTask, type CustomRule, type TodoTask } from './finance-todo-queries';

/** The design's RULES table: what each finds, where it lands, whose desk it is on. */
const RULES: Array<[string, string, string, string, string]> = [
  ['card-missing', 'Merchant report missing', 'A card machine report not in by the next morning', 'recon', 'Finance'],
  ['card-matched', 'Merchant lines to confirm', 'Report lines matched to an order by reference', 'recon', 'Finance'],
  ['card-choose', 'Merchant lines to choose', 'Report lines that fit more than one order, or none', 'recon', 'Finance'],
  ['bank-missing', 'Bank statement missing', 'A bank account with no statement for 3 days', 'recon', 'Finance'],
  ['bank-decide', 'Bank lines to decide', 'Statement lines not matched to an entry', 'recon', 'Finance'],
  ['requests', 'Payment requests', 'Requests from other teams not yet made into vouchers', 'pay', 'Finance'],
  ['pv-check', 'Vouchers to check', 'Vouchers someone else prepared, not yet checked', 'pay', 'Checker'],
  ['pv-approve', 'Vouchers to approve', 'Checked vouchers waiting for approval', 'pay', 'Approver'],
  ['transfers', 'Transfers to confirm', 'Draft receipts for transfers not yet seen in the bank', 'other', 'Finance'],
  ['overdue', 'Overdue invoices', 'Customer invoices more than 30 days past due', 'other', 'Finance'],
];

const groupLabel = (id: string): string => BUILT_IN_GROUPS.find((g) => g.id === id)?.label ?? id;

/** The design's TEMPLATES: what a rule Finance adds can look for. */
const TEMPLATES: Record<CustomRule['tpl'], { name: string; finds: (n: string) => string; paramLabel: string; unit: string; def: number; group: string; button: string }> = {
  bills: { name: 'Supplier bills due soon', finds: (n) => `AP invoices due within ${n} days and not paid`, paramLabel: 'Due within', unit: 'days', def: 7, group: 'pay', button: 'Opens AP invoices' },
  drafts: { name: 'Drafts left too long', finds: (n) => `Finance documents still in Draft after ${n} days`, paramLabel: 'Older than', unit: 'days', def: 3, group: 'other', button: 'Opens Payment vouchers' },
  big: { name: 'Large payments received', finds: (n) => `Customer payments over RM ${n}, each needs its own e-invoice`, paramLabel: 'Over RM', unit: '', def: 10_000, group: 'other', button: 'Opens Official receipts' },
};
const TEMPLATE_IDS = Object.keys(TEMPLATES) as Array<CustomRule['tpl']>;

function NewRule({ groups, onDone }: { groups: Array<{ id: string; label: string }>; onDone: () => void }) {
  const add = useAddRule();
  const [tpl, setTpl] = useState<CustomRule['tpl']>('bills');
  const [param, setParam] = useState(String(TEMPLATES.bills.def));
  const [group, setGroup] = useState(TEMPLATES.bills.group);
  const t = TEMPLATES[tpl];
  const n = Number(param.replace(/,/g, ''));
  const ok = Number.isInteger(n) && n > 0;
  return (
    <div className={styles.newRule} aria-label='New rule'>
      <div className={styles.templateList}>
        {TEMPLATE_IDS.map((id) => (
          <button key={id} type='button' className={`${styles.template} ${tpl === id ? styles.templateOn : ''}`} aria-pressed={tpl === id}
            onClick={() => { setTpl(id); setParam(String(TEMPLATES[id].def)); setGroup(TEMPLATES[id].group); }}>
            <span className={styles.ruleName}>{TEMPLATES[id].name}</span>
            <span className={styles.ruleFinds}>{TEMPLATES[id].finds(String(TEMPLATES[id].def))}</span>
          </button>
        ))}
      </div>
      <div className={styles.newRuleRow}>
        <span className={styles.ruleFinds}>{t.paramLabel}</span>
        <input className={styles.amountInput} value={param} onChange={(e) => setParam(e.target.value)} inputMode='numeric' aria-label={t.paramLabel} />
        {t.unit && <span className={styles.ruleFinds}>{t.unit}</span>}
        <span className={styles.ruleFinds}>· put under</span>
        <select className={styles.payeeInput} value={group} onChange={(e) => setGroup(e.target.value)} aria-label='Put it under'>
          {[...BUILT_IN_GROUPS, ...groups].map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>
      </div>
      <div className={styles.ruleFinds}>{ok ? t.finds(n.toLocaleString('en-MY')) : 'Give a whole number.'} · {t.button}. To do fills itself from then on.</div>
      <div className={styles.newRuleRow}>
        <button type='button' className={styles.btnSecondary} onClick={onDone}>Cancel</button>
        <button type='button' className={styles.btnPrimary} disabled={!ok || add.isPending}
          onClick={() => add.mutate({ tpl, param: n, group }, { onSuccess: onDone })}>Add rule</button>
      </div>
    </div>
  );
}

function Switch({ on, label, disabled, onClick }: { on: boolean; label: string; disabled: boolean; onClick: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`${styles.switch} ${on ? styles.switchOn : ''}`} onClick={onClick} />;
}

const whenOf = (t: TodoTask): string =>
  t.monthDay === 'last' ? 'Every month, last day' : `Every month ${t.byDay ? 'by' : 'on'} the ${t.monthDay ?? '—'}${['1', '21', '31'].includes(t.monthDay ?? '') ? 'st' : ['2', '22'].includes(t.monthDay ?? '') ? 'nd' : ['3', '23'].includes(t.monthDay ?? '') ? 'rd' : 'th'}`;

/** RM typed as "4,800" or "4800.50" → whole sen; blank → none. */
const senOf = (v: string): number | null | 'bad' => {
  const s = v.replace(/[,\s]|RM/gi, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 'bad';
  return Math.round(Number(s) * 100);
};

function RoutineRow({ t, mayEdit }: { t: TodoTask; mayEdit: boolean }) {
  const update = useUpdateTask();
  const [amount, setAmount] = useState(t.amountSen == null ? '' : fmtSenPlain(t.amountSen));
  const [payee, setPayee] = useState(t.payee ?? '');
  const saveAmount = () => {
    const sen = senOf(amount);
    if (sen === 'bad' || sen === t.amountSen) return;
    update.mutate({ id: t.id, amountSen: sen });
  };
  const savePayee = () => { if (payee.trim() !== (t.payee ?? '')) update.mutate({ id: t.id, payee: payee.trim() || null }); };
  return (
    <tr className={t.isOff ? styles.offRow : ''}>
      <td><div className={styles.ruleName}>{t.title}</div><div className={styles.ruleFinds}>{groupLabel(t.groupKey)}</div></td>
      <td>{whenOf(t)}</td>
      <td>
        {t.action === 'voucher'
          ? <input className={styles.amountInput} value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={saveAmount} disabled={!mayEdit} placeholder="RM — blank" aria-label={`${t.title} amount`} />
          : <span className={styles.ruleFinds}>—</span>}
      </td>
      <td>
        {t.action === 'voucher'
          ? <input className={styles.payeeInput} value={payee} onChange={(e) => setPayee(e.target.value)} onBlur={savePayee} disabled={!mayEdit} placeholder="Who it pays" aria-label={`${t.title} payee`} />
          : <span className={styles.ruleFinds}>—</span>}
      </td>
      <td><Switch on={!t.isOff} label={`${t.title} on`} disabled={!mayEdit || update.isPending} onClick={() => update.mutate({ id: t.id, isOff: !t.isOff })} /></td>
    </tr>
  );
}

export function FinanceTodoRulesPage() {
  const q = useTodoSettings();
  const save = useSaveRulesOff();
  const addGroup = useAddGroup();
  const [newGroup, setNewGroup] = useState('');
  const [adding, setAdding] = useState(false);
  const s = q.data;
  const off = new Set(s?.rulesOff ?? []);
  const flip = (id: string) => {
    const next = off.has(id) ? [...off].filter((r) => r !== id) : [...off, id];
    save.mutate(next);
  };
  return (
    <div>
      <PageHeader eyebrow="Finance · Setup" title="To do rules" />
      {q.isError && <div className={styles.problem}>The rules could not be read — {q.error instanceof Error ? q.error.message : 'try again'}.</div>}
      {s && (
        <div className={styles.rulesPage}>
          <section className={styles.card} aria-label="Built-in rules">
            <div className={styles.cardHead}>Rules<span className={styles.cardNote}>Each one fills To do from the books by itself. Switch one off and its jobs stop showing.</span>
              {s.mayEdit && !adding && <button type='button' className={`${styles.btnSecondary} ${styles.headButton}`} onClick={() => setAdding(true)}>New rule</button>}
            </div>
            {adding && <NewRule groups={s.groups} onDone={() => setAdding(false)} />}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Rule</th><th>Puts it under</th><th>For</th><th>On</th></tr></thead>
                <tbody>
                  {RULES.map(([id, name, finds, group, who]) => (
                    <tr key={id} className={off.has(id) ? styles.offRow : ''}>
                      <td><div className={styles.ruleName}>{name}</div><div className={styles.ruleFinds}>{finds}</div></td>
                      <td>{groupLabel(group)}</td>
                      <td>{who}</td>
                      <td><Switch on={!off.has(id)} label={`${name} on`} disabled={!s.mayEdit || save.isPending} onClick={() => flip(id)} /></td>
                    </tr>
                  ))}
                  {s.customRules.map((r) => {
                    const t = TEMPLATES[r.tpl];
                    return (
                      <tr key={r.id} className={off.has(r.id) ? styles.offRow : ''}>
                        <td><div className={styles.ruleName}>{t.name}<span className={styles.yours}>Yours</span></div><div className={styles.ruleFinds}>{t.finds(r.param.toLocaleString('en-MY'))}</div></td>
                        <td>{[...BUILT_IN_GROUPS, ...s.groups].find((g) => g.id === r.group)?.label ?? r.group}</td>
                        <td>Finance</td>
                        <td><Switch on={!off.has(r.id)} label={`${t.name} on`} disabled={!s.mayEdit || save.isPending} onClick={() => flip(r.id)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card} aria-label="Routines">
            <div className={styles.cardHead}>Routines<span className={styles.cardNote}>They come back every month and show in To do 3 days before. Amounts and payees are yours to fill.</span></div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Routine</th><th>When</th><th>Amount (RM)</th><th>Pays</th><th>On</th></tr></thead>
                <tbody>
                  {s.routines.map((t) => <RoutineRow key={t.id} t={t} mayEdit={s.mayEdit} />)}
                  {s.routines.length === 0 && <tr><td colSpan={5} className={styles.ruleFinds}>No routines here yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.card} aria-label="Groups">
            <div className={styles.cardHead}>Groups<span className={styles.cardNote}>Beside the four, any group Finance adds — tasks can be put under it.</span></div>
            <div className={styles.groupList}>
              {[...BUILT_IN_GROUPS, ...s.groups].map((g) => <span key={g.id} className={styles.groupPill}>{g.label}</span>)}
            </div>
            {s.mayEdit && (
              <div className={styles.groupList}>
                <input className={styles.payeeInput} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} maxLength={40} placeholder="e.g. Tax & e-invoice" aria-label="New group" />
                <button type="button" className={styles.btnSecondary} disabled={!newGroup.trim() || addGroup.isPending}
                  onClick={() => addGroup.mutate(newGroup.trim(), { onSuccess: () => setNewGroup('') })}>Add group</button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
