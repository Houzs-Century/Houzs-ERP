// The editing pieces a rate card's tabs share: the tab panel frame, a price
// changed or removed in place, a missing price added from its dashed tile, and
// the full add form for the rules that need a position, a bracket or a town.
import { useState, type ReactNode } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { fmtSen } from '@2990s/shared';
import {
  useCreateRateRule, useDeleteRateRule, useUpdateRateRule,
  type NewRateRule, type RateRule, type RateRuleType,
} from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { cn } from '../../../lib/utils';
import { RULE_LABEL, rulesByCategory, type RateRuleCategory } from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { centiToRM, rmToSen } from './cardSettings';
import type { FlatRuleType, PriceCell } from './rateCardLayout';
import { BTN_PRI, BTN_QUIET, CARD, HINT, INPUT, LABEL, Pill } from './ui';

/** The card's five tabs: its four categories, then Price check. */
export type RateSection = RateRuleCategory | 'PRICE_CHECK';
export const tabId = (s: RateSection) => `rate-tab-${s.toLowerCase()}`;
export const panelId = (s: RateSection) => `rate-panel-${s.toLowerCase()}`;

export const AMOUNT_ERROR = 'Enter an amount in RM, 0 or more.';
const ERR_TEXT = 'text-[11.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]';
const SMALL_BTN = 'grid h-8 w-8 flex-none place-items-center rounded-lg text-ink-muted hover:bg-surface-2 disabled:opacity-50';
/* Its own class list rather than INPUT + overrides: cn() only joins, so INPUT's
   w-full would win over a width added after it. */
const AMOUNT_INPUT = 'min-h-[34px] w-full min-w-[110px] max-w-[150px] rounded-lg border border-border bg-surface px-2 text-right text-[14px] tabular-nums text-ink';
/* In a table cell the box keeps one width, so the column widens once, evenly. */
const CELL_INPUT = 'min-h-[34px] w-[120px] rounded-lg border border-border bg-surface px-2 text-right text-[14px] tabular-nums text-ink';

/** One tab's content: title, a quiet note, a hint, actions on the right. */
export const Panel = ({ section, title, note, hint, actions, children }: {
  section: RateSection; title: string; note: ReactNode; hint: string; actions: ReactNode; children: ReactNode;
}) => (
  <section role="tabpanel" id={panelId(section)} aria-label={title} className={cn(CARD, 'flex flex-col gap-4 px-5 py-[18px]')}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-[16px] font-bold text-ink">
          {title}{note != null && <span className="ml-1.5 font-medium text-ink-muted">{note}</span>}
        </h3>
        <p className={HINT}>{hint}</p>
      </div>
      {actions != null && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-none">{actions}</div>}
    </div>
    {children}
  </section>
);

/** A price being changed: the amount, save, cancel, and remove — remove lives
 *  here rather than as a bin beside every price. */
export const PriceEditor = ({ cardId, rule, name, onDone, compact = false }: {
  cardId: string; rule: RateRule; name: string; onDone: () => void; compact?: boolean;
}) => {
  const update = useUpdateRateRule(cardId);
  const del = useDeleteRateRule(cardId);
  const [draft, setDraft] = useState(centiToRM(rule.amountSen));
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    const amountSen = rmToSen(draft);
    if (draft.trim() === '' || amountSen == null) { setErr(AMOUNT_ERROR); return; }
    if (amountSen === rule.amountSen) { onDone(); return; }
    update.mutate({ id: rule.id, amountSen }, { onSuccess: onDone }); // the hook's own onError (writeFailed) shows a refusal
  };
  return (
    <span className={cn('flex flex-col gap-1', compact && 'items-end')}>
      <input autoFocus className={compact ? CELL_INPUT : AMOUNT_INPUT} inputMode="decimal" aria-label={`Amount for ${name}`}
        value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }} />
      <span className="flex items-center gap-1">
        <button type="button" className={cn(SMALL_BTN, 'text-primary')} onClick={save} disabled={update.isPending} aria-label={`Save ${name}`}>
          <Check size={15} strokeWidth={2} />
        </button>
        <button type="button" className={SMALL_BTN} onClick={onDone} aria-label={`Cancel ${name}`}><X size={15} strokeWidth={2} /></button>
        <button type="button" className={cn(SMALL_BTN, 'hover:text-[color:var(--hz-dk-err,#8a2c2c)]')} disabled={del.isPending}
          onClick={() => del.mutate(rule.id, { onSuccess: onDone, onError: writeFailedAs('The price was not removed') })}
          aria-label={`Remove ${name}`}><Trash2 size={14} strokeWidth={1.75} /></button>
      </span>
      {err && <span role="alert" className={ERR_TEXT}>{err}</span>}
    </span>
  );
};

