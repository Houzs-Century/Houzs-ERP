// ----------------------------------------------------------------------------
// Delivery Rate Cards — Fleet Module C (mig 0207 / route delivery-rate-cards.ts).
//
// Build a delivery rate card per carrier (own-fleet + each 3PL), then verify a
// 3PL's billed charge against the COMPUTED expected cost and roll the precise
// delivery cost toward COGS. Two tabs:
//   - Cards: pick / create a card, edit its dimensions (charging basis, aggregation,
//     min / cap / rounding) and its priced rules (positional tiers, cap+overage,
//     sofa compartment brackets, outstation zone surcharges, dispose / setup /
//     dismantle, service / pickup / inspection / transfer). A live COST CALCULATOR
//     prices a set of facts against the card and shows the itemised breakdown
//     (the owner's worked example lands on RM560).
//   - Reconciliation: 3PL trips carrying a captured billed cost, each matched to
//     its carrier's card, with computed-expected vs billed and the flagged delta.
//     COST verification + COGS attribution, NOT customer billing.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, X, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useRateCards, useRateCard, useRateCardMeta,
  useCreateRateCard, useUpdateRateCard, useDeleteRateCard,
  useCreateRateRule, useDeleteRateRule, useComputeCost, useReconcile,
  type RateCard, type RateRule, type RateRuleType, type DeliveryFacts, type RateAggregation,
} from '../../vendor/scm/lib/delivery-rate-card-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import {
  RULE_LABEL, RULE_CATEGORY, CATEGORY_LABEL, CATEGORY_HINT,
  RATE_RULE_CATEGORIES, rulesByCategory, type RateRuleCategory, type RateRuleTypeT,
} from '../../vendor/scm/lib/rate-rule-taxonomy';
import { ThreePLCompanies } from './ThreePLCompanies';

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

const centiToRM = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
const rmToCenti = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/* Labels, categories and their order now come from the SHARED taxonomy, which
   `npm run audit:job-types` keeps in step with the backend, the rule_type CHECK
   and scm.trip_stop_type. The local copy that used to live here had no
   SUPPLIER_PICKUP and no notion of grouping. */

/* The 3PL entry point, owner 2026-08-01: "用户在 Rate Card 页面进行点选时，数据需要从
   3PL Company 那边读取，因此 Rate Card 的右上角需要新增一个可以 Create 3PL Company
   的功能", and 2026-08-02 on where it belongs: "3PL 的入口在rates 的右上角 点开".
   A rate card is priced PER CARRIER, so the carrier list here IS the 3PL master —
   an empty list used to be answerable only by leaving the page. It opens as a
   DRAWER over this page rather than as a second collapsible below it, because
   the owner rejected folds on this screen ("carriers 根本都不需要dropdown").

   The drawer renders the SAME ThreePLCompanies component its own route renders,
   so there is no second copy of the create form to drift. */
/* The carrier list on this page comes from /delivery-rate-cards/meta, a DIFFERENT
   query from the one useCreateThreePLCompany invalidates — and it holds for five
   minutes. Without this, registering a carrier in the drawer and then trying to
   price it would show a list that does not contain it. */
