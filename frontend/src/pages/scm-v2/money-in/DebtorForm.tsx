// ----------------------------------------------------------------------------
// DebtorForm — an other debtor's own data, in place of the page it was opened
// from (the owner's Claude Design, batch 5 §4.1, the design's debtor form):
// New debtor and Edit debtor on Debtor maintenance, Edit debtor on the
// debtor's page. The design's fields first — the name as it prints, the
// registration no., phone, email, Active / Inactive, the address the bill goes
// to — and every other field the registry keeps (owner 2026-09-21: 他要填的资料
// 就和 supplier 的一样) under More details, so nothing the old pop-out took is
// lost. The structured address stays: the printed BILL TO reads it.
//
// The same doors as before: POST /other-debtors, PATCH /other-debtors/:id (a
// blank box clears its field; Active / Inactive is the old Deactivate).
//
// The account code (owner 2026-11-03, AutoCount style: 305-A001): a new debtor's
// is suggested from the name until someone types over it; an edit keeps the code
// it has. Two debtors never share one. For screens and prints only: bills and
// receipts still post to the one other-debtors control.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  useAccountRoles, useAccounts, useCreateDebtor, useOtherDebtors, useUpdateDebtor, type OtherDebtor,
} from '../../../vendor/scm/lib/accounting-queries';
import {
  DEBTOR_PARTY_GROUPS, debtorPartyBody, debtorPartyFrom, emptyDebtorParty, suggestDebtorCode, type DebtorPartyField, type DebtorPartyValues,
} from '../../../vendor/scm/lib/debtor-party';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../../vendor/scm/lib/use-save-hotkey';
import { useToastOptional } from '../../../hooks/useToast';
import { DocFormShell } from './MoneyInDocPage';
import ui from '../MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/** The design's own boxes; every other party field rides under More details. */
const MAIN = new Set<keyof DebtorPartyValues>(['name', 'businessRegNo', 'phone', 'email', 'address1', 'address2', 'postcode', 'city', 'state', 'country']);
const FIELD = new Map<keyof DebtorPartyValues, DebtorPartyField>(DEBTOR_PARTY_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f] as const)));
const MORE: DebtorPartyField[] = DEBTOR_PARTY_GROUPS.flatMap((g) => g.fields.filter((f) => !MAIN.has(f.key)));

