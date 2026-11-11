// ----------------------------------------------------------------------------
// Carriers & Rates — Fleet Module C (mig 0207 / route delivery-rate-cards.ts).
//
// Build a delivery rate card per carrier (own-fleet + each 3PL), then verify a
// 3PL's billed charge against the COMPUTED expected cost and roll the precise
// delivery cost toward COGS. Three tabs:
//   - Rate Cards: the carrier list and the card (owner 2026-11-11: 「看了很乱」):
//     its settings as one line under its name (the boxes open from Edit
//     settings), then one tab per category — prices as tiles, outstation towns
//     grouped by price — and a fifth tab, PRICE CHECK, that prices one delivery
//     against the card as you type.
//   - 3PL invoices: what a transporter billed per DO, beside the rate card.
//   - Reconciliation: 3PL trips carrying a captured billed cost, each matched to
//     its carrier's card, with computed-expected vs billed and the flagged delta.
//     COST verification + COGS attribution, NOT customer billing.
// Styled after the Coverage & Fleet screens (owner design 2026-11-07).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import {
  useRateCards, useRateCard, useRateCardMeta,
  useCreateRateCard, useUpdateRateCard, useDeleteRateCard,
  useReconcile, type ReconcileRow,
  type RateArea, type RateCard, type RateCardMeta, type RateRule, type RateAggregation,
} from '../../vendor/scm/lib/delivery-rate-card-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { ResizableDrawer } from '../../components/ResizableDrawer';
import { DataTable, type Column } from '../../components/DataTable';
import { cn } from '../../lib/utils';
import { fmtDate, fmtSen } from '@2990s/shared';
import { ThreePLCompanies } from './ThreePLCompanies';
import { useThreePLDoCharges, ThreePLInvoices, type ChargeRow } from './ThreePLInvoices';
import { carrierRecon, chargeTotals, type CarrierRecon } from './carriers/reconcile';
import { DateField } from '../../vendor/scm/components/DateField';
import { RateCardSection, SectionTabs, type RateSection } from './carriers/RateCardRules';
import { CardSettingsDrawer } from './carriers/CardSettingsDrawer';
import { aggHint, cardKind, chargingUnit, settingsSentence } from './carriers/cardSettings';
import { layoutRateCard } from './carriers/rateCardLayout';
import { EMPTY_FORM, type PriceCheckForm } from './carriers/priceCheckFacts';
import {
  BTN_PRI, BTN_QUIET, CARD, DiffPill, EYEBROW, Field, FilterBar, HINT, ICON_BTN, INPUT, Kpi, KpiStrip, LABEL, Pill, TableCard, diffTone,
} from './carriers/ui';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

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
  /* The card's open tab is kept while carriers are switched, so two carriers'
     outstation prices or price checks can be compared; a new visit starts on Delivery. */
  const [section, setSection] = useState<RateSection>('DELIVERY');
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
              tab === t ? 'border-primary font-semibold text-primary' : 'border-transparent font-medium text-ink-muted hover:text-ink')}>
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
              ? <CardEditor key={sel.id} cardId={sel.id} section={section} onSection={setSection} onDeleted={() => setSel(null)} />
              : emptyCompany
                ? <NoCardYet name={emptyCompany.name} onCreate={() => setCreating({ carrierCompanyId: emptyCompany.id })} />
                : (
                  <div className={cn(CARD, 'flex flex-col items-center gap-2 px-6 py-12 text-center')}>
                    <p className="text-[15px] font-semibold text-ink">Pick a carrier on the left</p>
                    <p className={cn(HINT, 'max-w-[420px]')}>Its rate card opens here, one tab per category, with a Price check to work out what a delivery should cost. A carrier without a card can get one in a click.</p>
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
    <h2 className="text-[18px] font-semibold text-ink">{name}</h2>
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
  companies: RateCardMeta['companies'];
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
  const match = (name: string) => !q.trim() || name.toLowerCase().includes(q.trim().toLowerCase());
  /* Owner 2026-11-11 「这个sidebar 也要整理」: carriers with a card first, the rest
     below; full names (two BRIGHTSUNs read alike once cut short); a pill only
     when something is off. Then 「那个 price remove 吧」 and 「3pl supplier 其实是要
     link with 我的 other supplier」: under each carrier, the supplier it bills
     as, not a count of prices. */
  const priced = companies.filter((co) => byCompany.has(co.id));
  const unpriced = companies.filter((co) => !byCompany.has(co.id));
  const shownPriced = priced.filter((co) => match(co.name));
  const shownUnpriced = unpriced.filter((co) => match(co.name));

  const supplierLine = (co: RateCardMeta['companies'][number]) => (co.supplier
    ? [co.supplier.code, co.supplier.name].filter(Boolean).join(' · ')
    : 'No supplier linked');
  const supplierTone = (co: RateCardMeta['companies'][number]) => (co.supplier ? 'text-ink-muted' : 'text-[#80501c] dark:text-[color:var(--hz-dk-warning-text)]');
  const inactive = (c: RateCard) => (c.isActive ? null : <Pill tone="grey">Inactive</Pill>);
  const row = (key: string, on: boolean, name: string, sub: string | null, subTone: string, badge: ReactNode, onClick: () => void) => (
    <button key={key} type="button" onClick={onClick} aria-current={on ? 'true' : undefined}
      className={cn('flex w-full items-start gap-3 border-l-[3px] px-[15px] py-[9px] text-left',
        on ? 'border-primary bg-[color:var(--hz-dk-surface-2,#eef6f3)]' : 'border-transparent hover:bg-surface-2')}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words text-[13px] font-semibold leading-snug text-ink">{name}</span>
        {sub != null && <span className={cn('truncate text-[12px]', subTone)} title={sub}>{sub}</span>}
      </span>
      {badge}
    </button>
  );
  /* A shaded band per group, as a finance table shades its head. */
  const group = (label: string) => (
    <div className="border-y border-border bg-surface-dim px-[18px] py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-secondary first:border-t-0">{label}</div>
  );

  return (
    <aside aria-label="Carriers" className={cn(CARD, 'w-full overflow-hidden md:w-auto md:min-w-[260px] md:flex-[0_1_320px] lg:sticky lg:top-4')}>
      <div className="border-b border-border bg-surface-dim/60 px-[18px] pb-3 pt-4">
        <div className="text-[15px] font-semibold text-ink">Carriers</div>
        <div className={cn(HINT, 'mt-0.5')}>
          {companies.length} {companies.length === 1 ? 'carrier' : 'carriers'} · {priced.length} with a card
        </div>
        {companies.length >= SEARCH_FROM && (
          <input className={cn(INPUT, 'mt-2.5 min-h-[36px] text-[13px]')} placeholder="Find a carrier" aria-label="Find a carrier"
            value={q} onChange={(e) => setQ(e.target.value)} />
        )}
      </div>
      <div className="pb-1.5 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto">
        {isLoading && <p className="px-[18px] py-3 text-[13px] text-ink-muted">Loading…</p>}
        {loadFailed && <p className="px-[18px] py-3 text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]">The carriers did not load.</p>}
        {!isLoading && !loadFailed && companies.length === 0 && (
          <p className="px-[18px] py-3 text-[13px] leading-normal text-ink-secondary">
            No 3PL companies registered yet. A rate card is priced per carrier, so there is nothing to price until one exists.{' '}
            <button type="button" onClick={onCreateCompany} className="font-semibold text-primary hover:underline">Register one now</button>
          </p>
        )}
        {shownPriced.length > 0 && group('With a rate card')}
        {shownPriced.map((co) => {
          const card = byCompany.get(co.id);
          if (!card) return null;
          return row(co.id, sel?.kind === 'card' && sel.id === card.id, co.name, supplierLine(co), supplierTone(co), inactive(card),
            () => onSelect({ kind: 'card', id: card.id }));
        })}
        {shownUnpriced.length > 0 && group('No rate card yet')}
        {shownUnpriced.map((co) => row(co.id, sel?.kind === 'company' && sel.id === co.id, co.name, supplierLine(co), supplierTone(co), null,
          () => onSelect({ kind: 'company', id: co.id })))}
        {companies.length > 0 && shownPriced.length + shownUnpriced.length === 0 && <p className="px-[18px] py-3 text-[13px] text-ink-muted">No carrier matches &ldquo;{q.trim()}&rdquo;.</p>}
        {ownFleet.length > 0 && (
          <>
            {group('Own fleet')}
            {ownFleet.map((c) => row(c.id, sel?.kind === 'card' && sel.id === c.id, c.name, null, '', inactive(c), () => onSelect({ kind: 'card', id: c.id })))}
          </>
        )}
        {others.length > 0 && (
          <>
            {group('Needs a carrier')}
            {others.map((c) => row(c.id, sel?.kind === 'card' && sel.id === c.id, c.name,
              cardKind(c, listed) === 'removed' ? 'Carrier removed' : 'Carrier inactive',
              'font-semibold text-[#80501c] dark:text-[color:var(--hz-dk-warning-text)]', <Pill tone="amber">Fix</Pill>, () => onSelect({ kind: 'card', id: c.id })))}
          </>
        )}
      </div>
    </aside>
  );
};

