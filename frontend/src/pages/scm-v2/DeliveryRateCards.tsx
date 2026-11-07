// ----------------------------------------------------------------------------
// Carriers & Rates — Fleet Module C (mig 0207 / route delivery-rate-cards.ts).
//
// Build a delivery rate card per carrier (own-fleet + each 3PL), then verify a
// 3PL's billed charge against the COMPUTED expected cost and roll the precise
// delivery cost toward COGS. Three tabs:
//   - Rate Cards: the carrier list, the card editor (charging basis, charge per,
//     cap, rounding, active), its priced rules grouped by category, and a live
//     COST CALCULATOR that prices a set of facts against the card.
//   - 3PL invoices: what a transporter billed per DO, beside the rate card.
//   - Reconciliation: 3PL trips carrying a captured billed cost, each matched to
//     its carrier's card, with computed-expected vs billed and the flagged delta.
//     COST verification + COGS attribution, NOT customer billing.
// Styled after the Coverage & Fleet screens (owner design 2026-11-07).
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  useRateCards, useRateCard, useRateCardMeta,
  useCreateRateCard, useUpdateRateCard, useDeleteRateCard,
  useCreateRateRule, useUpdateRateRule, useDeleteRateRule, useComputeCost, useReconcile, type ReconcileRow,
  type RateCard, type RateRule, type RateRuleType, type DeliveryFacts, type RateAggregation,
} from '../../vendor/scm/lib/delivery-rate-card-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';
import { fmtDate, fmtSen } from '@2990s/shared';
import {
  RULE_LABEL, RULE_CATEGORY, CATEGORY_LABEL, CATEGORY_HINT,
  RATE_RULE_CATEGORIES, rulesByCategory, type RateRuleCategory, type RateRuleTypeT,
} from '../../vendor/scm/lib/rate-rule-taxonomy';
import { ThreePLCompanies } from './ThreePLCompanies';
import { ThreePLInvoices, useThreePLDoCharges, variance, type ChargeRow } from './ThreePLInvoices';
import { DateField } from '../../vendor/scm/components/DateField';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* What each charging unit means, in the operator's terms. The positional tiers
   run DOWN this unit — so "Customer" is what makes the second delivery to the
   same doorstep cheaper, and "Trip" is a flat price that ignores the load. */
const AGGREGATION_HINT: Record<RateAggregation, string> = {
  UNIT: 'Tiers run down the goods — 1st, 2nd, 3rd item on the trip.',
  DROP: 'Tiers run down the delivery orders. Five DOs is five charges, whatever each contains.',
  CUSTOMER: 'Two drops to the same buyer at the same address count once, so the second is cheaper.',
  TRIP: 'One charge for the whole trip. Tier 1 is the price; the load does not change it.',
};

/* Server values can outrun this build's lists, so lookups fall back rather than render blank. */
const aggHint = (a: string): string => (AGGREGATION_HINT as Partial<Record<string, string>>)[a] ?? AGGREGATION_HINT.UNIT;
const ruleLabel = (t: string): string => (RULE_LABEL as Partial<Record<string, string>>)[t] ?? t;
const ruleCategory = (t: string): RateRuleCategory => (RULE_CATEGORY as Partial<Record<string, RateRuleCategory>>)[t] ?? 'DELIVERY';

const centiToRM = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
const rmToSen = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/* Shared classes — the Coverage & Fleet tokens. */
const CARD = 'rounded-2xl border border-border bg-surface';
const LABEL = 'text-[12.5px] font-semibold text-ink-secondary';
const HINT = 'text-[12px] leading-snug text-ink-muted';
const INPUT = 'min-h-[40px] w-full rounded-lg border border-border bg-surface px-3 text-[14px] text-ink';
const EYEBROW = 'text-[12px] font-bold uppercase tracking-[0.06em] text-ink-muted';
const BTN_PRI = 'inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-primary px-4 text-[13.5px] font-semibold text-white disabled:opacity-60';
const BTN_QUIET = 'inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-surface-2 px-4 text-[13.5px] font-semibold text-ink disabled:opacity-60';
const ICON_BTN = 'grid h-9 w-9 flex-none place-items-center rounded-lg bg-surface-2 text-ink-secondary hover:text-[#8a2c2c] disabled:opacity-50';

/* The carrier list on this page comes from /delivery-rate-cards/meta, a DIFFERENT
   query from the one useCreateThreePLCompany invalidates — and it holds for five
   minutes. Without this, registering a carrier in the drawer and then trying to
   price it would show a list that does not contain it. */
const COMPANY_LIST_KEY = ['delivery-rate-card-meta'];
type Tab = 'cards' | 'invoices' | 'reconcile';
const TAB_LABEL: Record<Tab, string> = { cards: 'Rate Cards', invoices: '3PL invoices', reconcile: 'Reconciliation' };