const COMPANY_LIST_KEY = ['delivery-rate-card-meta'];
export const DeliveryRateCards = ({ embedded = false }: {
  embedded?: boolean;
} = {}) => {
  const [tab, setTab] = useState<'cards' | 'reconcile'>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ carrierCompanyId: string | null } | null>(null);
  const [companiesOpen, setCompaniesOpen] = useState(false);
  const cards = useRateCards();
  const meta = useRateCardMeta();
  const qc = useQueryClient();

  const onCreateCompany = () => setCompaniesOpen(true);
  const closeCompanies = () => {
    setCompaniesOpen(false);
    qc.invalidateQueries({ queryKey: COMPANY_LIST_KEY });
  };

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Delivery Rate Cards"
          description="Configure a rate card per carrier (own-fleet + each 3PL), verify a 3PL's billed charge against the computed expected cost, and roll the precise delivery cost toward COGS. Cost verification, not customer billing — and it does not touch the FIFO costing path."
          actions={tab === 'cards' ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="md" onClick={onCreateCompany}>
                <Plus {...ICON} /><span>New 3PL Company</span>
              </Button>
              <Button variant="primary" size="md" onClick={() => setCreating({ carrierCompanyId: null })}>
                <Plus {...ICON} /><span>New Card</span>
              </Button>
            </div>
          ) : undefined}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
        {(['cards', 'reconcile'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            style={{
              background: 'none', border: 'none', padding: '8px 14px', cursor: 'pointer',
              fontSize: 'var(--fs-13)', fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--fg, #111)' : 'var(--fg-muted)',
              borderBottom: tab === t ? '2px solid var(--c-primary-a, #2563eb)' : '2px solid transparent',
            }}>
            {t === 'cards' ? 'Rate Cards' : 'Reconciliation'}
          </button>
        ))}
        {/* Embedded there is no PageHeader, so the tab strip carries the actions
            — this row IS the top-right of the screen in that layout. */}
        {embedded && tab === 'cards' && (
          <div className="ml-auto flex items-center gap-2 pb-1.5">
            <Button variant="secondary" size="sm" onClick={onCreateCompany}>
              <Plus {...ICON} /><span>New 3PL Company</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreating({ carrierCompanyId: null })}>
              <Plus {...ICON} /><span>New Card</span>
            </Button>
          </div>
        )}
      </div>

      {tab === 'cards' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
          <CardList
            cards={cards.data ?? []}
            companies={meta.data?.companies ?? []}
            isLoading={cards.isLoading || meta.isLoading}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreateFor={(carrierCompanyId) => setCreating({ carrierCompanyId })}
            onCreateCompany={onCreateCompany}
          />
          {selectedId
            ? <CardEditor key={selectedId} cardId={selectedId} onDeleted={() => setSelectedId(null)} />
            : <div style={{ padding: 24, color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>Select a card to edit its rules, or create one.</div>}
        </div>
      ) : (
        <ReconcileView />
      )}

      {creating && (
        <CreateCardDrawer
          initialCarrierCompanyId={creating.carrierCompanyId}
          onClose={() => setCreating(null)}
          onCreated={(id) => { setCreating(null); setSelectedId(id); }}
        />
      )}

      {companiesOpen && <ThreePLDrawer onClose={closeCompanies} />}
    </div>
  );
};

// ── 3PL companies drawer ──────────────────────────────────────────────────────
/* The 3PL master, opened from the top right of this page. It is the standalone
   ThreePLCompanies screen verbatim (`embedded` only drops its PageHeader, which
   the drawer header replaces), so registering a carrier here and registering it
   at /scm/threepl-companies are the same code path. Closing invalidates the
   carrier list — see COMPANY_LIST_KEY above for why that is not automatic. */
const ThreePLDrawer = ({ onClose }: { onClose: () => void }) => (
  <>
    <div className={styles.backdrop} onClick={onClose} />
    <aside className={styles.drawer}>
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>3PL Companies</h2>
        <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
      </header>
      <div className={styles.drawerBody}>
        <ThreePLCompanies embedded />
      </div>
    </aside>
  </>
);