/** A price in a table cell: the amount, which a click opens to change or
 *  remove. `name` reads "1st set", or "1st set for Kuching zone 3" in an area. */
export const PriceButton = ({ cardId, rule, name }: { cardId: string; rule: RateRule; name: string }) => {
  const [editing, setEditing] = useState(false);
  if (editing) return <PriceEditor cardId={cardId} rule={rule} name={name} onDone={() => setEditing(false)} compact />;
  return (
    <button type="button" onClick={() => setEditing(true)} aria-label={`Edit ${name}, ${fmtSen(rule.amountSen)}`}
      className="-my-1 min-h-[28px] w-full rounded-md px-1 text-right tabular-nums text-ink hover:bg-surface-2 hover:text-primary">
      {centiToRM(rule.amountSen)}
    </button>
  );
};

/** A price the row could carry and does not, added from its own cell. `rule`
 *  is what it adds — a flat type, or an area's position or sofa band. In an
 *  area the cell reads "—" (the card's own price applies); on the card, "Add". */
export const AddPriceCell = ({ cardId, rule, label, scope }: {
  cardId: string; rule: Omit<NewRateRule, 'amountSen'>; label: string; scope?: string;
}) => {
  const create = useCreateRateRule(cardId);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = scope ? `${label} for ${scope}` : label;
  /* "Add 3rd set and after price for Kuching zone 3"; "Add Dispose price". */
  const what = `${label} price${scope ? ` for ${scope}` : ''}`;
  if (draft === null) {
    return (
      <button type="button" onClick={() => setDraft('')} aria-label={`Add ${what}`}
        title={scope ? 'The card’s own price applies. Click to give this area its own.' : 'Not priced yet. Click to add a price.'}
        className="-my-1 inline-flex min-h-[28px] w-full items-center justify-end gap-1 rounded-md px-1 text-[12.5px] text-ink-muted hover:bg-surface-2 hover:text-primary">
        {scope ? '—' : <><Plus size={13} strokeWidth={2} />Add</>}
      </button>
    );
  }
  const save = () => {
    const amountSen = rmToSen(draft);
    if (draft.trim() === '' || amountSen == null) { setErr(AMOUNT_ERROR); return; }
    create.mutate({ ...rule, amountSen }, { onSuccess: () => setDraft(null), onError: writeFailedAs('The price was not added') });
  };
  return (
    <span className="flex flex-col items-end gap-1">
      <input autoFocus className={CELL_INPUT} inputMode="decimal" placeholder="0.00" aria-label={`Amount for ${name}`}
        value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setDraft(null); }} />
      <span className="flex items-center gap-1">
        <button type="button" className={cn(SMALL_BTN, 'text-primary')} onClick={save} disabled={create.isPending} aria-label={`Save ${what}`}>
          <Check size={15} strokeWidth={2} />
        </button>
        <button type="button" className={SMALL_BTN} onClick={() => setDraft(null)} aria-label={`Cancel ${what}`}><X size={15} strokeWidth={2} /></button>
      </span>
      {err && <span role="alert" className={ERR_TEXT}>{err}</span>}
    </span>
  );
};

type AddForm = { ruleType: RateRuleType; tierPosition: string; bracketMin: string; bracketMax: string; zone: string; amountRM: string };

/** Add a rule to one category: the rule type list holds only that category's.
 *  For the rules a dashed tile cannot take — a position, a sofa bracket, a town. */
