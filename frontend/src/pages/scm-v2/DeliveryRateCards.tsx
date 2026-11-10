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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  useRateCards, useRateCard, useRateCardMeta,
  useCreateRateCard, useUpdateRateCard, useDeleteRateCard,
  useComputeCost, useReconcile, type ReconcileRow,
  type RateCard, type RateRule, type DeliveryFacts, type RateAggregation,
} from '../../vendor/scm/lib/delivery-rate-card-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';
import { fmtDate, fmtSen } from '@2990s/shared';
import {
  RULE_LABEL, CATEGORY_LABEL, type RateRuleCategory, type RateRuleTypeT,
} from '../../vendor/scm/lib/rate-rule-taxonomy';
import { ThreePLCompanies } from './ThreePLCompanies';
import { useThreePLDoCharges, ThreePLInvoices, type ChargeRow } from './ThreePLInvoices';
import { carrierRecon, chargeTotals, type CarrierRecon } from './carriers/reconcile';
import { DateField } from '../../vendor/scm/components/DateField';
import { RateCardRules, categoryTotals, rmToSen, sectionAnchor } from './carriers/RateCardRules';
import {
  BTN_PRI, BTN_QUIET, CARD, DiffPill, EYEBROW, FilterBar, HINT, ICON_BTN, INPUT, Kpi, KpiStrip, LABEL, Pill, TableCard, diffTone,
} from './carriers/ui';

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

const centiToRM = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));

/* The carrier list on this page comes from /delivery-rate-cards/meta, a DIFFERENT
   query from the one useCreateThreePLCompany invalidates — and it holds for five
   minutes. Without this, registering a carrier in the drawer and then trying to
   price it would show a list that does not contain it. */
const COMPANY_LIST_KEY = ['delivery-rate-card-meta'];
type Tab = 'cards' | 'invoices' | 'reconcile';
const TAB_LABEL: Record<Tab, string> = { cards: 'Rate Cards', invoices: '3PL invoices', reconcile: 'Reconciliation' };

/* What the right-hand side shows: a card, or a carrier that has none yet. */
type Selection = { kind: 'card'; id: string } | { kind: 'company'; id: string } | null;