// ── Carrier list ────────────────────────────────────────────────
// Owner's flow (2026-08-01): register the 3PL companies first, then come here to
// see what each one charges. So the list IS the carrier list — every registered
// 3PL appears, whether or not it has a card yet, and a carrier with no card is a
// one-click create rather than something you have to know to add. Own-fleet cost
// structures keep their own group below.
const CardList = ({ cards, companies, isLoading, selectedId, onSelect, onCreateFor, onCreateCompany }: {
  cards: RateCard[];
  companies: Array<{ id: string; name: string }>;
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateFor: (carrierCompanyId: string | null) => void;
  onCreateCompany?: () => void;
}) => {
  const byCompany = new Map<string, RateCard>();
  for (const c of cards) if (c.carrierCompanyId) byCompany.set(c.carrierCompanyId, c);
  const ownFleet = cards.filter((c) => !c.carrierCompanyId);

  const summary = (c: RateCard) =>
    `${c.basis} · per ${c.aggregation.toLowerCase()} · ${c.ruleCount ?? 0} rules${c.isActive ? '' : ' · inactive'}`;

  return (
    <div style={{ border: '1px solid var(--border, rgba(0,0,0,0.1))', borderRadius: 8, overflow: 'hidden' }}>
      <div className={styles.headerRow} style={{ padding: '10px 12px' }}>
        <p className={styles.eyebrow}>{companies.length} carriers</p>
      </div>
      {isLoading && <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>Loading…</div>}
      {!isLoading && companies.length === 0 && (
        <div style={{ padding: 16, color: 'var(--fg-muted)', fontSize: 'var(--fs-13)' }}>
          No 3PL companies registered yet — a rate card is priced per carrier, so there is nothing to price until one exists.
          {onCreateCompany && (
            <>
              {' '}
              <button
                type="button"
                onClick={onCreateCompany}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--c-primary-a, #2563eb)', textDecoration: 'underline' }}
              >
                Register one now
              </button>
              .
            </>
          )}
        </div>
      )}

      {companies.map((co) => {
        const card = byCompany.get(co.id);
        return (
          <button key={co.id} type="button"
            onClick={() => (card ? onSelect(card.id) : onCreateFor(co.id))}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
              background: card && selectedId === card.id ? 'var(--bg-subtle, rgba(37,99,235,0.08))' : 'none',
              border: 'none', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))', font: 'inherit',
            }}>
            <div style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }}>{co.name}</div>
            <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
              {card ? summary(card) : 'No rate card yet — click to add'}
            </div>
          </button>
        );
      })}

      {ownFleet.length > 0 && (
        <>
          <div className={styles.headerRow} style={{ padding: '10px 12px', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
            <p className={styles.eyebrow}>Own fleet</p>
          </div>
          {ownFleet.map((c) => (
            <button key={c.id} type="button" onClick={() => onSelect(c.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
                background: selectedId === c.id ? 'var(--bg-subtle, rgba(37,99,235,0.08))' : 'none',
                border: 'none', borderTop: '1px solid var(--border, rgba(0,0,0,0.06))', font: 'inherit',
              }}>
              <div style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }}>{c.name}</div>
              <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{summary(c)}</div>
            </button>
          ))}
        </>
      )}
    </div>
  );
};

