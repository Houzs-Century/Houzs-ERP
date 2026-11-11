// A rate card's rules, one card per category, each laid out as a price table
// (rateCardLayout.ts) so the whole card can be read and checked at a glance.
// Every price is edited in place and deleted from its own cell; each category
// adds its own rules.
import { useMemo, useState, type ReactNode } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  useCreateRateRule, useDeleteRateRule, useUpdateRateRule,
  type RateRule, type RateRuleType,
} from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import { cn } from '../../../lib/utils';
import {
  CATEGORY_HINT, CATEGORY_LABEL, RULE_LABEL, rulesByCategory, type RateRuleCategory,
} from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { hiddenZoneRules, layoutRateCard, type PriceCell, type RuleBlock, type ZoneRow } from './rateCardLayout';
import { BTN_PRI, BTN_QUIET, CARD, HINT, INPUT, LABEL, Pill } from './ui';

const ruleLabel = (t: string): string => (RULE_LABEL as Partial<Record<string, string>>)[t] ?? t;
const centiToRM = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
export const rmToSen = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const SMALL_BTN = 'grid h-8 w-8 flex-none place-items-center rounded-lg text-ink-muted hover:bg-surface-2 disabled:opacity-50';

/** The DOM id a category's card scrolls to from the summary bar. */
export const sectionAnchor = (cat: RateRuleCategory) => `rate-section-${cat.toLowerCase()}`;

/** An amount, edited in place (PATCH) and deleted from where it is read. */
const Amount = ({ cardId, rule, name }: { cardId: string; rule: RateRule; name: string }) => {
  const update = useUpdateRateRule(cardId);
  const del = useDeleteRateRule(cardId);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const amountSen = rmToSen(draft);
    if (draft.trim() === '' || amountSen == null) { setErr('Enter a non-negative RM amount.'); return; }
    if (amountSen === rule.amountSen) { setDraft(null); return; }
    update.mutate({ id: rule.id, amountSen }, { onSuccess: () => { setDraft(null); setErr(null); } }); // the hook's own onError (writeFailed) shows a refusal
  };
  if (draft !== null) {
    return (
      <span className="flex flex-col items-end gap-0.5">
        <span className="flex flex-wrap items-center justify-end gap-1">
          <input autoFocus className={cn(INPUT, 'min-h-[34px] w-[84px] px-2 text-right tabular-nums sm:w-[96px]')} inputMode="decimal" aria-label={`Amount for ${name}`}
            value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(null); setErr(null); } }} />
          <button type="button" className={cn(SMALL_BTN, 'text-primary')} onClick={save} disabled={update.isPending} aria-label="Save amount"><Check size={15} strokeWidth={2} /></button>
          <button type="button" className={SMALL_BTN} onClick={() => { setDraft(null); setErr(null); }} aria-label="Cancel"><X size={15} strokeWidth={2} /></button>
          {/* On a phone the cell has no room for its icons, so delete lives here. */}
          <button type="button" className={cn(SMALL_BTN, 'hover:text-[color:var(--hz-dk-err,#8a2c2c)] sm:hidden')} disabled={del.isPending}
            onClick={() => del.mutate(rule.id, { onError: writeFailedAs('The rule was not deleted') })}
            aria-label={`Delete ${name} rule`}><Trash2 size={14} strokeWidth={1.75} /></button>
        </span>
        {err && <span role="alert" className="text-[11.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{err}</span>}
      </span>
    );
  }
  return (
    <span className="flex items-center justify-end gap-0.5">
      {/* The amount itself opens the editor, so a phone needs no icon to change it. */}
      <button type="button" onClick={() => setDraft(centiToRM(rule.amountSen))}
        className="mr-1 min-h-[32px] rounded-md px-1 text-[15px] font-bold tabular-nums text-ink hover:bg-surface-2">{centiToRM(rule.amountSen)}</button>
      <button type="button" className={cn(SMALL_BTN, 'hidden hover:text-primary sm:grid')} onClick={() => setDraft(centiToRM(rule.amountSen))}
        aria-label={`Edit amount for ${name}`}><Pencil size={13} strokeWidth={1.75} /></button>
      <button type="button" className={cn(SMALL_BTN, 'hidden hover:text-[color:var(--hz-dk-err,#8a2c2c)] sm:grid')} disabled={del.isPending}
        onClick={() => del.mutate(rule.id, { onError: writeFailedAs('The rule was not deleted') })}
        aria-label={`Delete ${name} rule`}><Trash2 size={13} strokeWidth={1.75} /></button>
    </span>
  );
};