export const DeliveryRateCards = ({ embedded = false }: {
  embedded?: boolean;
} = {}) => {
  const [tab, setTab] = useState<Tab>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ carrierCompanyId: string | null } | null>(null);
  const [companiesOpen, setCompaniesOpen] = useState(false);
  const cards = useRateCards();
  const meta = useRateCardMeta();
  const qc = useQueryClient();

  /* The 3PL master opens from the top right of this page (owner 2026-08-02:
     "3PL 的入口在rates 的右上角 点开"): a rate card is priced PER CARRIER, so
     the carrier list here IS the 3PL master. */
  const onCreateCompany = () => setCompaniesOpen(true);
  const closeCompanies = () => {
    setCompaniesOpen(false);
    void qc.invalidateQueries({ queryKey: COMPANY_LIST_KEY });
  };

  const actions = tab === 'cards' ? (
    <div className="flex flex-wrap gap-2.5">
      <button type="button" className={BTN_QUIET} onClick={onCreateCompany}><Plus {...ICON} />New 3PL Company</button>
      <button type="button" className={BTN_PRI} onClick={() => setCreating({ carrierCompanyId: null })}><Plus {...ICON} />New Card</button>
    </div>
  ) : null;

  return (
    <div className="space-y-5">
      {!embedded && (
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1.5">
            <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-primary">Delivery</div>
            <h1 className="text-[28px] font-bold tracking-tight text-ink">Carriers &amp; Rates</h1>
            <p className="max-w-[760px] text-[13px] text-ink-muted">
              A rate card per carrier (own fleet and each 3PL). Check a 3PL&rsquo;s bill against what its card says it should cost. This is cost checking, not customer billing.
            </p>
          </div>
          {actions}
        </header>
      )}

      <nav aria-label="Sections" className="flex items-center gap-1 overflow-x-auto border-b border-border">
        {(['cards', 'invoices', 'reconcile'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t}
            className={cn('min-h-[44px] whitespace-nowrap border-b-2 px-4 text-[14px]',
              tab === t ? 'border-primary font-bold text-primary' : 'border-transparent font-medium text-ink-muted hover:text-ink')}>
            {TAB_LABEL[t]}
          </button>
        ))}
        {/* Embedded there is no header, so the tab strip carries the actions. */}
        {embedded && actions && <div className="ml-auto pb-1.5">{actions}</div>}
      </nav>

      {tab === 'cards' ? (
        <div className="flex flex-wrap items-start gap-5">
          <CardList
            cards={cards.data ?? []}
            companies={meta.data?.companies ?? []}
            isLoading={cards.isLoading || meta.isLoading}
            loadFailed={cards.isError || meta.isError}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreateFor={(carrierCompanyId) => setCreating({ carrierCompanyId })}
            onCreateCompany={onCreateCompany}
          />
          <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-5">
            {selectedId
              ? <CardEditor key={selectedId} cardId={selectedId} onDeleted={() => setSelectedId(null)} />
              : <div className={cn(CARD, 'p-10 text-center text-[14px] text-ink-muted')}>Select a card to edit its rules, or create one.</div>}
          </div>
        </div>
      ) : tab === 'invoices' ? <ThreePLInvoices /> : (
        <ReconcileView />
      )}

      {creating && (
        <CreateCardDrawer
          initialCarrierCompanyId={creating.carrierCompanyId}
          onClose={() => setCreating(null)}
          onCreated={(id) => { setCreating(null); setSelectedId(id); }}
        />
      )}

      {/* The standalone ThreePLCompanies screen verbatim (`embedded` drops its
          header), so registering a carrier here and at /scm/threepl-companies
          are the same code path. */}
      {companiesOpen && (
        <ResizableDrawer onClose={closeCompanies} storageKey="carriers-3pl-drawer" defaultWidth={760} ariaLabel="3PL Companies"
          title="3PL Companies" subtitle="Each carrier, its lorries, drivers and helpers">
          <div className="p-4"><ThreePLCompanies embedded /></div>
        </ResizableDrawer>
      )}
    </div>
  );
};

// ── Carrier list ────────────────────────────────────────────────
// Owner's flow (2026-08-01): register the 3PL companies first, then come here to
// see what each one charges. So the list IS the carrier list — every registered
// 3PL appears, whether or not it has a card yet, and a carrier with no card is a
// one-click create. Own-fleet cost structures keep their own group below.
const CardList = ({ cards, companies, isLoading, loadFailed, selectedId, onSelect, onCreateFor, onCreateCompany }: {
  cards: RateCard[];
  companies: Array<{ id: string; name: string }>;
  isLoading: boolean;
  loadFailed: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateFor: (carrierCompanyId: string | null) => void;
  onCreateCompany: () => void;
}) => {
  const byCompany = new Map<string, RateCard>();
  for (const c of cards) if (c.carrierCompanyId) byCompany.set(c.carrierCompanyId, c);
  const listed = new Set(companies.map((co) => co.id));
  const ownFleet = cards.filter((c) => cardKind(c, listed) === 'own');
  /* A card whose 3PL company was deleted (before deleting one with a card was
     refused) has no carrier but was never own fleet; a card whose company is
     inactive is not in the carrier list. Neither may hide or vanish. */
  const others = cards.filter((c) => cardKind(c, listed) === 'removed' || cardKind(c, listed) === 'inactive');

  const summary = (c: RateCard) => {
    const n = c.ruleCount ?? 0;
    return `${c.basis} · per ${c.aggregation.toLowerCase()} · ${n} ${n === 1 ? 'rule' : 'rules'}${c.isActive ? '' : ' · inactive'}`;
  };
  const row = (key: string, on: boolean, name: string, sub: string, subTone: string, onClick: () => void) => (
    <button key={key} type="button" onClick={onClick}
      className={cn('flex w-full flex-col items-start gap-0.5 px-[18px] py-[11px] text-left', on ? 'bg-[#eef6f3]' : 'hover:bg-surface-2')}>
      <span className="text-[14px] font-bold text-ink">{name}</span>
      <span className={cn('text-[12.5px]', subTone)}>{sub}</span>
    </button>
  );

  return (
    <aside className={cn(CARD, 'w-full py-2 md:w-auto md:min-w-[240px] md:flex-[0_1_300px]')}>
      <div className={cn(EYEBROW, 'px-[18px] pb-2 pt-3')}>{companies.length} {companies.length === 1 ? 'carrier' : 'carriers'}</div>
      {isLoading && <p className="px-[18px] py-3 text-[13px] text-ink-muted">Loading…</p>}
      {loadFailed && <p className="px-[18px] py-3 text-[13px] text-[#8a2c2c]">The carriers did not load.</p>}
      {!isLoading && !loadFailed && companies.length === 0 && (
        <p className="px-[18px] py-3 text-[13px] leading-normal text-ink-secondary">
          No 3PL companies registered yet. A rate card is priced per carrier, so there is nothing to price until one exists.{' '}
          <button type="button" onClick={onCreateCompany} className="font-semibold text-primary hover:underline">Register one now</button>
        </p>
      )}
      {companies.map((co) => {
        const card = byCompany.get(co.id);
        return row(co.id, !!card && selectedId === card.id, co.name,
          card ? summary(card) : 'No rate card yet. Click to add',
          card ? 'text-ink-muted' : 'font-semibold text-primary',
          () => (card ? onSelect(card.id) : onCreateFor(co.id)));
      })}
      {ownFleet.length > 0 && (
        <>
          <div className={cn(EYEBROW, 'px-[18px] pb-1.5 pt-3.5')}>Own fleet</div>
          {ownFleet.map((c) => row(c.id, selectedId === c.id, c.name, summary(c), 'text-ink-muted', () => onSelect(c.id)))}
        </>
      )}
      {others.length > 0 && (
        <>
          <div className={cn(EYEBROW, 'px-[18px] pb-1.5 pt-3.5')}>Needs a carrier</div>
          {others.map((c) => row(c.id, selectedId === c.id, c.name,
            `${cardKind(c, listed) === 'removed' ? 'Carrier removed' : 'Carrier inactive'} · ${summary(c)}`,
            'font-semibold text-[#80501c]', () => onSelect(c.id)))}
        </>
      )}
    </aside>
  );
};