export function DebtorFormPage({ debtor, backLabel, onClose, onAdded }: {
  /** The debtor an Edit starts from; null for a new one. */
  debtor: OtherDebtor | null;
  backLabel: string;
  onClose: () => void;
  /** A new debtor's page, opened once it is saved. */
  onAdded?: (id: string) => void;
}) {
  const toast = useToastOptional();
  const create = useCreateDebtor();
  const update = useUpdateDebtor();
  const accountsQ = useAccounts();
  const rolesQ = useAccountRoles();
  const debtorsQ = useOtherDebtors();
  const [v, setV] = useState<DebtorPartyValues>(() => (debtor ? debtorPartyFrom(debtor) : emptyDebtorParty()));
  const [active, setActive] = useState(debtor?.is_active ?? true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* An edit keeps the code it has; a new debtor's follows the name until it is typed over. */
  const [codeTyped, setCodeTyped] = useState(debtor != null);
  const saving = create.isPending || update.isPending;
  const set = (key: keyof DebtorPartyValues, value: string) => setV((p) => ({ ...p, [key]: value }));
  const controlCode = rolesQ.data?.roles.AR_OTHER ?? '305-0000';
  const otherCodes = useMemo(
    () => (debtorsQ.data?.debtors ?? []).filter((d) => d.id !== debtor?.id).map((d) => d.code),
    [debtorsQ.data, debtor?.id],
  );
  const suggested = suggestDebtorCode(v.name, controlCode, otherCodes);
  const code = codeTyped ? v.code.trim() : suggested;
  const clash = code !== '' && otherCodes.some((c) => (c ?? '').toUpperCase() === code.toUpperCase());
  const why = !v.name.trim() ? 'Type the debtor’s name.' : clash ? `Another debtor already has ${code}.` : null;
  const codeHint = clash ? 'Another debtor already has this code.'
    : codeTyped ? 'The debtor’s own code'
      : suggested || !v.name.trim() ? 'Suggested from the name · type to change' : 'Type the debtor’s own code';
  const filledMore = MORE.filter((f) => v[f.key].trim()).length;
  const control = useMemo(() => {
    const name = (accountsQ.data?.accounts ?? []).find((a) => a.account_code === controlCode)?.account_name;
    return `${controlCode}${name ? ` ${name}` : ''}`;
  }, [controlCode, accountsQ.data]);

  const save = () => {
    if (why || saving) return;
    setError(null);
    const body = { ...debtorPartyBody(v), code };
    if (debtor) {
      update.mutate({ id: debtor.id, ...body, ...(active !== debtor.is_active ? { isActive: active } : {}) }, {
        onSuccess: () => { toast?.success(`${body.name} saved`); onClose(); },
        onError: (e) => setError(errText(e)),
      });
      return;
    }
    create.mutate(body, {
      onSuccess: (res) => {
        toast?.success(`${body.name} added to Debtor maintenance`);
        onClose();
        if (res.debtor.id) onAdded?.(res.debtor.id);
      },
      onError: (e) => setError(errText(e)),
    });
  };
  useSaveHotkey(save, !saving);

  const box = (key: keyof DebtorPartyValues, opts: { label?: string; placeholder?: string; full?: boolean } = {}) => {
    const f = FIELD.get(key);
    const label = opts.label ?? f?.label ?? key;
    return (
      <label key={key} className={`${ui.formField} ${(opts.full ?? f?.wide) ? ui.formFull : ''}`}>
        <span className={ui.formLabel}>{label}</span>
        <input className={ui.formInput} value={v[key]} placeholder={opts.placeholder} aria-label={label}
          autoFocus={key === 'name' && !debtor} onChange={(e) => set(key, e.target.value)} />
      </label>
    );
  };

  return (
    <DocFormShell title={debtor ? `Edit ${debtor.name}` : 'New debtor'} backLabel={backLabel} onBack={onClose} bare>
      {error && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{error}</div>}
      <div className={ui.formGrid}>
        <div className={ui.formCol}>
          <div className={`${ui.formCard} ${ui.formFields}`}>
            {box('name', { placeholder: 'As it prints on the invoice', full: true })}
            <div className={ui.formField}>
              <label>
                <span className={ui.formLabel}>Account code</span>
                <input className={ui.formInput} value={code} placeholder="305-A001" aria-label="Account code" aria-invalid={clash}
                  onChange={(e) => { setCodeTyped(true); set('code', e.target.value.toUpperCase()); }} />
              </label>
              <div className={`${ui.formHint} ${clash ? ui.formHintBad : ''}`}>{codeHint}</div>
            </div>
            {box('businessRegNo', { label: 'Registration no.', placeholder: 'Company or IC number' })}
            {box('phone')}
            {box('email')}
            {/* Active / Inactive — the old Deactivate / Reactivate; a new debtor starts active. */}
            {debtor && (
              <div className={ui.formField}>
                <span className={ui.formLabel}>Status</span>
                <span className={ui.chips} role="group" aria-label="Status">
                  {([[true, 'Active'], [false, 'Inactive']] as const).map(([on, label]) => (
                    <button key={label} type="button" className={`${ui.chip} ${active === on ? ui.chipOn : ''}`} aria-pressed={active === on}
                      onClick={() => setActive(on)}>{label}</button>
                  ))}
                </span>
              </div>
            )}
            <div className={`${ui.formFull} ${ui.formSub}`}>Address · bill to</div>
            {box('address1', { placeholder: 'Street' })}
            {box('address2')}
            {box('postcode')}
            {box('city')}
            {box('state')}
            {box('country')}
          </div>
          <section className={ui.formCard} aria-label="More details">
            <button type="button" className={ui.moreToggle} aria-expanded={more} onClick={() => setMore((m) => !m)}>
              {more ? <ChevronDown size={14} /> : <ChevronRight size={14} />} More details
              {filledMore > 0 && <span className={ui.muted}>· {filledMore} filled</span>}
            </button>
            {more && <div className={`${ui.formFields} ${ui.moreFields}`}>{MORE.map((f) => box(f.key))}</div>}
          </section>
        </div>
        <aside className={ui.side} aria-label="Save">
          <div className={ui.sideBooks}>Account code {code || '—'} · bills and receipts post to the {control} control</div>
          {why && <div className={ui.sideWhy}>{why}</div>}
          <div className={ui.sideButtons}>
            <button type="button" className={ui.btn} onClick={onClose} disabled={saving}>Cancel</button>
            <span className={ui.grow} />
            <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={save} disabled={saving || why != null}>
              {saving ? 'Saving…' : debtor ? 'Save changes' : 'Save debtor'}
            </button>
          </div>
          <span className={ui.hint}>{SAVE_HOTKEY_HINT}</span>
        </aside>
      </div>
    </DocFormShell>
  );
}