/** A price the zone table does not have yet, added from its empty cell. */
const AddZonePrice = ({ cardId, zone, ruleType }: { cardId: string; zone: string; ruleType: 'OUTSTATION' | 'OUTSTATION_TRIP' }) => {
  const create = useCreateRateRule(cardId);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = `${zone} ${ruleType === 'OUTSTATION' ? 'per order' : 'per trip'}`;
  if (draft === null) {
    return (
      <button type="button" onClick={() => setDraft('')} aria-label={`Add ${name}`}
        className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-ink-muted hover:bg-surface-2 hover:text-primary">
        <Plus size={13} strokeWidth={2} />Add
      </button>
    );
  }
  const save = () => {
    const amountSen = rmToSen(draft);
    if (draft.trim() === '' || amountSen == null) { setErr('Enter a non-negative RM amount.'); return; }
    create.mutate({ ruleType, zone, amountSen }, { onSuccess: () => setDraft(null), onError: writeFailedAs('The rule was not added') });
  };
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="flex flex-wrap items-center justify-end gap-1">
        <input autoFocus className={cn(INPUT, 'min-h-[34px] w-[84px] px-2 text-right sm:w-[96px]')} inputMode="decimal" aria-label={`Amount for ${name}`}
          value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setDraft(null); }} />
        <button type="button" className={cn(SMALL_BTN, 'text-primary')} onClick={save} disabled={create.isPending} aria-label={`Save ${name}`}><Check size={15} strokeWidth={2} /></button>
        <button type="button" className={SMALL_BTN} onClick={() => setDraft(null)} aria-label="Cancel"><X size={15} strokeWidth={2} /></button>
      </span>
      {err && <span role="alert" className="text-[11.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{err}</span>}
    </span>
  );
};

const LadderBlock = ({ cardId, title, cells }: { cardId: string; title: string; cells: PriceCell[] }) => (
  <div className="flex flex-col gap-2">
    <span className="text-[12.5px] font-semibold text-ink-secondary">{title}</span>
    <div className="grid overflow-hidden rounded-xl border border-border [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
      {cells.map((c) => {
        const name = c.label === ruleLabel(c.rule.ruleType) ? c.label : `${ruleLabel(c.rule.ruleType)} ${c.label}`;
        return (
          <div key={c.rule.id} className="-ml-px -mt-px flex flex-col gap-1 border-l border-t border-border px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-muted">
              {c.label}{c.duplicate && <Pill tone="amber">Twice</Pill>}
            </span>
            <Amount cardId={cardId} rule={c.rule} name={name} />
          </div>
        );
      })}
    </div>
  </div>
);