// ── Card editor: header (settings in one line + the tabs), then the open tab ──
const NO_RULES: RateRule[] = [];
const NO_AREAS: RateArea[] = [];
const CardEditor = ({ cardId, section, onSection, onDeleted }: {
  cardId: string; section: RateSection; onSection: (s: RateSection) => void; onDeleted: () => void;
}) => {
  const detail = useRateCard(cardId);
  const meta = useRateCardMeta();
  const update = useUpdateRateCard();
  const del = useDeleteRateCard();
  const askConfirm = useConfirm();
  const [editing, setEditing] = useState(false);
  /* Price check's boxes outlive a trip to another tab and back. */
  const [checkForm, setCheckForm] = useState<PriceCheckForm>(EMPTY_FORM);

  const allCards = useRateCards();
  const card = detail.data?.card;
  const allRules = detail.data?.rules ?? NO_RULES;
  /* The tabs show the card's own prices; a price that belongs to one area of
     the card (areaId set) is the area's, and must not read as a second tier. */
  const rules = useMemo(() => allRules.filter((r) => r.areaId == null), [allRules]);
  /* The areas' own prices, shown with their area in the Outstation tab. */
  const areaRules = useMemo(() => allRules.filter((r) => r.areaId != null), [allRules]);
  const areas = detail.data?.areas ?? NO_AREAS;
  const companies = meta.data?.companies ?? [];
  const unit = card ? chargingUnit(card) : 'set';
  const sections = useMemo(() => layoutRateCard(rules, unit), [rules, unit]);

  if (detail.isError) return <div className={cn(CARD, 'p-6 text-[13px] text-[color:var(--hz-dk-err,#8a2c2c)]')}>This card did not load.</div>;
  if (detail.isLoading || !card) return <div className={cn(CARD, 'p-6 text-[13px] text-ink-muted')}>Loading card…</div>;

  const kind = cardKind(card, new Set(companies.map((co) => co.id)));
  /* The card name was copied from the company once; show the company's
     current name so a renamed carrier does not keep its old one here. */
  const title = (card.carrierCompanyId ? companies.find((co) => co.id === card.carrierCompanyId)?.name : null) ?? card.name;
  const taken = new Set((allCards.data ?? []).map((c) => c.carrierCompanyId));
  const freeCarriers = companies.filter((co) => !taken.has(co.id));

  const removeCard = async () => {
    if (!(await askConfirm({ title: `Delete card "${card.name}"?`, body: `Its ${allRules.length} ${allRules.length === 1 ? 'rule is' : 'rules are'} removed too. This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    del.mutate(cardId, { onSuccess: onDeleted, onError: writeFailedAs('The card was not deleted') });
  };

  return (
    <>
      {/* The card's header, sticky: which card this is, what it charges by and
          its tabs stay in view while a long tab scrolls past. */}
      <div className={cn(CARD, 'z-10 flex flex-col overflow-hidden shadow-sm md:sticky md:top-0')}>
        {/* The title band, shaded (owner 2026-11-11: 「加一下 background colour，特别是 title」). */}
        <div className="flex flex-col gap-3 bg-surface-dim/60 px-5 pb-3.5 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
            <span className={EYEBROW}>{kind === 'own' ? 'Own fleet rate card' : 'Rate card'}</span>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 break-words text-[18px] font-semibold leading-tight text-ink">{title}</h2>
              {card.isActive ? <Pill tone="green">Active</Pill> : <Pill tone="grey">Inactive</Pill>}
            </div>
            <p className="text-[13px] text-ink-muted">{settingsSentence(card)}</p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <button type="button" className={cn(BTN_QUIET, 'min-h-[36px] px-3 text-[13px]')} onClick={() => setEditing(true)}>
              <Settings2 {...ICON} />Edit settings
            </button>
            <button type="button" className={ICON_BTN} onClick={() => void removeCard()} disabled={del.isPending} aria-label="Delete card"><Trash2 {...ICON} /></button>
          </div>
        </div>
        {(kind === 'removed' || kind === 'inactive') && (
          <div className="flex flex-wrap items-end gap-3 rounded-xl bg-[color:var(--hz-dk-warning-bg,#f6ecd4)] px-4 py-3 text-[13px] text-accent-ink">
            <p className="min-w-[220px] flex-[1_1_260px]">
              {kind === 'removed'
                ? 'This card’s 3PL company was deleted, so the card belongs to no carrier. Move it to a carrier, or delete it.'
                : 'This card’s 3PL company is set inactive, so it is not in the carrier list. Set the company active again, move the card to another carrier, or delete it.'}
            </p>
            {freeCarriers.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-semibold">Move to carrier</span>
                <select className={cn(INPUT, 'min-w-[200px]')} value="" disabled={update.isPending}
                  onChange={(e) => {
                    if (e.target.value) update.mutate({ id: cardId, carrierCompanyId: e.target.value }, { onError: writeFailedAs('The card was not updated') });
                  }}>
                  <option value="">Choose a carrier…</option>
                  {freeCarriers.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
        </div>
        <div className="px-5"><SectionTabs sections={sections} areaCount={areas.length} value={section} onChange={onSection} /></div>
      </div>

      <RateCardSection card={card} rules={rules} areas={areas} areaRules={areaRules} unit={unit} sections={sections} zones={meta.data?.zones ?? []} section={section}
        checkForm={checkForm} onCheckForm={setCheckForm} />

      {editing && <CardSettingsDrawer card={card} kind={kind} title={title} onClose={() => setEditing(false)} />}
    </>
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
        {r.matched && !r.factsComplete && <span className="text-[11.5px] text-ink-muted">facts partial</span>}
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