// ── Card editor (fields + rules + calculator) ────────────────────────────────
const CardEditor = ({ cardId, onDeleted }: { cardId: string; onDeleted: () => void }) => {
  const detail = useRateCard(cardId);
  const meta = useRateCardMeta();
  const update = useUpdateRateCard();
  const del = useDeleteRateCard();
  const notify = useNotify();
  const askConfirm = useConfirm();

  const card = detail.data?.card;
  const rules = detail.data?.rules ?? [];

  if (detail.isLoading || !card) return <div style={{ padding: 24, color: 'var(--fg-muted)' }}>Loading card…</div>;

  const patch = (body: Record<string, unknown>) =>
    update.mutate({ id: cardId, ...body }, { onError: (e) => notify({ title: 'Update failed', body: e instanceof Error ? e.message : 'Error', tone: 'error' }) });

  const removeCard = async () => {
    if (!(await askConfirm({ title: `Delete card "${card.name}"?`, body: 'Its rules are removed too. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    del.mutate(cardId, { onSuccess: onDeleted, onError: (e) => notify({ title: 'Delete failed', body: e instanceof Error ? e.message : 'Error', tone: 'error' }) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Card-level dimensions */}
      <section style={{ border: '1px solid var(--border, rgba(0,0,0,0.1))', borderRadius: 8, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--fs-15)' }}>{card.name}</h3>
          <button type="button" className={styles.iconBtn} onClick={removeCard} aria-label="Delete card"><Trash2 {...ICON} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <SelectField label="Charging basis" value={card.basis} onChange={(v) => patch({ basis: v })}
            options={[['SET', 'By set (frame+mattress)'], ['ITEM', 'By item']]} />
          {/* WIRED since mig 0244 — this is what the tier ladder counts. It was
              stored, shown and never read for its whole life; every card said
              "per drop" while the calculator counted sets. */}
          <div>
            <SelectField label="Charge per" value={card.aggregation} onChange={(v) => patch({ aggregation: v })}
              options={[
                ['UNIT', card.basis === 'ITEM' ? 'Item' : 'Set'],
                ['DROP', 'Drop point (per DO)'],
                ['CUSTOMER', 'Customer (same address, same day)'],
                ['TRIP', 'Trip (flat, whatever it carries)'],
              ]} />
            <p style={{ margin: '4px 0 0', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', maxWidth: 240 }}>
              {AGGREGATION_HINT[card.aggregation] ?? AGGREGATION_HINT.UNIT}
            </p>
          </div>
          {/* WHO the card belongs to is a FACT here, not a control. Owner,
              2026-08-02: "我都开着这一间公司了，你还给我 3PL company 那边给我去选，
              那不是有问题吗?" — you reached this card by clicking that carrier in
              the list beside it, so re-picking it could only ever make the
              editor disagree with its own heading. The old "Own-fleet card"
              checkbox was the same mistake twice: own-fleet IS "no carrier", and
              it is now derived server-side (mig 0246). */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Carrier</span>
            <span style={{ display: 'block', padding: '7px 0', fontSize: 'var(--fs-13)' }}>
              {card.carrierCompanyId ? card.name : 'Own fleet'}
            </span>
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
              {card.carrierCompanyId
                ? 'One card per 3PL company. To price a different carrier, open that carrier.'
                : 'Our own cost structure, so a 3PL drop and an own-fleet drop compare.'}
            </span>
          </label>
          <RMField label="Cap (RM)" value={centiToRM(card.capCenti)} onCommit={(v) => patch({ capCenti: v === '' ? null : rmToCenti(v) })} />
          <SelectField label="Rounding" value={card.rounding} onChange={(v) => patch({ rounding: v })}
            options={[['NONE', 'None'], ['NEAREST_10C', 'Nearest 10 sen'], ['NEAREST_RM', 'Nearest RM']]} />
          <label className={styles.field} style={{ alignSelf: 'end' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <input type="checkbox" checked={card.isActive} onChange={(e) => patch({ isActive: e.target.checked })} /> Active
            </span>
          </label>
        </div>
      </section>

      <RulesEditor cardId={cardId} rules={rules} zones={meta.data?.zones ?? []} />
      <CalculatorPanel cardId={cardId} basis={card.basis} zones={meta.data?.zones ?? []} rules={rules} />
    </div>
  );
};

// ── Rules editor ──────────────────────────────────────────────────────────────
const RulesEditor = ({ cardId, rules, zones }: { cardId: string; rules: RateRule[]; zones: string[] }) => {
  const create = useCreateRateRule(cardId);
  const del = useDeleteRateRule(cardId);
  const notify = useNotify();

  const [form, setForm] = useState<{ ruleType: RateRuleType; tierPosition: string; bracketMin: string; bracketMax: string; zone: string; amountRM: string }>({
    ruleType: 'POSITIONAL_TIER', tierPosition: '1', bracketMin: '', bracketMax: '', zone: zones[0] ?? 'MELAKA', amountRM: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((s) => ({ ...s, [k]: v }));

  const addRule = () => {
    const amountCenti = rmToCenti(form.amountRM);
    if (amountCenti == null) { notify({ title: 'Amount required', body: 'Enter a non-negative RM amount.', tone: 'error' }); return; }
    const body: Parameters<typeof create.mutate>[0] = { ruleType: form.ruleType, amountCenti };
    if (form.ruleType === 'POSITIONAL_TIER' || form.ruleType === 'OVERAGE') {
      const n = Number(form.tierPosition);
      if (!Number.isInteger(n) || n < 1) { notify({ title: 'Invalid position', body: form.ruleType === 'OVERAGE' ? 'Cap N must be >= 1.' : 'Tier position must be >= 1.', tone: 'error' }); return; }
      body.tierPosition = n;
    }
    if (form.ruleType === 'SOFA_BRACKET') {
      const lo = Number(form.bracketMin);
      if (!Number.isInteger(lo) || lo < 0) { notify({ title: 'Invalid bracket', body: 'Compartment min must be >= 0.', tone: 'error' }); return; }
      body.bracketMin = lo;
      body.bracketMax = form.bracketMax === '' ? null : Number(form.bracketMax);
    }
    if (form.ruleType === 'OUTSTATION' || form.ruleType === 'OUTSTATION_TRIP') body.zone = form.zone;
    create.mutate(body, { onSuccess: () => set('amountRM', ''), onError: (e) => notify({ title: 'Add failed', body: e instanceof Error ? e.message : 'Error', tone: 'error' }) });
  };

  const describe = (r: RateRule): string => {
    if (r.ruleType === 'POSITIONAL_TIER') return `${r.tierPosition === 1 ? '1st' : r.tierPosition === 2 ? '2nd' : r.tierPosition === 3 ? '3rd+' : `${r.tierPosition}th`} unit`;
    if (r.ruleType === 'OVERAGE') return `beyond cap ${r.tierPosition}, each`;
    if (r.ruleType === 'SOFA_BRACKET') return `${r.bracketMin}${r.bracketMax == null ? '+' : `-${r.bracketMax}`} compartments`;
    if (r.ruleType === 'OUTSTATION') return `${r.zone ?? ''} · per order`;
    if (r.ruleType === 'OUTSTATION_TRIP') return `${r.zone ?? ''} · fixed per trip`;
    return 'each occurrence';
  };

  /* Grouped by CATEGORY, not sorted alphabetically. The old ordering put
     DISMANTLE, DISPOSE, INSPECTION, OUTSTATION, OVERAGE, PICKUP,
     POSITIONAL_TIER... in one flat run, so the three rules that price a
     delivery sat apart from each other and outstation sat between a sofa
     bracket and a service call. */
  const grouped = useMemo(() => {
    const order = new Map<RateRuleCategory, number>(RATE_RULE_CATEGORIES.map((cat, i) => [cat, i]));
    const byCat = new Map<RateRuleCategory, RateRule[]>();
    for (const r of rules) {
      /* An unknown rule type falls into Delivery rather than vanishing — a rule
         the operator can see and delete beats one that silently disappears. */
      const cat: RateRuleCategory = RULE_CATEGORY[r.ruleType as keyof typeof RULE_CATEGORY] ?? 'DELIVERY';
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
    <section style={{ border: '1px solid var(--border, rgba(0,0,0,0.1))', borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 'var(--fs-15)' }}>Rules ({rules.length})</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>
            <th style={{ padding: '4px 8px' }}>Type</th><th style={{ padding: '4px 8px' }}>Applies to</th>
            <th style={{ padding: '4px 8px', textAlign: 'right' }}>Amount (RM)</th><th />
          </tr>
        </thead>
        {grouped.map(({ category, rules: list }) => (
        <tbody key={category}>
          <tr>
            <td colSpan={4} style={{ padding: '10px 8px 4px', fontSize: 'var(--fs-11)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)' }}>
              {CATEGORY_LABEL[category]}
              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
                {CATEGORY_HINT[category]}
              </span>
            </td>
          </tr>
          {list.map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))' }}>
              <td style={{ padding: '6px 8px' }}>{RULE_LABEL[r.ruleType]}</td>
              <td style={{ padding: '6px 8px', color: 'var(--fg-muted)' }}>{describe(r)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{centiToRM(r.amountCenti)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                <button type="button" className={styles.iconBtn} disabled={del.isPending}
                  onClick={() => del.mutate(r.id, { onError: (e) => notify({ title: 'Delete failed', body: e instanceof Error ? e.message : 'Error', tone: 'error' }) })}
                  aria-label="Delete rule"><Trash2 {...ICON} /></button>
              </td>
            </tr>
          ))}
        </tbody>
        ))}
        {rules.length === 0 && (
          <tbody><tr><td colSpan={4} style={{ padding: 12, color: 'var(--fg-muted)' }}>No rules yet — add one below.</td></tr></tbody>
        )}
      </table>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)' }}>Rule type</span>
          {/* optgroup, so a twelve-item flat list stops making the operator
              read every option to find the one for the job they are pricing. */}
          <select value={form.ruleType} onChange={(e) => set('ruleType', e.target.value as RateRuleType)}
            style={{ padding: '6px 8px', fontSize: 'var(--fs-13)', borderRadius: 6, border: '1px solid var(--border, rgba(0,0,0,0.15))', background: 'var(--bg, #fff)', color: 'var(--fg, #111)' }}>
            {rulesByCategory().map(({ category, types }) => (
              <optgroup key={category} label={CATEGORY_LABEL[category]}>
                {types.map((t) => <option key={t} value={t}>{RULE_LABEL[t]}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {needsPosition && <RMLikeInput label={form.ruleType === 'OVERAGE' ? 'Cap N' : 'Position (3=3rd+)'} value={form.tierPosition} onChange={(v) => set('tierPosition', v)} width={110} />}
        {needsBracket && <RMLikeInput label="Comp min" value={form.bracketMin} onChange={(v) => set('bracketMin', v)} width={90} />}
        {needsBracket && <RMLikeInput label="Comp max (blank=+)" value={form.bracketMax} onChange={(v) => set('bracketMax', v)} width={130} />}
        {needsZone && <SelectField label="Zone" value={form.zone} onChange={(v) => set('zone', v)} options={zones.map((z) => [z, z])} />}
        <RMLikeInput label="Amount (RM)" value={form.amountRM} onChange={(v) => set('amountRM', v)} width={110} />
        <Button variant="secondary" size="md" onClick={addRule} disabled={create.isPending}><Plus {...ICON} /><span>Add rule</span></Button>
      </div>
    </section>
  );
};

/* Which calculator input feeds which rule, in the same four groups as the rules
   table. `rule: null` means the input is not gated on one rule — the set/item
   count feeds the tier ladder and the zone feeds both outstation kinds, so
   dimming either on a single rule's absence would be wrong. */
type CalcKey = 'count' | 'sofa' | 'zone' | 'dispose' | 'setup' | 'dismantle' | 'service' | 'pickup' | 'inspection' | 'transfer';
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
    { key: 'transfer', label: 'Transfer', rule: 'TRANSFER' },
  ] },
  { category: 'OUTSTATION', fields: [
    { key: 'zone', label: 'Destination zone', rule: null },
  ] },
];

// ── Cost calculator (live) ────────────────────────────────────────────────────
const CalculatorPanel = ({ cardId, basis, zones, rules }: { cardId: string; basis: string; zones: string[]; rules: RateRule[] }) => {
  const compute = useComputeCost(cardId);
  const [facts, setFacts] = useState<{ count: string; sofa: string; zone: string; dispose: string; setup: string; dismantle: string; service: string; pickup: string; inspection: string; transfer: string }>(
    { count: '2', sofa: '3', zone: '', dispose: '1', setup: '1', dismantle: '1', service: '', pickup: '', inspection: '', transfer: '' },
  );
  const set = <K extends keyof typeof facts>(k: K, v: typeof facts[K]) => setFacts((s) => ({ ...s, [k]: v }));

  const run = () => {
    const num = (v: string): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const sofaCompartments = facts.sofa.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    const body: DeliveryFacts = {
      [basis === 'ITEM' ? 'itemCount' : 'setCount']: num(facts.count),
      sofaCompartments: sofaCompartments.length ? sofaCompartments : null,
      destinationZone: facts.zone || null,
      disposeCount: num(facts.dispose), setupCount: num(facts.setup), dismantleCount: num(facts.dismantle),
      serviceCount: num(facts.service), pickupCount: num(facts.pickup), inspectionCount: num(facts.inspection), transferCount: num(facts.transfer),
    };
    compute.mutate(body);
  };

  /* Which rule types this card actually carries — drives the dimming. */
  const present = useMemo(() => new Set(rules.map((r) => r.ruleType as string)), [rules]);

  const breakdown = compute.data?.breakdown;

  return (
    <section style={{ border: '1px solid var(--border, rgba(0,0,0,0.1))', borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 'var(--fs-15)' }}>Cost calculator</h3>
      <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
        Price a drop against this card. Sofas are priced by their compartment bracket (comma-separated per sofa), separately from the {basis === 'ITEM' ? 'item' : 'set'} tiers.
      </p>
      {/* Grouped by the SAME categories as the rules above, and an input whose
          rule this card does not carry is DIMMED with the reason. Ten
          equal-weight boxes gave no clue that typing in one of them would
          change nothing — the card has no rule to price it, so the figure comes
          back identical and the operator has no way to know why. */}
      {CALC_GROUPS.map(({ category, fields }) => {
        const anyPriced = fields.some((f) => f.rule === null || present.has(f.rule));
        return (
          <div key={category} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)', marginBottom: 4 }}>
              {CATEGORY_LABEL[category]}
              {!anyPriced && <span style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>— this card has no rules here, so these stay at zero</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
              {fields.map((f) => {
                const priced = f.rule === null || present.has(f.rule);
                return (
                  <div key={f.key} style={{ opacity: priced ? 1 : 0.45 }} title={priced ? undefined : `This card has no ${RULE_LABEL[f.rule!]} rule, so this input cannot change the total.`}>
                    {f.key === 'zone'
                      ? <SelectField label="Destination zone" value={facts.zone} onChange={(v) => set('zone', v)} options={[['', 'In-town'], ...zones.map((z) => [z, z] as [string, string])]} />
                      : <RMLikeInput label={f.key === 'count' ? (basis === 'ITEM' ? 'Items' : 'Sets') : f.label} value={facts[f.key]} onChange={(v) => set(f.key, v)} />}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 12 }}>
        <Button variant="primary" size="md" onClick={run} disabled={compute.isPending}>{compute.isPending ? 'Computing…' : 'Compute cost'}</Button>
      </div>
      {breakdown && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border, rgba(0,0,0,0.1))', paddingTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <tbody>
              {breakdown.lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ padding: '3px 8px', color: l.amountCenti < 0 ? 'var(--fg-muted)' : undefined }}>{l.label}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>{l.amountCenti < 0 ? '−' : ''}RM {centiToRM(Math.abs(l.amountCenti))}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.2))', fontWeight: 700 }}>
                <td style={{ padding: '6px 8px' }}>Total</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>RM {centiToRM(breakdown.totalCenti)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

// ── Reconciliation view ────────────────────────────────────────────────────────
const ReconcileView = () => {
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const recon = useReconcile(range);
  const rows = recon.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        3PL (outsourced) trips carrying a captured billed cost, matched to the carrier's rate card. Expected cost is computed from the trip's derived facts (set count + destination zone); occurrence charges and sofa compartments are not derivable from trip data (facts incomplete), so refine those in the calculator. A non-zero delta is flagged for review.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <RMLikeInput label="From" value={range.from} onChange={(v) => setRange((s) => ({ ...s, from: v }))} type="date" width={150} />
        <RMLikeInput label="To" value={range.to} onChange={(v) => setRange((s) => ({ ...s, to: v }))} type="date" width={150} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}>
            <th style={{ padding: '4px 8px' }}>Trip</th><th style={{ padding: '4px 8px' }}>Date</th>
            <th style={{ padding: '4px 8px' }}>Card</th><th style={{ padding: '4px 8px' }}>Drops</th>
            <th style={{ padding: '4px 8px' }}>Zone</th>
            <th style={{ padding: '4px 8px', textAlign: 'right' }}>Expected</th>
            <th style={{ padding: '4px 8px', textAlign: 'right' }}>Billed</th>
            <th style={{ padding: '4px 8px', textAlign: 'right' }}>Delta</th>
            <th style={{ padding: '4px 8px' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {recon.isLoading && <tr><td colSpan={9} style={{ padding: 12, color: 'var(--fg-muted)' }}>Loading…</td></tr>}
          {!recon.isLoading && rows.length === 0 && <tr><td colSpan={9} style={{ padding: 12, color: 'var(--fg-muted)' }}>No 3PL trips with a captured billed cost in range.</td></tr>}
          {rows.map((r) => (
            <tr key={r.tripId} style={{ borderTop: '1px solid var(--border, rgba(0,0,0,0.06))', background: r.flagged ? 'rgba(220,38,38,0.06)' : undefined }}>
              <td style={{ padding: '6px 8px' }}>{r.tripNo ?? r.tripId.slice(0, 8)}</td>
              <td style={{ padding: '6px 8px' }}>{r.tripDate ?? '—'}</td>
              <td style={{ padding: '6px 8px' }}>{r.matched ? r.cardName : <span style={{ color: 'var(--fg-muted)' }}>no card</span>}</td>
              <td style={{ padding: '6px 8px' }}>{r.dropCount}</td>
              <td style={{ padding: '6px 8px' }}>{r.derivedZone ?? '—'}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.expectedCenti == null ? '—' : `RM ${centiToRM(r.expectedCenti)}`}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>RM {centiToRM(r.billedCenti)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', color: r.flagged ? 'var(--c-danger, #dc2626)' : 'var(--fg-muted)' }}>
                {r.deltaCenti == null ? '—' : `${r.deltaCenti > 0 ? '+' : r.deltaCenti < 0 ? '−' : ''}RM ${centiToRM(Math.abs(r.deltaCenti))}`}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {!r.matched ? <span style={{ color: 'var(--fg-muted)' }}>unmatched</span>
                  : r.flagged ? <span style={{ color: 'var(--c-danger, #dc2626)', fontWeight: 600 }}>mismatch</span>
                  : <span style={{ color: 'var(--c-secondary-a, #16a34a)' }}>match</span>}
                {r.matched && !r.factsComplete && <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-11)' }}> · facts partial</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const notify = useNotify();
  const [form, setForm] = useState({ name: '', carrierCompanyId: initialCarrierCompanyId ?? '', basis: 'SET' as 'SET' | 'ITEM', aggregation: 'UNIT' as RateAggregation });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    /* A carrier card is NAMED BY ITS COMPANY (server-side), so the name is only
       asked for — and only required — when there is no company to name it. */
    if (!form.carrierCompanyId && !form.name.trim()) {
      notify({ title: 'Pick a 3PL company, or name the card.', tone: 'error' }); return;
    }
    create.mutate(
      { name: form.carrierCompanyId ? undefined : form.name.trim(), carrierCompanyId: form.carrierCompanyId || null, basis: form.basis, aggregation: form.aggregation },
      { onSuccess: (r) => onCreated(r.card.id), onError: (e) => notify({ title: 'Create failed', body: e instanceof Error ? e.message : 'Error', tone: 'error' }) },
    );
  };

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <aside className={styles.drawer}>
        <header className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>New Rate Card</h2>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X {...ICON} /></button>
        </header>
        <div className={styles.drawerBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>3PL company (carrier) *</span>
            <select className={styles.fieldInput} value={form.carrierCompanyId} onChange={(e) => set('carrierCompanyId', e.target.value)}>
              <option value="">Own fleet / none</option>
              {(meta.data?.companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
              {form.carrierCompanyId
                ? 'The card takes the company name. One card per company.'
                : 'Register carriers under Maintenance > 3PL Companies.'}
            </span>
          </label>
          {!form.carrierCompanyId && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name *</span>
              <input className={styles.fieldInput} value={form.name} placeholder="e.g. Own fleet cost structure" onChange={(e) => set('name', e.target.value)} />
            </label>
          )}
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Charging basis</span>
              <select className={styles.fieldInput} value={form.basis} onChange={(e) => set('basis', e.target.value as 'SET' | 'ITEM')}>
                <option value="SET">By set</option><option value="ITEM">By item</option>
              </select>
            </label>
            {/* All four, matching the editor. This offered only DROP/CUSTOMER
                and defaulted to DROP, so every card created here started on a
                setting the calculator does not price the way the label reads —
                mig 0244 made UNIT the default for exactly that reason. */}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Charge per</span>
              <select className={styles.fieldInput} value={form.aggregation} onChange={(e) => set('aggregation', e.target.value as RateAggregation)}>
                <option value="UNIT">{form.basis === 'ITEM' ? 'Item' : 'Set'}</option>
                <option value="DROP">Drop point (per DO)</option>
                <option value="CUSTOMER">Customer (same address, same day)</option>
                <option value="TRIP">Trip (flat, whatever it carries)</option>
              </select>
            </label>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
            {AGGREGATION_HINT[form.aggregation] ?? AGGREGATION_HINT.UNIT}
          </p>
        </div>
        <footer className={styles.drawerFooter}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create Card'}</Button>
        </footer>
      </aside>
    </>
  );
};

// ── Small field helpers ────────────────────────────────────────────────────────
const SelectField = ({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) => (
  <label className={styles.field}>
    <span className={styles.fieldLabel}>{label}</span>
    <select className={styles.fieldInput} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </label>
);

const RMLikeInput = ({ label, value, onChange, width, type }: { label: string; value: string; onChange: (v: string) => void; width?: number; type?: string }) => (
  <label className={styles.field} style={width ? { maxWidth: width } : undefined}>
    <span className={styles.fieldLabel}>{label}</span>
    <input className={styles.fieldInput} type={type ?? 'text'} inputMode={type ? undefined : 'decimal'} value={value} onChange={(e) => onChange(e.target.value)} />
  </label>
);

const RMField = ({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) => {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input className={styles.fieldInput} inputMode="decimal" value={buf ?? value}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={() => { if (buf !== null && buf !== value) onCommit(buf); setBuf(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
};