export const AddRule = ({ cardId, category, zones, initialType, onDone }: {
  cardId: string; category: RateRuleCategory; zones: string[]; initialType: RateRuleType | null; onDone: () => void;
}) => {
  const create = useCreateRateRule(cardId);
  const types = rulesByCategory().find((g) => g.category === category)?.types ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<AddForm>({
    ruleType: initialType ?? ((types[0] ?? 'POSITIONAL_TIER') as RateRuleType), tierPosition: '1', bracketMin: '', bracketMax: '', zone: '', amountRM: '',
  });
  const set = <K extends keyof AddForm>(k: K, v: AddForm[K]) => { setErr(null); setForm((s) => ({ ...s, [k]: v })); };

  const needsPosition = form.ruleType === 'POSITIONAL_TIER' || form.ruleType === 'OVERAGE';
  const needsBracket = form.ruleType === 'SOFA_BRACKET';
  const needsZone = form.ruleType === 'OUTSTATION' || form.ruleType === 'OUTSTATION_TRIP';

  const addRule = () => {
    const amountSen = rmToSen(form.amountRM);
    if (amountSen == null || form.amountRM.trim() === '') { setErr(AMOUNT_ERROR); return; }
    const body: Parameters<typeof create.mutate>[0] = { ruleType: form.ruleType, amountSen };
    if (needsPosition) {
      const n = Number(form.tierPosition);
      if (!Number.isInteger(n) || n < 1) { setErr(form.ruleType === 'OVERAGE' ? 'Cap N must be 1 or more.' : 'Tier position must be 1 or more.'); return; }
      body.tierPosition = n;
    }
    if (needsBracket) {
      const lo = Number(form.bracketMin);
      if (form.bracketMin.trim() === '' || !Number.isInteger(lo) || lo < 0) { setErr('Compartment min must be 0 or more.'); return; }
      const hi = form.bracketMax.trim() === '' ? null : Number(form.bracketMax);
      if (hi != null && (!Number.isInteger(hi) || hi < lo)) { setErr('Compartment max must be blank or at least the min.'); return; }
      body.bracketMin = lo;
      body.bracketMax = hi;
    }
    if (needsZone) {
      if (!form.zone.trim()) { setErr('Enter the town or area zone.'); return; }
      body.zone = form.zone.trim();
    }
    /* A town is added one after another, so the box clears for the next. */
    create.mutate(body, {
      onSuccess: () => setForm((s) => ({ ...s, amountRM: '', zone: needsZone ? '' : s.zone })),
      onError: writeFailedAs('The rule was not added'),
    });
  };

  const listId = `rate-zone-list-${category.toLowerCase()}`;
  const field = (label: string, cls: string, input: ReactNode) => (
    <label className={cn('flex min-w-0 flex-col gap-1.5', cls)}><span className={LABEL}>{label}</span>{input}</label>
  );

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-border bg-surface-2/50 px-4 py-3.5">
      {field('Rule type', 'flex-[1_1_220px]', (
        <select className={INPUT} value={form.ruleType} onChange={(e) => set('ruleType', e.target.value as RateRuleType)}>
          {types.map((t) => <option key={t} value={t}>{RULE_LABEL[t]}</option>)}
        </select>
      ))}
      {needsPosition && field(form.ruleType === 'OVERAGE' ? 'Cap N' : 'Position (3 = 3rd and after)', 'flex-[0_1_170px]', (
        <input className={INPUT} inputMode="numeric" value={form.tierPosition} onChange={(e) => set('tierPosition', e.target.value)} />
      ))}
      {needsBracket && (
        <>
          {field('Compartments from', 'flex-[0_1_150px]', <input className={INPUT} inputMode="numeric" value={form.bracketMin} onChange={(e) => set('bracketMin', e.target.value)} />)}
          {field('To (blank = or more)', 'flex-[0_1_160px]', <input className={INPUT} inputMode="numeric" value={form.bracketMax} onChange={(e) => set('bracketMax', e.target.value)} />)}
        </>
      )}
      {needsZone && field('Town or area zone', 'flex-[1_1_200px]', (
        <>
          <input className={INPUT} list={listId} value={form.zone} onChange={(e) => set('zone', e.target.value)} placeholder="BINTULU" />
          <datalist id={listId}>{zones.map((z) => <option key={z} value={z} />)}</datalist>
        </>
      ))}
      {field('Amount (RM)', 'flex-[0_1_140px]', <input className={INPUT} inputMode="decimal" value={form.amountRM} onChange={(e) => set('amountRM', e.target.value)} />)}
      <div className="flex gap-2">
        <button type="button" className={BTN_PRI} onClick={addRule} disabled={create.isPending}><Plus size={16} strokeWidth={1.75} />{create.isPending ? 'Adding…' : 'Add rule'}</button>
        <button type="button" className={BTN_QUIET} onClick={onDone}>Done</button>
      </div>
      {err && <p role="alert" className="basis-full text-[13px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{err}</p>}
    </div>
  );
};