export const DeliveryRateCards = ({ embedded = false }: {
  embedded?: boolean;
} = {}) => {
  const [tab, setTab] = useState<Tab>('cards');
  const [sel, setSel] = useState<Selection>(null);
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
  const companies = meta.data?.companies ?? [];
  const emptyCompany = sel?.kind === 'company' ? companies.find((co) => co.id === sel.id) ?? null : null;
  /* On a phone the list sits above the card: bring the picked card into view. */
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel && window.innerWidth < 768) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [sel]);

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
            companies={companies}
            isLoading={cards.isLoading || meta.isLoading}
            loadFailed={cards.isError || meta.isError}
            sel={sel}
            onSelect={setSel}
            onCreateCompany={onCreateCompany}
          />
          <div ref={editorRef} className="flex min-w-0 flex-[1_1_560px] scroll-mt-4 flex-col gap-4">
            {sel?.kind === 'card'
              ? <CardEditor key={sel.id} cardId={sel.id} onDeleted={() => setSel(null)} />
              : emptyCompany
                ? <NoCardYet name={emptyCompany.name} onCreate={() => setCreating({ carrierCompanyId: emptyCompany.id })} />
                : (
                  <div className={cn(CARD, 'flex flex-col items-center gap-2 px-6 py-12 text-center')}>
                    <p className="text-[15px] font-semibold text-ink">Pick a carrier on the left</p>
                    <p className={cn(HINT, 'max-w-[420px]')}>Its rate card opens here, laid out per category so the whole card can be checked at once. A carrier without a card can get one in a click.</p>
                  </div>
                )}
          </div>
        </div>
      ) : tab === 'invoices' ? <ThreePLInvoices /> : (
        <ReconcileView />
      )}

      {creating && (
        <CreateCardDrawer
          initialCarrierCompanyId={creating.carrierCompanyId}
          onClose={() => setCreating(null)}
          onCreated={(id) => { setCreating(null); setSel({ kind: 'card', id }); }}
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

/* A carrier with no card: say so plainly, and offer the one thing to do. */
const NoCardYet = ({ name, onCreate }: { name: string; onCreate: () => void }) => (
  <section aria-label="No rate card yet" className={cn(CARD, 'flex flex-col items-center gap-3 px-6 py-12 text-center')}>
    <Pill tone="amber">No rate card yet</Pill>
    <h2 className="text-[20px] font-bold text-ink">{name}</h2>
    <p className={cn(HINT, 'max-w-[460px] text-[13px]')}>
      Nothing says what this carrier should charge, so its bills on the 3PL invoices tab cannot be checked. Create its card, then add its prices per category.
    </p>
    <button type="button" className={BTN_PRI} onClick={onCreate}><Plus {...ICON} />Create rate card</button>
  </section>
);

// ── Carrier list ────────────────────────────────────────────────
// Owner's flow (2026-08-01): register the 3PL companies first, then come here to
// see what each one charges. So the list IS the carrier list — every registered
// 3PL appears, whether or not it has a card yet, and a carrier with no card opens
// a clear create prompt. Own-fleet cost structures keep their own group below.
const SEARCH_FROM = 8;
const CardList = ({ cards, companies, isLoading, loadFailed, sel, onSelect, onCreateCompany }: {
  cards: RateCard[];
  companies: Array<{ id: string; name: string }>;
  isLoading: boolean;
  loadFailed: boolean;
  sel: Selection;
  onSelect: (s: Selection) => void;
  onCreateCompany: () => void;
}) => {
  const [q, setQ] = useState('');
  const byCompany = new Map<string, RateCard>();
  for (const c of cards) if (c.carrierCompanyId) byCompany.set(c.carrierCompanyId, c);
  const listed = new Set(companies.map((co) => co.id));
  const ownFleet = cards.filter((c) => cardKind(c, listed) === 'own');
  /* A card whose 3PL company was deleted (before deleting one with a card was
     refused) has no carrier but was never own fleet; a card whose company is
     inactive is not in the carrier list. Neither may hide or vanish. */
  const others = cards.filter((c) => cardKind(c, listed) === 'removed' || cardKind(c, listed) === 'inactive');
  const priced = companies.filter((co) => byCompany.has(co.id)).length;
  const match = (name: string) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());

  const summary = (c: RateCard) => {
    const n = c.ruleCount ?? 0;
    return `${c.basis} · per ${c.aggregation.toLowerCase()} · ${n} ${n === 1 ? 'rule' : 'rules'}${c.isActive ? '' : ' · inactive'}`;
  };
  const status = (c: RateCard | null) => (c == null
    ? <Pill tone="amber">No card</Pill>
    : c.isActive ? <Pill tone="green">Active</Pill> : <Pill tone="grey">Inactive</Pill>);
  const row = (key: string, on: boolean, name: string, sub: string, subTone: string, badge: ReactNode, onClick: () => void) => (
    <button key={key} type="button" onClick={onClick} aria-current={on ? 'true' : undefined}
      className={cn('flex w-full items-center gap-3 border-l-[3px] px-[15px] py-[10px] text-left',
        on ? 'border-primary bg-[#eef6f3]' : 'border-transparent hover:bg-surface-2')}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14px] font-bold text-ink">{name}</span>
        <span className={cn('text-[12.5px]', subTone)}>{sub}</span>
      </span>
      {badge}
    </button>
  );
  const group = (label: string) => <div className={cn(EYEBROW, 'px-[18px] pb-1.5 pt-3.5')}>{label}</div>;
  const shownCompanies = companies.filter((co) => match(co.name));

  return (
    <aside aria-label="Carriers" className={cn(CARD, 'w-full overflow-hidden md:w-auto md:min-w-[260px] md:flex-[0_1_320px] lg:sticky lg:top-4')}>
      <div className="border-b border-border px-[18px] pb-3 pt-4">
        <div className="text-[15px] font-bold text-ink">Carriers</div>
        <div className={cn(HINT, 'mt-0.5')}>
          {companies.length} {companies.length === 1 ? 'carrier' : 'carriers'} · {priced} with a card
          {companies.length > priced ? ` · ${companies.length - priced} without` : ''}
        </div>
        {companies.length >= SEARCH_FROM && (
          <input className={cn(INPUT, 'mt-2.5 min-h-[36px] text-[13px]')} placeholder="Find a carrier" aria-label="Find a carrier"
            value={q} onChange={(e) => setQ(e.target.value)} />
        )}
      </div>
      <div className="py-1.5 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto">
        {isLoading && <p className="px-[18px] py-3 text-[13px] text-ink-muted">Loading…</p>}
        {loadFailed && <p className="px-[18px] py-3 text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The carriers did not load.</p>}
        {!isLoading && !loadFailed && companies.length === 0 && (
          <p className="px-[18px] py-3 text-[13px] leading-normal text-ink-secondary">
            No 3PL companies registered yet. A rate card is priced per carrier, so there is nothing to price until one exists.{' '}
            <button type="button" onClick={onCreateCompany} className="font-semibold text-primary hover:underline">Register one now</button>
          </p>
        )}
        {companies.length > 0 && group('3PL')}
        {shownCompanies.map((co) => {
          const card = byCompany.get(co.id) ?? null;
          const on = card ? sel?.kind === 'card' && sel.id === card.id : sel?.kind === 'company' && sel.id === co.id;
          return row(co.id, on, co.name,
            card ? summary(card) : 'No rate card yet',
            card ? 'text-ink-muted' : 'font-semibold text-primary',
            status(card),
            () => onSelect(card ? { kind: 'card', id: card.id } : { kind: 'company', id: co.id }));
        })}
        {companies.length > 0 && shownCompanies.length === 0 && <p className="px-[18px] py-3 text-[13px] text-ink-muted">No carrier matches &ldquo;{q.trim()}&rdquo;.</p>}
        {ownFleet.length > 0 && (
          <>
            {group('Own fleet')}
            {ownFleet.map((c) => row(c.id, sel?.kind === 'card' && sel.id === c.id, c.name, summary(c), 'text-ink-muted', status(c), () => onSelect({ kind: 'card', id: c.id })))}
          </>
        )}
        {others.length > 0 && (
          <>
            {group('Needs a carrier')}
            {others.map((c) => row(c.id, sel?.kind === 'card' && sel.id === c.id, c.name,
              `${cardKind(c, listed) === 'removed' ? 'Carrier removed' : 'Carrier inactive'} · ${summary(c)}`,
              'font-semibold text-[#80501c]', <Pill tone="amber">Fix</Pill>, () => onSelect({ kind: 'card', id: c.id })))}
          </>
        )}
      </div>
    </aside>
  );
};

/* own: our own cost structure. carrier: an active 3PL's card. removed: its 3PL
   company was deleted (carrier nulled, never own fleet). inactive: its 3PL
   company is set inactive, so the carrier list omits it. */
type CardKind = 'own' | 'carrier' | 'removed' | 'inactive';
const cardKind = (c: RateCard, listed: ReadonlySet<string>): CardKind =>
  c.carrierCompanyId ? (listed.has(c.carrierCompanyId) ? 'carrier' : 'inactive') : c.isOwnFleet ? 'own' : 'removed';

// ── Card editor (header + rules + calculator) ────────────────────────────────
const AGG_SHORT: Partial<Record<string, string>> = { UNIT: 'unit', DROP: 'drop point', CUSTOMER: 'customer', TRIP: 'trip' };
const NO_RULES: RateRule[] = [];
const CardEditor = ({ cardId, onDeleted }: { cardId: string; onDeleted: () => void }) => {
  const detail = useRateCard(cardId);
  const meta = useRateCardMeta();
  const update = useUpdateRateCard();
  const del = useDeleteRateCard();
  const askConfirm = useConfirm();

  const allCards = useRateCards();
  const card = detail.data?.card;
  const rules = detail.data?.rules ?? NO_RULES;
  const companies = meta.data?.companies ?? [];
  const unit = card?.basis === 'ITEM' ? 'item' : 'set';
  const totals = useMemo(() => categoryTotals(rules, unit), [rules, unit]);

  if (detail.isError) return <div className={cn(CARD, 'p-6 text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]')}>This card did not load.</div>;
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
    if (!(await askConfirm({ title: `Delete card "${card.name}"?`, body: `Its ${rules.length} ${rules.length === 1 ? 'rule is' : 'rules are'} removed too. This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    del.mutate(cardId, { onSuccess: onDeleted, onError: writeFailedAs('The card was not deleted') });
  };
  const jump = (cat: RateRuleCategory) => document.getElementById(sectionAnchor(cat))?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <>
      {/* The card's header, sticky: which card this is and what it carries
          stay in view while its prices scroll past. */}
      <div className={cn(CARD, 'z-10 flex flex-col gap-2.5 px-5 py-3.5 shadow-sm md:sticky md:top-0')}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className={EYEBROW}>{kind === 'own' ? 'Own fleet rate card' : 'Rate card'}</span>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 break-words text-[19px] font-bold leading-tight text-ink">{title}</h2>
              {card.isActive ? <Pill tone="green">Active</Pill> : <Pill tone="grey">Inactive</Pill>}
            </div>
          </div>
          <button type="button" className={ICON_BTN} onClick={() => void removeCard()} disabled={del.isPending} aria-label="Delete card"><Trash2 {...ICON} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[12.5px] text-ink-muted">
            {card.basis} · per {AGG_SHORT[card.aggregation] ?? card.aggregation.toLowerCase()} · {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
            {' · '}Min {card.minChargeSen == null ? 'none' : fmtSen(card.minChargeSen)} · Cap {card.capSen == null ? 'none' : fmtSen(card.capSen)}
          </span>
          <nav aria-label="Jump to a category" className="flex flex-wrap gap-1.5 md:ml-auto">
            {totals.map((t) => (
              <button key={t.category} type="button" onClick={() => jump(t.category)}
                className={cn('min-h-[32px] rounded-full border px-2.5 text-[12px] font-semibold',
                  t.count ? 'border-border bg-surface text-ink hover:border-primary hover:text-primary' : 'border-dashed border-border text-ink-muted')}>
                {CATEGORY_LABEL[t.category]} <span className="tabular-nums text-ink-muted">{t.count}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>

      <section aria-label="Card settings" className={cn(CARD, 'flex flex-col gap-3.5 px-5 py-[18px]')}>
        <h3 className="text-[16px] font-bold text-ink">Card settings</h3>
        {(kind === 'removed' || kind === 'inactive') && (
          <div className="flex flex-wrap items-end gap-3 rounded-xl bg-[#f6ecd4] px-4 py-3 text-[13px] text-accent-ink">
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
        <div className="grid gap-x-3 gap-y-3.5 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))] sm:[grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
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
            <span className="flex min-h-[40px] items-center text-[14px] font-semibold text-ink">
              {kind === 'own' ? 'Own fleet' : kind === 'removed' ? 'Carrier removed' : 'This 3PL company'}
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
          <label className="flex cursor-pointer items-center gap-2.5 self-start pt-[26px] text-[14px] font-semibold text-ink">
            <input type="checkbox" className="h-[18px] w-[18px] accent-[#16695f]" checked={card.isActive} disabled={update.isPending}
              onChange={(e) => patch({ isActive: e.target.checked })} />
            Active
          </label>
        </div>
      </section>

      <RateCardRules cardId={cardId} rules={rules} zones={meta.data?.zones ?? []} unit={unit} />
      <CalculatorPanel cardId={cardId} basis={card.basis} zones={meta.data?.zones ?? []} rules={rules} />
    </>
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
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtSen(Math.abs(v))}`;
const RECON_COLUMNS: Column<ReconcileRow>[] = [
  { key: 'trip', label: 'Trip', render: (r) => <span className="font-semibold">{r.tripNo ?? r.tripId.slice(0, 8)}</span>, getValue: (r) => r.tripNo ?? r.tripId },
  { key: 'date', label: 'Date', render: (r) => (r.tripDate ? fmtDate(r.tripDate) : '—'), getValue: (r) => r.tripDate, exportFormat: 'date' },
  { key: 'card', label: 'Card', render: (r) => (r.matched ? r.cardName : <span className="text-ink-muted">no card</span>), getValue: (r) => (r.matched ? r.cardName ?? '' : '') },
  { key: 'drops', label: 'Drops', align: 'right', render: (r) => r.dropCount, getValue: (r) => r.dropCount },
  { key: 'zone', label: 'Zone', render: (r) => r.derivedZone ?? '—', getValue: (r) => r.derivedZone ?? '' },
  {
    key: 'expected', label: 'Expected', align: 'right', render: (r) => <span className="tabular-nums">{fmtSen(r.expectedSen)}</span>,
    getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100), exportFormat: 'money',
  },
  {
    key: 'billed', label: 'Billed', align: 'right', render: (r) => <span className="tabular-nums">{fmtSen(r.billedSen)}</span>,
    getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100, exportFormat: 'money',
  },
  {
    key: 'delta', label: 'Delta', align: 'right',
    render: (r) => (r.deltaSen == null ? <span className="text-ink-muted">—</span>
      : r.flagged ? <Pill tone={diffTone(r.deltaSen)} className="tabular-nums">{signed(r.deltaSen)}</Pill>
      : <span className="tabular-nums text-ink-muted">{signed(r.deltaSen)}</span>),
    getValue: (r) => r.deltaSen, exportValue: (r) => (r.deltaSen == null ? null : r.deltaSen / 100), exportFormat: 'money',
  },
  {
    key: 'status', label: 'Status',
    render: (r) => (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {!r.matched ? <Pill tone="grey">unmatched</Pill> : r.flagged ? <Pill tone="red">mismatch</Pill> : <Pill tone="green">match</Pill>}
        {r.matched && !r.factsComplete && <span className="text-[11px] text-ink-muted">facts partial</span>}
      </span>
    ),
    getValue: reconStatus,
  },
];
const CARRIER_COLUMNS: Column<CarrierRecon>[] = [
  { key: 'carrier', label: '3PL', render: (r) => <span className="font-semibold">{r.carrierName}</span>, getValue: (r) => r.carrierName },
  { key: 'dos', label: 'DOs', align: 'right', render: (r) => r.dos, getValue: (r) => r.dos },
  { key: 'billed', label: 'Billed', align: 'right', render: (r) => <span className="tabular-nums">{fmtSen(r.billedSen)}</span>, getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100, exportFormat: 'money' },
  { key: 'expected', label: 'Rate card', align: 'right', render: (r) => (r.priced ? <span className="tabular-nums">{fmtSen(r.expectedSen)}</span> : '—'), getValue: (r) => r.expectedSen, exportValue: (r) => r.expectedSen / 100, exportFormat: 'money' },
  {
    key: 'diff', label: 'Difference', align: 'right',
    /* Over the DOs the card prices only: a DO with no card has no expected cost to differ from. */
    render: (r) => <DiffPill v={r.priced ? r.billedPricedSen - r.expectedSen : null} />,
    getValue: (r) => (r.priced ? r.billedPricedSen - r.expectedSen : null),
    exportValue: (r) => (r.priced ? (r.billedPricedSen - r.expectedSen) / 100 : null), exportFormat: 'money',
  },
  { key: 'off', label: 'DOs off the card', align: 'right', render: (r) => (r.off ? <Pill tone="red">{r.off}</Pill> : <span className="text-ink-muted">0</span>), getValue: (r) => r.off },
  { key: 'nocard', label: 'No rate card', align: 'right', render: (r) => (r.noCard ? <Pill tone="amber">{r.noCard}</Pill> : <span className="text-ink-muted">0</span>), getValue: (r) => r.noCard },
];
const DO_COLUMNS: Column<ChargeRow>[] = [
  { key: 'do', label: 'DO', render: (r) => <span className="font-semibold">{r.doNumber ?? '—'}</span>, getValue: (r) => r.doNumber ?? '' },
  { key: 'carrier', label: '3PL', render: (r) => r.carrierName ?? '—', getValue: (r) => r.carrierName ?? '' },
  { key: 'inv', label: 'Invoice', render: (r) => [r.invoiceNo, r.invoiceDate && fmtDate(r.invoiceDate)].filter(Boolean).join(' · ') || '—', getValue: (r) => r.invoiceNo ?? '' },
  { key: 'billed', label: 'Billed', align: 'right', render: (r) => <span className="tabular-nums">{fmtSen(r.billedSen)}</span>, getValue: (r) => r.billedSen, exportValue: (r) => r.billedSen / 100, exportFormat: 'money' },
  { key: 'expected', label: 'Rate card', align: 'right', render: (r) => (r.expectedSen == null ? '—' : <span className="tabular-nums">{fmtSen(r.expectedSen)}</span>), getValue: (r) => r.expectedSen, exportValue: (r) => (r.expectedSen == null ? null : r.expectedSen / 100), exportFormat: 'money' },
  { key: 'diff', label: 'Difference', align: 'right', render: (r) => <DiffPill v={r.varianceSen} />, getValue: (r) => r.varianceSen, exportValue: (r) => (r.varianceSen == null ? null : r.varianceSen / 100), exportFormat: 'money' },
];

const ReconcileView = () => {
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const recon = useReconcile(range);
  const charges = useThreePLDoCharges(range);
  const rows = recon.data ?? [];
  const chargeRows = useMemo(() => charges.data?.rows ?? [], [charges.data?.rows]);
  const perCarrier = useMemo(() => carrierRecon(chargeRows), [chargeRows]);
  const offCard = useMemo(() => chargeRows.filter((r) => r.varianceSen == null || r.varianceSen !== 0), [chargeRows]);
  const t = useMemo(() => chargeTotals(chargeRows), [chargeRows]);
  const flaggedTrips = rows.filter((r) => r.flagged).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-[900px] text-[13px] text-ink-muted">
        What each 3PL billed, from its bills on the 3PL invoices tab, against what its rate card says. The rate card amount is worked out from each DO&rsquo;s sets / items and delivery zone; extras (setup, dismantle, disposal) and the per-trip outstation fee are not on the DO, so they show as a difference to check.
      </p>
      <FilterBar>
        {(['from', 'to'] as const).map((k) => (
          <Field key={k} label={k === 'from' ? 'From' : 'To'} className="min-w-[140px] flex-1 sm:w-[170px] sm:flex-none">
            <DateField className={INPUT} value={range[k]} onChange={(v) => setRange((s) => ({ ...s, [k]: v }))} fullWidth />
          </Field>
        ))}
        <span className={cn(HINT, 'pb-2.5')}>Invoice date for bills, trip date for trips.</span>
        {(range.from || range.to) && (
          <button type="button" className="min-h-[40px] text-[13px] font-semibold text-primary" onClick={() => setRange({ from: '', to: '' })}>Clear dates</button>
        )}
      </FilterBar>

      {charges.data && (
        <KpiStrip>
          <Kpi label="Billed" value={fmtSen(t.billedSen)} sub={`${t.dos} ${t.dos === 1 ? 'DO' : 'DOs'} · ${perCarrier.length} ${perCarrier.length === 1 ? '3PL' : '3PLs'}`} tone={null} />
          <Kpi label="Rate card" value={t.priced ? fmtSen(t.expectedSen) : '—'} sub={`${t.priced} of ${t.dos} DOs priced`} tone={null} />
          <Kpi label="Difference" value={t.diffSen == null ? '—' : signed(t.diffSen)} sub="Billed less rate card, priced DOs" tone={t.diffSen == null ? null : diffTone(t.diffSen)} />
          <Kpi label="Off the card" value={offCard.length} sub={`${t.over} over · ${t.under} under · ${t.noCard} no card`} tone={offCard.length ? 'red' : 'green'} />
        </KpiStrip>
      )}

      <TableCard title="Per 3PL" count={null} label={null} actions={null}
        hint="Each 3PL's bills in range beside its rate card. The difference counts only the DOs its card prices.">
        <DataTable<CarrierRecon>
          tableId="rate-card-reconcile-carriers" exportName="3pl-reconciliation" exportXlsx
          columns={CARRIER_COLUMNS} rows={charges.data ? perCarrier : null} loading={charges.isLoading}
          error={charges.isError ? 'The 3PL bills did not load.' : null}
          emptyLabel="No 3PL bills in range. Key one in, or bring one in from an AP invoice, on the 3PL invoices tab."
          getRowKey={(r) => r.carrierId}
        />
      </TableCard>

      <TableCard title="DOs that differ from the rate card" count={`(${offCard.length})`} label={null} actions={null}
        hint="Red: billed over the card. Amber: billed under it. Grey: the 3PL has no card to check against.">
        <DataTable<ChargeRow>
          tableId="rate-card-reconcile-dos" exportName="3pl-dos-off-card" exportXlsx
          columns={DO_COLUMNS} rows={charges.data ? offCard : null} loading={charges.isLoading}
          error={charges.isError ? 'The 3PL bills did not load.' : null}
          emptyLabel="Every billed DO in range matches its rate card."
          getRowKey={(r) => r.id}
          getRowStyle={(r) => ((r.varianceSen ?? 0) > 0 ? { background: 'rgba(163,38,27,0.05)' } : undefined)}
        />
      </TableCard>

      <TableCard title="Trips with a 3PL cost" count={recon.data ? `(${rows.length}${flaggedTrips ? `, ${flaggedTrips} mismatch` : ''})` : null} label={null} actions={null}
        hint={<>Outsourced trips planned in Delivery Planning that carry the 3PL&rsquo;s cost, priced from the trip&rsquo;s set count and zone (occurrence charges and sofa compartments are not on the trip: facts partial).</>}>
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
      </TableCard>
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
        {err && <p role="alert" className="text-[13px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]">{err}</p>}
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