/* own: our own cost structure. carrier: an active 3PL's card. removed: its 3PL
   company was deleted (carrier nulled, never own fleet). inactive: its 3PL
   company is set inactive, so the carrier list omits it. */
type CardKind = 'own' | 'carrier' | 'removed' | 'inactive';
const cardKind = (c: RateCard, listed: ReadonlySet<string>): CardKind =>
  c.carrierCompanyId ? (listed.has(c.carrierCompanyId) ? 'carrier' : 'inactive') : c.isOwnFleet ? 'own' : 'removed';

// ── Card editor (fields + rules + calculator) ────────────────────────────────
const CardEditor = ({ cardId, onDeleted }: { cardId: string; onDeleted: () => void }) => {
  const detail = useRateCard(cardId);
  const meta = useRateCardMeta();
  const update = useUpdateRateCard();
  const del = useDeleteRateCard();
  const askConfirm = useConfirm();

  const allCards = useRateCards();
  const card = detail.data?.card;
  const rules = detail.data?.rules ?? [];
  const companies = meta.data?.companies ?? [];

  if (detail.isError) return <div className={cn(CARD, 'p-6 text-[13px] text-[#8a2c2c]')}>This card did not load.</div>;
  if (detail.isLoading || !card) return <div className={cn(CARD, 'p-6 text-[13px] text-ink-muted')}>Loading card…</div>;

  const kind = cardKind(card, new Set(companies.map((co) => co.id)));
  /* The card name was copied from the company once; show the company's
     current name so a renamed carrier does not keep its old one here. */
  const title = (card.carrierCompanyId ? companies.find((co) => co.id === card.carrierCompanyId)?.name : null) ?? card.name;
  const taken = new Set((allCards.data ?? []).map((c) => c.carrierCompanyId));
  const freeCarriers = companies.filter((co) => !taken.has(co.id));

  const patch = (body: Record<string, unknown>) =>
    update.mutate({ id: cardId, ...body }, { onError: writeFailedAs('The card was not updated') });

  const removeCard = async () => {
    if (!(await askConfirm({ title: `Delete card "${card.name}"?`, body: 'Its rules are removed too. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    del.mutate(cardId, { onSuccess: onDeleted, onError: writeFailedAs('The card was not deleted') });
  };

  return (
    <>
      <section className={cn(CARD, 'flex flex-col gap-[18px] px-6 py-[22px]')}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[20px] font-bold text-ink">{title}</h2>
          <button type="button" className={ICON_BTN} onClick={() => void removeCard()} disabled={del.isPending} aria-label="Delete card"><Trash2 {...ICON} /></button>
        </div>
        {(kind === 'removed' || kind === 'inactive') && (
          <div className="flex flex-wrap items-end gap-3 rounded-xl bg-[#f6ecd4] px-4 py-3 text-[13px] text-[#5a3a14]">
            <p className="min-w-[220px] flex-[1_1_260px]">
              {kind === 'removed'
                ? 'This card’s 3PL company was deleted, so the card belongs to no carrier. Move it to a carrier, or delete it.'
                : 'This card’s 3PL company is set inactive, so it is not in the carrier list. Set the company active again, move the card to another carrier, or delete it.'}
            </p>
            {freeCarriers.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-semibold">Move to carrier</span>
                <select className={cn(INPUT, 'min-w-[200px]')} value="" disabled={update.isPending}
                  onChange={(e) => { if (e.target.value) patch({ carrierCompanyId: e.target.value }); }}>
                  <option value="">Choose a carrier…</option>
                  {freeCarriers.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="grid gap-x-5 gap-y-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          <Field label="Charging basis">
            <select className={INPUT} value={card.basis} onChange={(e) => patch({ basis: e.target.value })}>
              <option value="SET">By set (frame+mattress)</option>
              <option value="ITEM">By item</option>
            </select>
          </Field>
          {/* WIRED since mig 0244 — this is what the tier ladder counts. */}
          <Field label="Charge per" hint={aggHint(card.aggregation)}>
            <select className={INPUT} value={card.aggregation} onChange={(e) => patch({ aggregation: e.target.value })}>
              <option value="UNIT">{card.basis === 'ITEM' ? 'Item' : 'Set'}</option>
              <option value="DROP">Drop point (per DO)</option>
              <option value="CUSTOMER">Customer (same address, same day)</option>
              <option value="TRIP">Trip (flat, whatever it carries)</option>
            </select>
          </Field>
          {/* WHO the card belongs to is a FACT here, not a control (owner
              2026-08-02): you reached this card by clicking that carrier, so
              re-picking it could only make the editor disagree with its own
              heading. Own fleet IS "no carrier", derived server-side (mig 0246). */}
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Carrier</span>
            <span className="py-2.5 text-[14px] font-semibold text-ink">
              {kind === 'own' ? 'Own fleet' : kind === 'removed' ? 'Carrier removed' : title}
            </span>
            <span className={HINT}>
              {kind === 'own'
                ? 'Our own cost structure, so a 3PL drop and an own-fleet drop compare.'
                : kind === 'removed' ? 'Its 3PL company no longer exists.'
                : 'One card per 3PL company. To price a different carrier, open that carrier.'}
            </span>
          </div>
          <RMField label="Minimum charge (RM)" placeholder="No minimum" hint="The least the card ever charges."
            value={centiToRM(card.minChargeSen)} onCommit={(v) => patch({ minChargeSen: v.trim() === '' ? null : rmToSen(v) })} />
          <RMField label="Cap (RM)" placeholder="No cap" hint="The most the card ever charges."
            value={centiToRM(card.capSen)} onCommit={(v) => patch({ capSen: v.trim() === '' ? null : rmToSen(v) })} />
          <Field label="Rounding">
            <select className={INPUT} value={card.rounding} onChange={(e) => patch({ rounding: e.target.value })}>
              <option value="NONE">None</option>
              <option value="NEAREST_10C">Nearest 10 sen</option>
              <option value="NEAREST_RM">Nearest RM</option>
            </select>
          </Field>
          <label className="flex cursor-pointer items-center gap-2.5 pt-[22px] text-[14px] font-semibold text-ink">
            <input type="checkbox" className="h-[18px] w-[18px] accent-[#16695f]" checked={card.isActive} disabled={update.isPending}
              onChange={(e) => patch({ isActive: e.target.checked })} />
            Active
          </label>
        </div>
      </section>

      <RulesEditor cardId={cardId} rules={rules} zones={meta.data?.zones ?? []} />
      <CalculatorPanel cardId={cardId} basis={card.basis} zones={meta.data?.zones ?? []} rules={rules} />
    </>
  );
};

// ── Rules editor ──────────────────────────────────────────────────────────────
const ordinal = (n: number | null) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd+' : `${n}th`);
const describeRule = (r: RateRule): string => {
  if (r.ruleType === 'POSITIONAL_TIER') return `${ordinal(r.tierPosition)} unit`;
  if (r.ruleType === 'OVERAGE') return `beyond cap ${r.tierPosition}, each`;
  if (r.ruleType === 'SOFA_BRACKET') return `${r.bracketMin}${r.bracketMax == null ? '+' : `-${r.bracketMax}`} compartments`;
  if (r.ruleType === 'OUTSTATION') return `${r.zone ?? ''} · per order`;
  if (r.ruleType === 'OUTSTATION_TRIP') return `${r.zone ?? ''} · fixed per trip`;
  return 'each occurrence';
};
const RULE_GRID = 'grid grid-cols-[1.3fr_1.3fr_.9fr_76px] items-center gap-3 px-6';

/* One rule. Its amount is edited in place (PATCH): a carrier raising one price
   used to mean deleting the rule and adding it again. */
const RuleRow = ({ cardId, rule }: { cardId: string; rule: RateRule }) => {
  const update = useUpdateRateRule(cardId);
  const del = useDeleteRateRule(cardId);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const amountSen = rmToSen(draft);
    if (draft.trim() === '' || amountSen == null) { setErr('Enter a non-negative RM amount.'); return; }
    if (amountSen === rule.amountSen) { setDraft(null); return; }
    update.mutate({ id: rule.id, amountSen }, {
      onSuccess: () => { setDraft(null); setErr(null); },
    }); // the hook's own onError (writeFailed) shows a refusal
  };
  return (
    <div className={cn(RULE_GRID, 'py-[7px] text-[13.5px]')}>
      <span className="font-semibold text-ink">{ruleLabel(rule.ruleType)}</span>
      <span className="text-ink-secondary">{describeRule(rule)}</span>
      {draft === null ? (
        <span className="text-right font-semibold tabular-nums text-ink">{centiToRM(rule.amountSen)}</span>
      ) : (
        <span className="flex flex-col items-end gap-0.5">
          <input autoFocus className={cn(INPUT, 'min-h-[34px] text-right')} inputMode="decimal" aria-label={`Amount for ${ruleLabel(rule.ruleType)}`}
            value={draft} onChange={(e) => { setErr(null); setDraft(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(null); setErr(null); } }} />
          {err && <span role="alert" className="text-[11.5px] font-semibold text-[#8a2c2c]">{err}</span>}
        </span>
      )}
      <span className="flex justify-end gap-1">
        {draft === null ? (
          <button type="button" className={cn(ICON_BTN, 'h-8 w-8 hover:text-primary')} onClick={() => setDraft(centiToRM(rule.amountSen))}
            aria-label={`Edit amount for ${ruleLabel(rule.ruleType)}`}><Pencil size={14} strokeWidth={1.75} /></button>
        ) : (
          <>
            <button type="button" className={cn(ICON_BTN, 'h-8 w-8 hover:text-primary')} onClick={save} disabled={update.isPending} aria-label="Save amount"><Check size={14} strokeWidth={1.75} /></button>
            <button type="button" className={cn(ICON_BTN, 'h-8 w-8')} onClick={() => { setDraft(null); setErr(null); }} aria-label="Cancel"><X size={14} strokeWidth={1.75} /></button>
          </>
        )}
        {draft === null && (
          <button type="button" className={cn(ICON_BTN, 'h-8 w-8')} disabled={del.isPending}
            onClick={() => del.mutate(rule.id, { onError: writeFailedAs('The rule was not deleted') })}
            aria-label={`Delete ${ruleLabel(rule.ruleType)} rule`}><Trash2 size={14} strokeWidth={1.75} /></button>
        )}
      </span>
    </div>
  );
};

const RulesEditor = ({ cardId, rules, zones }: { cardId: string; rules: RateRule[]; zones: string[] }) => {
  const create = useCreateRateRule(cardId);
  const [err, setErr] = useState<string | null>(null);

  const [form, setForm] = useState<{ ruleType: RateRuleType; tierPosition: string; bracketMin: string; bracketMax: string; zone: string; amountRM: string }>({
    ruleType: 'POSITIONAL_TIER', tierPosition: '1', bracketMin: '', bracketMax: '', zone: zones[0] ?? 'MELAKA', amountRM: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => { setErr(null); setForm((s) => ({ ...s, [k]: v })); };

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

  /* Grouped by CATEGORY, not sorted alphabetically, so the rules that price a
     delivery sit together. An unknown rule type falls into Delivery rather than
     vanishing — a rule the operator can see and delete beats one that hides. */
  const grouped = useMemo(() => {
    const order = new Map<RateRuleCategory, number>(RATE_RULE_CATEGORIES.map((cat, i) => [cat, i]));
    const byCat = new Map<RateRuleCategory, RateRule[]>();
    for (const r of rules) {
      const cat = ruleCategory(r.ruleType);
      (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(r);
    }
    return [...byCat.entries()]
      .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99))
      .map(([category, list]) => ({
        category,
        rules: list.sort((a, b) =>
          (a.tierPosition ?? 0) - (b.tierPosition ?? 0)
          || (a.bracketMin ?? 0) - (b.bracketMin ?? 0)
          || a.ruleType.localeCompare(b.ruleType)),
      }));
  }, [rules]);

  const needsPosition = form.ruleType === 'POSITIONAL_TIER' || form.ruleType === 'OVERAGE';
  const needsBracket = form.ruleType === 'SOFA_BRACKET';
  const needsZone = form.ruleType === 'OUTSTATION' || form.ruleType === 'OUTSTATION_TRIP';

  return (
    <section className={cn(CARD, 'overflow-hidden')}>
      <h3 className="px-6 pb-2 pt-[18px] text-[16px] font-bold text-ink">Rules ({rules.length})</h3>
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          <div className={cn(RULE_GRID, 'border-b border-border py-2.5 text-[11.5px] font-bold uppercase tracking-[0.05em] text-ink-muted')}>
            <span>Type</span><span>Applies to</span><span className="text-right">Amount (RM)</span><span />
          </div>
          {grouped.map(({ category, rules: list }) => (
            <div key={category}>
              <div className="flex flex-col gap-0.5 px-6 pb-1.5 pt-3.5">
                <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-primary">{CATEGORY_LABEL[category]}</span>
                <span className="text-[12.5px] text-ink-muted">{CATEGORY_HINT[category]}</span>
              </div>
              {list.map((r) => <RuleRow key={r.id} cardId={cardId} rule={r} />)}
            </div>
          ))}
          {rules.length === 0 && <p className="px-6 py-[18px] text-[13.5px] text-ink-muted">No rules yet. Add one below.</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-border bg-surface-2/60 px-6 py-[18px]">
        <Field label="Rule type" className="flex-[1_1_220px]">
          {/* optgroup, so the operator finds the rule for the job by its group. */}
          <select className={INPUT} value={form.ruleType} onChange={(e) => set('ruleType', e.target.value as RateRuleType)}>
            {rulesByCategory().map(({ category, types }) => (
              <optgroup key={category} label={CATEGORY_LABEL[category]}>
                {types.map((t) => <option key={t} value={t}>{RULE_LABEL[t]}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        {needsPosition && (
          <Field label={form.ruleType === 'OVERAGE' ? 'Cap N' : 'Position (3=3rd+)'} className="flex-[0_1_140px]">
            <input className={INPUT} inputMode="numeric" value={form.tierPosition} onChange={(e) => set('tierPosition', e.target.value)} />
          </Field>
        )}
        {needsBracket && (
          <>
            <Field label="Comp min" className="flex-[0_1_120px]">
              <input className={INPUT} inputMode="numeric" value={form.bracketMin} onChange={(e) => set('bracketMin', e.target.value)} />
            </Field>
            <Field label="Comp max (blank=+)" className="flex-[0_1_150px]">
              <input className={INPUT} inputMode="numeric" value={form.bracketMax} onChange={(e) => set('bracketMax', e.target.value)} />
            </Field>
          </>
        )}
        {needsZone && (
          <Field label="Zone or town" className="flex-[1_1_200px]">
            <input className={INPUT} list="rate-zone-list" value={form.zone} onChange={(e) => set('zone', e.target.value)} placeholder="KL, JOHOR, or a town e.g. RAWANG" />
            <datalist id="rate-zone-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
        )}
        <Field label="Amount (RM)" className="flex-[0_1_140px]">
          <input className={INPUT} inputMode="decimal" value={form.amountRM} onChange={(e) => set('amountRM', e.target.value)} />
        </Field>
        <button type="button" className={BTN_PRI} onClick={addRule} disabled={create.isPending}><Plus {...ICON} />{create.isPending ? 'Adding…' : 'Add rule'}</button>
        {err && <p role="alert" className="basis-full text-[13px] font-semibold text-[#8a2c2c]">{err}</p>}
      </div>
    </section>
  );
};

/* Which calculator input feeds which rule, in the same four groups as the rules
   table. `rule: null` means the input is not gated on one rule — the set/item
   count feeds the tier ladder and the zone feeds both outstation kinds. */
type CalcKey = 'count' | 'sofa' | 'zone' | 'dispose' | 'setup' | 'dismantle' | 'service' | 'pickup' | 'inspection' | 'supplierPickup' | 'transfer';
const CALC_GROUPS: Array<{ category: RateRuleCategory; fields: Array<{ key: CalcKey; label: string; rule: RateRuleTypeT | null }> }> = [
  { category: 'DELIVERY', fields: [
    { key: 'count', label: 'Sets', rule: null },
    { key: 'sofa', label: 'Sofa comps (e.g. 3,6)', rule: 'SOFA_BRACKET' },
    { key: 'dispose', label: 'Dispose', rule: 'DISPOSE' },
  ] },
  { category: 'SITE_WORK', fields: [
    { key: 'setup', label: 'Setup', rule: 'SETUP' },
    { key: 'dismantle', label: 'Dismantle', rule: 'DISMANTLE' },
  ] },
  { category: 'SERVICE_CALL', fields: [
    { key: 'service', label: 'Service', rule: 'SERVICE' },
    { key: 'pickup', label: 'Pickup', rule: 'PICKUP' },
    { key: 'inspection', label: 'Inspection', rule: 'INSPECTION' },
    { key: 'supplierPickup', label: 'Supplier pickup', rule: 'SUPPLIER_PICKUP' },
    { key: 'transfer', label: 'Transfer', rule: 'TRANSFER' },
  ] },
  { category: 'OUTSTATION', fields: [
    { key: 'zone', label: 'Destination zone', rule: null },
  ] },
];

// ── Cost calculator (live) ────────────────────────────────────────────────────
const CalculatorPanel = ({ cardId, basis, zones, rules }: { cardId: string; basis: string; zones: string[]; rules: RateRule[] }) => {
  const compute = useComputeCost(cardId);
  const [facts, setFacts] = useState<Record<CalcKey, string>>(
    { count: '2', sofa: '3', zone: '', dispose: '1', setup: '1', dismantle: '1', service: '', pickup: '', inspection: '', supplierPickup: '', transfer: '' },
  );
  const set = (k: CalcKey, v: string) => setFacts((s) => ({ ...s, [k]: v }));

  const run = () => {
    const num = (v: string): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const sofaCompartments = facts.sofa.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    const body: DeliveryFacts = {
      [basis === 'ITEM' ? 'itemCount' : 'setCount']: num(facts.count),
      sofaCompartments: sofaCompartments.length ? sofaCompartments : null,
      destinationZone: facts.zone || null,
      disposeCount: num(facts.dispose), setupCount: num(facts.setup), dismantleCount: num(facts.dismantle),
      serviceCount: num(facts.service), pickupCount: num(facts.pickup), inspectionCount: num(facts.inspection),
      supplierPickupCount: num(facts.supplierPickup), transferCount: num(facts.transfer),
    };
    compute.mutate(body); // useComputeCost shows its own failure (writeFailed)
  };

  /* Which rule types this card actually carries — drives the dimming. An input
     whose rule this card does not carry cannot change the total, and says so. */
  const present = useMemo(() => new Set(rules.map((r) => r.ruleType as string)), [rules]);
  const zoneOptions = useMemo(
    () => [...new Set([...zones, ...rules.filter((r) => (r.ruleType === 'OUTSTATION' || r.ruleType === 'OUTSTATION_TRIP') && r.zone).map((r) => r.zone as string)])],
    [zones, rules],
  );
  const breakdown = compute.data?.breakdown;

  return (
    <section className={cn(CARD, 'flex flex-col gap-[18px] px-6 py-[22px]')}>
      <div>
        <h3 className="text-[16px] font-bold text-ink">Cost calculator</h3>
        <p className={cn(HINT, 'mt-1')}>
          Price a drop against this card. Sofas are priced by their compartment bracket (comma-separated, one per sofa), apart from the {basis === 'ITEM' ? 'item' : 'set'} tiers.
        </p>
      </div>
      {CALC_GROUPS.map(({ category, fields }) => {
        const anyPriced = fields.some((f) => f.rule === null || present.has(f.rule));
        return (
          <div key={category} className="flex flex-col gap-2.5">
            <span className={EYEBROW}>
              {CATEGORY_LABEL[category]}
              {!anyPriced && <span className="ml-2 font-medium normal-case tracking-normal">This card has no rules here, so these stay at zero</span>}
            </span>
            <div className="flex flex-wrap gap-3">
              {fields.map((f) => {
                const priced = f.rule === null || present.has(f.rule);
                if (f.key === 'zone') {
                  return (
                    <Field key={f.key} label="Destination zone" className="flex-[0_1_220px]">
                      <select className={INPUT} value={facts.zone} onChange={(e) => set('zone', e.target.value)}>
                        <option value="">In-town</option>
                        {zoneOptions.map((z) => <option key={z} value={z}>{z}</option>)}
                      </select>
                    </Field>
                  );
                }
                return (
                  <label key={f.key} className={cn('flex flex-[0_1_150px] flex-col gap-1.5', !priced && 'opacity-40')}
                    title={priced || !f.rule ? undefined : `This card has no ${RULE_LABEL[f.rule]} rule, so this input cannot change the total.`}>
                    <span className={LABEL}>{f.key === 'count' ? (basis === 'ITEM' ? 'Items' : 'Sets') : f.label}</span>
                    <input className={INPUT} inputMode={f.key === 'sofa' ? 'text' : 'numeric'} value={facts[f.key]} onChange={(e) => set(f.key, e.target.value)} />
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      <div>
        <button type="button" className={BTN_PRI} onClick={run} disabled={compute.isPending}>{compute.isPending ? 'Computing…' : 'Compute cost'}</button>
      </div>
      {breakdown && (
        <div className="flex flex-col gap-1.5 rounded-[14px] bg-[#f4f8f6] px-[18px] py-3.5">
          {breakdown.lines.map((l, i) => (
            <div key={i} className={cn('flex justify-between gap-3 text-[13.5px]', l.amountSen < 0 ? 'text-ink-muted' : 'text-ink')}>
              <span>{l.label}</span>
              <span className="tabular-nums">{l.amountSen < 0 ? '−' : ''}{fmtSen(Math.abs(l.amountSen))}</span>
            </div>
          ))}
          <div className="flex justify-between border-t border-[#d5e5df] pt-2 text-[16px] font-bold text-[#0b4740]">
            <span>Total</span><span className="tabular-nums">{fmtSen(breakdown.totalSen)}</span>
          </div>
        </div>
      )}
    </section>
  );
};

// ── Reconciliation view ────────────────────────────────────────────────────────
const reconStatus = (r: ReconcileRow): string => (!r.matched ? 'unmatched' : r.flagged ? 'mismatch' : 'match');
const RECON_COLUMNS: Column<ReconcileRow>[] = [
  { key: 'trip', label: 'Trip', render: (r) => <span className="font-semibold">{r.tripNo ?? r.tripId.slice(0, 8)}</span>, getValue: (r) => r.tripNo ?? r.tripId },
  { key: 'date', label: 'Date', render: (r) => (r.tripDate ? fmtDate(r.tripDate) : '—'), getValue: (r) => r.tripDate, exportFormat: 'date' },
  { key: 'card', label: 'Card', render: (r) => (r.matched ? r.cardName : <span className="text-ink-muted">no card</span>), getValue: (r) => (r.matched ? r.cardName ?? '' : '') },
  { key: 'drops', label: 'Drops', align: 'right', render: (r) => r.dropCount, getValue: (r) => r.dropCount },
  { key: 'zone', label: 'Zone', render: (r) => r.derivedZone ?? '—', getValue: (r) => r.derivedZone ?? '' },
  {
    key: 'expected', label: 'Expected', align: 'right', render: (r) => fmtSen(r.expectedSen),
    getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100), exportFormat: 'money',
  },
  {
    key: 'billed', label: 'Billed', align: 'right', render: (r) => fmtSen(r.billedSen),
    getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100, exportFormat: 'money',
  },
  {
    key: 'delta', label: 'Delta', align: 'right',
    render: (r) => (
      <span className={r.flagged ? 'font-bold text-[#8a2c2c]' : 'text-ink-muted'}>
        {r.deltaSen == null ? '—' : `${r.deltaSen > 0 ? '+' : r.deltaSen < 0 ? '−' : ''}${fmtSen(Math.abs(r.deltaSen))}`}
      </span>
    ),
    getValue: (r) => r.deltaSen, exportValue: (r) => (r.deltaSen == null ? null : r.deltaSen / 100), exportFormat: 'money',
  },
  {
    key: 'status', label: 'Status',
    render: (r) => (
      <>
        {!r.matched ? <span className="text-ink-muted">unmatched</span>
          : r.flagged ? <span className="rounded-full bg-[#f6dcdc] px-2 py-0.5 text-[11.5px] font-semibold text-[#8a2c2c]">mismatch</span>
          : <span className="rounded-full bg-[#dcebe3] px-2 py-0.5 text-[11.5px] font-semibold text-[#1f5c43]">match</span>}
        {r.matched && !r.factsComplete && <span className="text-[11px] text-ink-muted"> · facts partial</span>}
      </>
    ),
    getValue: reconStatus,
  },
];
/* Per 3PL, from what its bills say (the 3PL invoices tab), against the rate card.
   The trip table below reads trips.three_pl_cost_sen, which nothing on screen
   writes and which 3PL work rarely has (it is not planned as trips), so on its
   own this tab was always empty. The billed cost that IS recorded is per DO. */
type CarrierRecon = { carrierId: string; carrierName: string; dos: number; billedSen: number; billedPricedSen: number; expectedSen: number; priced: number; off: number; noCard: number };
const carrierRecon = (rows: readonly ChargeRow[]): CarrierRecon[] => {
  const by = new Map<string, CarrierRecon>();
  for (const r of rows) {
    const t = by.get(r.carrierId) ?? { carrierId: r.carrierId, carrierName: r.carrierName ?? '—', dos: 0, billedSen: 0, billedPricedSen: 0, expectedSen: 0, priced: 0, off: 0, noCard: 0 };
    t.dos += 1;
    t.billedSen += r.billedSen;
    if (r.expectedSen == null) t.noCard += 1;
    else { t.expectedSen += r.expectedSen; t.billedPricedSen += r.billedSen; t.priced += 1; if (r.varianceSen) t.off += 1; }
    by.set(r.carrierId, t);
  }
  return [...by.values()].sort((a, b) => a.carrierName.localeCompare(b.carrierName));
};
const CARRIER_COLUMNS: Column<CarrierRecon>[] = [
  { key: 'carrier', label: '3PL', render: (r) => <span className="font-semibold">{r.carrierName}</span>, getValue: (r) => r.carrierName },
  { key: 'dos', label: 'DOs', align: 'right', render: (r) => r.dos, getValue: (r) => r.dos },
  { key: 'billed', label: 'Billed', align: 'right', render: (r) => fmtSen(r.billedSen), getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100, exportFormat: 'money' },
  { key: 'expected', label: 'Rate card', align: 'right', render: (r) => (r.priced ? fmtSen(r.expectedSen) : '—'), getValue: (r) => r.expectedSen, exportValue: (r) => r.expectedSen / 100, exportFormat: 'money' },
  {
    key: 'diff', label: 'Difference', align: 'right',
    /* Over the DOs the card prices only: a DO with no card has no expected cost to differ from. */
    render: (r) => (r.priced ? variance(r.billedPricedSen - r.expectedSen) : <span className="text-ink-muted">no rate card</span>),
    getValue: (r) => (r.priced ? r.billedPricedSen - r.expectedSen : null),
    exportValue: (r) => (r.priced ? (r.billedPricedSen - r.expectedSen) / 100 : null), exportFormat: 'money',
  },
  { key: 'off', label: 'DOs off the card', align: 'right', render: (r) => (r.off ? <span className="font-bold text-[#8a2c2c]">{r.off}</span> : 0), getValue: (r) => r.off },
  { key: 'nocard', label: 'No rate card', align: 'right', render: (r) => (r.noCard ? <span className="font-semibold text-[#80501c]">{r.noCard}</span> : 0), getValue: (r) => r.noCard },
];
const DO_COLUMNS: Column<ChargeRow>[] = [
  { key: 'do', label: 'DO', render: (r) => <span className="font-semibold">{r.doNumber ?? '—'}</span>, getValue: (r) => r.doNumber ?? '' },
  { key: 'carrier', label: '3PL', render: (r) => r.carrierName ?? '—', getValue: (r) => r.carrierName ?? '' },
  { key: 'inv', label: 'Invoice', render: (r) => [r.invoiceNo, r.invoiceDate && fmtDate(r.invoiceDate)].filter(Boolean).join(' · ') || '—', getValue: (r) => r.invoiceNo ?? '' },
  { key: 'billed', label: 'Billed', align: 'right', render: (r) => fmtSen(r.billedSen), getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100, exportFormat: 'money' },
  { key: 'expected', label: 'Rate card', align: 'right', render: (r) => (r.expectedSen == null ? '—' : fmtSen(r.expectedSen)), getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100), exportFormat: 'money' },
  { key: 'diff', label: 'Difference', align: 'right', render: (r) => variance(r.varianceSen), getValue: (r) => r.varianceSen, exportValue: (r) => (r.varianceSen == null ? null : r.varianceSen / 100), exportFormat: 'money' },
];

const ReconcileView = () => {
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const recon = useReconcile(range);
  const charges = useThreePLDoCharges(range);
  const rows = recon.data ?? [];
  const chargeRows = charges.data?.rows ?? [];
  const perCarrier = useMemo(() => carrierRecon(chargeRows), [chargeRows]);
  const offCard = useMemo(() => chargeRows.filter((r) => r.varianceSen == null || r.varianceSen !== 0), [chargeRows]);

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-[900px] text-[13px] text-ink-muted">
        What each 3PL billed, from its bills on the 3PL invoices tab, against what its rate card says. The rate card amount is worked out from each DO&rsquo;s sets / items and delivery zone; extras (setup, dismantle, disposal) and the per-trip outstation fee are not on the DO, so they show as a difference to check.
      </p>
      <div className="flex flex-wrap items-end gap-2.5">
        {(['from', 'to'] as const).map((k) => (
          <Field key={k} label={k === 'from' ? 'From' : 'To'} className="w-[170px]">
            <DateField className={INPUT} value={range[k]} onChange={(v) => setRange((s) => ({ ...s, [k]: v }))} fullWidth />
          </Field>
        ))}
        <span className={cn(HINT, 'pb-2.5')}>Invoice date for bills, trip date for trips.</span>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-[16px] font-bold text-ink">Per 3PL</h3>
        <div className={cn(CARD, 'overflow-hidden')}>
          <DataTable<CarrierRecon>
            tableId="rate-card-reconcile-carriers" exportName="3pl-reconciliation" exportXlsx
            columns={CARRIER_COLUMNS} rows={charges.data ? perCarrier : null} loading={charges.isLoading}
            error={charges.isError ? 'The 3PL bills did not load.' : null}
            emptyLabel="No 3PL bills in range. Key one in, or bring one in from an AP invoice, on the 3PL invoices tab."
            getRowKey={(r) => r.carrierId}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[16px] font-bold text-ink">DOs that differ from the rate card <span className="font-medium text-ink-muted">({offCard.length})</span></h3>
        <div className={cn(CARD, 'overflow-hidden')}>
          <DataTable<ChargeRow>
            tableId="rate-card-reconcile-dos" exportName="3pl-dos-off-card" exportXlsx
            columns={DO_COLUMNS} rows={charges.data ? offCard : null} loading={charges.isLoading}
            error={charges.isError ? 'The 3PL bills did not load.' : null}
            emptyLabel="Every billed DO in range matches its rate card."
            getRowKey={(r) => r.id}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[16px] font-bold text-ink">Trips with a 3PL cost</h3>
        <p className={HINT}>Outsourced trips planned in Delivery Planning that carry the 3PL&rsquo;s cost, priced from the trip&rsquo;s set count and zone (occurrence charges and sofa compartments are not on the trip: facts partial).</p>
        <div className={cn(CARD, 'overflow-hidden')}>
          <DataTable<ReconcileRow>
            tableId="rate-card-reconcile"
            exportName="rate-card-reconcile"
            exportXlsx
            columns={RECON_COLUMNS}
            rows={recon.data ? rows : null}
            loading={recon.isLoading}
            error={recon.isError ? 'The reconciliation did not load.' : null}
            emptyLabel="No 3PL trips with a captured billed cost in range."
            getRowKey={(r) => r.tripId}
            getRowStyle={(r) => (r.flagged ? { background: 'rgba(163,38,27,0.05)' } : undefined)}
          />
        </div>
      </section>
    </div>
  );
};

// ── Create-card drawer ─────────────────────────────────────────────────────────
const CreateCardDrawer = ({ initialCarrierCompanyId, onClose, onCreated }: {
  initialCarrierCompanyId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) => {
  const create = useCreateRateCard();
  const meta = useRateCardMeta();
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', carrierCompanyId: initialCarrierCompanyId ?? '', basis: 'SET' as 'SET' | 'ITEM', aggregation: 'UNIT' as RateAggregation });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => { setErr(null); setForm((s) => ({ ...s, [k]: v })); };

  const submit = () => {
    /* A carrier card is NAMED BY ITS COMPANY (server-side), so the name is only
       asked for — and only required — when there is no company to name it. */
    if (!form.carrierCompanyId && !form.name.trim()) { setErr('Pick a 3PL company, or name the card.'); return; }
    create.mutate(
      { name: form.carrierCompanyId ? undefined : form.name.trim(), carrierCompanyId: form.carrierCompanyId || null, basis: form.basis, aggregation: form.aggregation },
      { onSuccess: (r) => onCreated(r.card.id), onError: writeFailedAs('The card was not created') },
    );
  };

  return (
    <ResizableDrawer onClose={onClose} storageKey="carriers-new-card-drawer" defaultWidth={480} ariaLabel="New rate card" title="New Rate Card"
      footer={
        <div className="flex justify-end gap-2.5">
          <button type="button" className={BTN_QUIET} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRI} onClick={submit} disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create Card'}</button>
        </div>
      }>
      <div className="flex flex-col gap-4 p-4">
        {/* All registered carriers as pills (the design), plus Own fleet. */}
        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>3PL company (carrier) *</span>
          <div role="group" aria-label="3PL company" className="flex flex-wrap gap-1.5">
            {[{ id: '', name: 'Own fleet / none' }, ...(meta.data?.companies ?? [])].map((c) => (
              <button key={c.id || 'own'} type="button" aria-pressed={form.carrierCompanyId === c.id} onClick={() => set('carrierCompanyId', c.id)}
                className={cn('min-h-[36px] rounded-full border px-3 text-[13px] font-semibold',
                  form.carrierCompanyId === c.id ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-ink')}>
                {c.name}
              </button>
            ))}
          </div>
          <span className={HINT}>
            {form.carrierCompanyId ? 'The card takes the company name. One card per company.' : 'Register carriers with New 3PL Company.'}
          </span>
        </div>
        {!form.carrierCompanyId && (
          <Field label="Name *">
            <input className={INPUT} value={form.name} placeholder="e.g. Own fleet cost structure" onChange={(e) => set('name', e.target.value)} />
          </Field>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Charging basis">
            <select className={INPUT} value={form.basis} onChange={(e) => set('basis', e.target.value as 'SET' | 'ITEM')}>
              <option value="SET">By set</option><option value="ITEM">By item</option>
            </select>
          </Field>
          {/* All four, matching the editor; UNIT is the default since mig 0244. */}
          <Field label="Charge per">
            <select className={INPUT} value={form.aggregation} onChange={(e) => set('aggregation', e.target.value as RateAggregation)}>
              <option value="UNIT">{form.basis === 'ITEM' ? 'Item' : 'Set'}</option>
              <option value="DROP">Drop point (per DO)</option>
              <option value="CUSTOMER">Customer (same address, same day)</option>
              <option value="TRIP">Trip (flat, whatever it carries)</option>
            </select>
          </Field>
        </div>
        <p className={HINT}>{aggHint(form.aggregation)}</p>
        {err && <p role="alert" className="text-[13px] font-semibold text-[#8a2c2c]">{err}</p>}
      </div>
    </ResizableDrawer>
  );
};

// ── Small field helpers ────────────────────────────────────────────────────────
const Field = ({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) => (
  <label className={cn('flex min-w-0 flex-col gap-1.5', className)}>
    <span className={LABEL}>{label}</span>
    {children}
    {hint && <span className={HINT}>{hint}</span>}
  </label>
);

const RMField = ({ label, value, placeholder, hint, onCommit }: { label: string; value: string; placeholder: string; hint: string; onCommit: (v: string) => void }) => {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint}>
      <input className={INPUT} inputMode="decimal" placeholder={placeholder} value={buf ?? value}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => { if (buf !== null && buf !== value) onCommit(buf); setBuf(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </Field>
  );
};