const ZONE_FILTER_FROM = 12;
const ZoneTable = ({ cardId, rows, hidden }: { cardId: string; rows: ZoneRow[]; hidden: RateRule[] }) => {
  const [q, setQ] = useState('');
  const shown = q.trim() ? rows.filter((r) => r.zone.toLowerCase().includes(q.trim().toLowerCase())) : rows;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-ink-secondary">By destination zone ({rows.length} {rows.length === 1 ? 'zone' : 'zones'})</span>
        {rows.length >= ZONE_FILTER_FROM && (
          <input className={cn(INPUT, 'min-h-[36px] w-full max-w-[240px] text-[13px]')} placeholder="Find a zone or town" aria-label="Find a zone or town"
            value={q} onChange={(e) => setQ(e.target.value)} />
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="bg-surface-2/60 text-left text-[11.5px] font-bold uppercase tracking-[0.05em] text-ink-muted">
              <th scope="col" className="px-2 py-2 sm:px-3">Zone or town</th>
              <th scope="col" className="w-[36%] px-2 py-2 text-right sm:px-3">Per order (RM)</th>
              <th scope="col" className="w-[36%] px-2 py-2 text-right sm:px-3">Per trip (RM)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.zone} className="border-t border-border">
                <th scope="row" className="px-2 py-1 text-left font-semibold text-ink sm:px-3">
                  <span className="flex items-center gap-1.5">{r.zone}{r.duplicate && <Pill tone="amber">Twice</Pill>}</span>
                </th>
                {(['perOrder', 'perTrip'] as const).map((k) => {
                  const rule = r[k];
                  const type = k === 'perOrder' ? 'OUTSTATION' : 'OUTSTATION_TRIP';
                  return (
                    <td key={k} className="px-2 py-1 text-right sm:px-3">
                      {rule
                        ? <Amount cardId={cardId} rule={rule} name={`${r.zone} ${k === 'perOrder' ? 'per order' : 'per trip'}`} />
                        : <AddZonePrice cardId={cardId} zone={r.zone} ruleType={type} />}
                    </td>
                  );
                })}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-[13px] text-ink-muted">No zone matches “{q.trim()}”.</td></tr>}
          </tbody>
        </table>
      </div>
      {hidden.length > 0 && (
        <div className="rounded-xl bg-[#f6ecd4] px-3 py-2.5 text-[12.5px] text-accent-ink">
          <p className="mb-1.5 font-semibold">A zone priced twice: the card uses one of these, so delete the one that is wrong.</p>
          {hidden.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-0.5">
              <span>{r.zone} · {r.ruleType === 'OUTSTATION' ? 'per order' : 'per trip'}</span>
              <Amount cardId={cardId} rule={r} name={`${r.zone ?? ''} ${r.ruleType === 'OUTSTATION' ? 'per order' : 'per trip'} (second)`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

type AddForm = { ruleType: RateRuleType; tierPosition: string; bracketMin: string; bracketMax: string; zone: string; amountRM: string };

/** Add a rule to one category: the rule type list holds only that category's. */
const AddRule = ({ cardId, category, zones, onDone }: { cardId: string; category: RateRuleCategory; zones: string[]; onDone: () => void }) => {
  const create = useCreateRateRule(cardId);
  const types = rulesByCategory().find((g) => g.category === category)?.types ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<AddForm>({
    ruleType: (types[0] ?? 'POSITIONAL_TIER') as RateRuleType, tierPosition: '1', bracketMin: '', bracketMax: '', zone: zones[0] ?? 'MELAKA', amountRM: '',
  });
  const set = <K extends keyof AddForm>(k: K, v: AddForm[K]) => { setErr(null); setForm((s) => ({ ...s, [k]: v })); };

  const addRule = () => {
    const amountSen = rmToSen(form.amountRM);
    if (amountSen == null || form.amountRM.trim() === '') { setErr('Enter a non-negative RM amount.'); return; }
    const body: Parameters<typeof create.mutate>[0] = { ruleType: form.ruleType, amountSen };
    if (form.ruleType === 'POSITIONAL_TIER' || form.ruleType === 'OVERAGE') {
      const n = Number(form.tierPosition);
      if (!Number.isInteger(n) || n < 1) { setErr(form.ruleType === 'OVERAGE' ? 'Cap N must be 1 or more.' : 'Tier position must be 1 or more.'); return; }
      body.tierPosition = n;
    }
    if (form.ruleType === 'SOFA_BRACKET') {
      const lo = Number(form.bracketMin);
      if (form.bracketMin.trim() === '' || !Number.isInteger(lo) || lo < 0) { setErr('Compartment min must be 0 or more.'); return; }
      const hi = form.bracketMax.trim() === '' ? null : Number(form.bracketMax);
      if (hi != null && (!Number.isInteger(hi) || hi < lo)) { setErr('Compartment max must be blank or at least the min.'); return; }
      body.bracketMin = lo;
      body.bracketMax = hi;
    }
    if (form.ruleType === 'OUTSTATION' || form.ruleType === 'OUTSTATION_TRIP') {
      if (!form.zone.trim()) { setErr('Enter the zone or town.'); return; }
      body.zone = form.zone.trim();
    }
    create.mutate(body, { onSuccess: () => set('amountRM', ''), onError: writeFailedAs('The rule was not added') });
  };

  const needsPosition = form.ruleType === 'POSITIONAL_TIER' || form.ruleType === 'OVERAGE';
  const needsBracket = form.ruleType === 'SOFA_BRACKET';
  const needsZone = form.ruleType === 'OUTSTATION' || form.ruleType === 'OUTSTATION_TRIP';
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
      {needsPosition && field(form.ruleType === 'OVERAGE' ? 'Cap N' : 'Position (3=3rd+)', 'flex-[0_1_140px]', (
        <input className={INPUT} inputMode="numeric" value={form.tierPosition} onChange={(e) => set('tierPosition', e.target.value)} />
      ))}
      {needsBracket && (
        <>
          {field('Comp min', 'flex-[0_1_120px]', <input className={INPUT} inputMode="numeric" value={form.bracketMin} onChange={(e) => set('bracketMin', e.target.value)} />)}
          {field('Comp max (blank=+)', 'flex-[0_1_150px]', <input className={INPUT} inputMode="numeric" value={form.bracketMax} onChange={(e) => set('bracketMax', e.target.value)} />)}
        </>
      )}
      {needsZone && field('Zone or town', 'flex-[1_1_200px]', (
        <>
          <input className={INPUT} list={listId} value={form.zone} onChange={(e) => set('zone', e.target.value)} placeholder="KL, JOHOR, or a town e.g. RAWANG" />
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

const Block = ({ cardId, block, rules }: { cardId: string; block: RuleBlock; rules: readonly RateRule[] }) => (block.kind === 'zones'
  ? <ZoneTable cardId={cardId} rows={block.rows} hidden={hiddenZoneRules(rules, block.rows)} />
  : <LadderBlock cardId={cardId} title={block.title} cells={block.cells} />);

export const RateCardRules = ({ cardId, rules, zones, unit }: { cardId: string; rules: RateRule[]; zones: string[]; unit: string }) => {
  const sections = useMemo(() => layoutRateCard(rules, unit), [rules, unit]);
  const [adding, setAdding] = useState<RateRuleCategory | null>(null);
  return (
    <>
      {sections.map((s) => (
        <section key={s.category} id={sectionAnchor(s.category)} aria-label={CATEGORY_LABEL[s.category]}
          className={cn(CARD, 'flex scroll-mt-24 flex-col gap-4 px-5 py-[18px]')}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-[16px] font-bold text-ink">
                {CATEGORY_LABEL[s.category]}
                <span className="ml-1.5 font-medium text-ink-muted">{s.count} {s.count === 1 ? 'rule' : 'rules'}</span>
              </h3>
              <p className={HINT}>{CATEGORY_HINT[s.category]}</p>
            </div>
            {adding !== s.category && (
              <button type="button" className={cn(BTN_QUIET, 'min-h-[36px] px-3 text-[13px]')} onClick={() => setAdding(s.category)}
                aria-label={`Add a ${CATEGORY_LABEL[s.category]} rule`}>
                <Plus size={15} strokeWidth={1.75} />Add rule
              </button>
            )}
          </div>
          {s.blocks.map((b) => <Block key={b.id} cardId={cardId} block={b} rules={rules} />)}
          {s.count === 0 && adding !== s.category && <p className="text-[13px] text-ink-muted">Nothing priced here. This card charges nothing for {CATEGORY_LABEL[s.category].toLowerCase()}.</p>}
          {adding === s.category && <AddRule cardId={cardId} category={s.category} zones={zones} onDone={() => setAdding(null)} />}
        </section>
      ))}
    </>
  );
};

/** Per category, its rule count: the sticky summary. */
export const categoryTotals = (rules: readonly RateRule[], unit: string) => layoutRateCard(rules, unit).map((s) => ({ category: s.category, count: s.count }));
