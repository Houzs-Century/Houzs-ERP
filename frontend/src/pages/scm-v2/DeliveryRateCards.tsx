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
import { Plus, X, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useRateCards, useRateCard, useRateCardMeta,
  useCreateRateCard, useUpdateRateCard, useDeleteRateCard,
  useCreateRateRule, useDeleteRateRule, useComputeCost, useReconcile,
  type RateCard, type RateRule, type RateRuleType, type DeliveryFacts,
} from '../../vendor/scm/lib/delivery-rate-card-queries';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const centiToRM = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
const rmToCenti = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

const RULE_LABEL: Record<RateRuleType, string> = {
  POSITIONAL_TIER: 'Positional tier',
  OVERAGE: 'Cap overage',
  SOFA_BRACKET: 'Sofa bracket',
  OUTSTATION: 'Outstation zone (per order)',
  OUTSTATION_TRIP: 'Outstation trip (fixed, per trip)',
  DISPOSE: 'Dispose',
  SETUP: 'Setup',
  DISMANTLE: 'Dismantle',
  SERVICE: 'Service',
  PICKUP: 'Pickup',
  INSPECTION: 'Inspection',
  TRANSFER: 'Transfer',
};

export const DeliveryRateCards = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const [tab, setTab] = useState<'cards' | 'reconcile'>('cards');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ carrierCompanyId: string | null } | null>(null);
  const cards = useRateCards();
  const meta = useRateCardMeta();

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader
          eyebrow="Delivery"
          title="Delivery Rate Cards"
          description="Configure a rate card per carrier (own-fleet + each 3PL), verify a 3PL's billed charge against the computed expected cost, and roll the precise delivery cost toward COGS. Cost verification, not customer billing — and it does not touch the FIFO costing path."
          actions={tab === 'cards' ? (
            <Button variant="primary" size="md" onClick={() => setCreating({ carrierCompanyId: null })}>
              <Plus {...ICON} /><span>New Card</span>
            </Button>
          ) : undefined}
        />
      )}

      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
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
    </div>
  );
};

// ── Carrier list ────────────────────────────────────────────────
// Owner's flow (2026-08-01): register the 3PL companies first, then come here to
// see what each one charges. So the list IS the carrier list — every registered
// 3PL appears, whether or not it has a card yet, and a carrier with no card is a
// one-click create rather than something you have to know to add. Own-fleet cost
// structures keep their own group below.
const CardList = ({ cards, companies, isLoading, selectedId, onSelect, onCreateFor }: {
  cards: RateCard[];
  companies: Array<{ id: string; name: string }>;
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateFor: (carrierCompanyId: string | null) => void;
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
          No 3PL companies registered yet. Register them under Maintenance &rsaquo; 3PL Companies, then price them here.
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
          <SelectField label="Aggregation" value={card.aggregation} onChange={(v) => patch({ aggregation: v })}
            options={[['DROP', 'Per drop point'], ['CUSTOMER', 'Per customer']]} />
          {/* WS4b: a card is priced per 3PL COMPANY (its lorries inherit). "Own
              fleet / none" leaves it unattached — pair with the own-fleet flag. */}
          <SelectField label="3PL company (carrier)" value={card.carrierCompanyId ?? ''} onChange={(v) => patch({ carrierCompanyId: v || null })}
            options={[['', 'Own fleet / none'], ...(meta.data?.companies ?? []).map((c) => [c.id, c.name] as [string, string])]} />
          <RMField label="Cap (RM)" value={centiToRM(card.capCenti)} onCommit={(v) => patch({ capCenti: v === '' ? null : rmToCenti(v) })} />
          <SelectField label="Rounding" value={card.rounding} onChange={(v) => patch({ rounding: v })}
            options={[['NONE', 'None'], ['NEAREST_10C', 'Nearest 10 sen'], ['NEAREST_RM', 'Nearest RM']]} />
          <label className={styles.field} style={{ alignSelf: 'end' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <input type="checkbox" checked={card.isOwnFleet} onChange={(e) => patch({ isOwnFleet: e.target.checked })} /> Own-fleet card
            </span>
          </label>
          <label className={styles.field} style={{ alignSelf: 'end' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <input type="checkbox" checked={card.isActive} onChange={(e) => patch({ isActive: e.target.checked })} /> Active
            </span>
          </label>
        </div>
      </section>

      <RulesEditor cardId={cardId} rules={rules} zones={meta.data?.zones ?? []} />
      <CalculatorPanel cardId={cardId} basis={card.basis} zones={meta.data?.zones ?? []} />
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

  const sorted = useMemo(() => [...rules].sort((a, b) => a.ruleType.localeCompare(b.ruleType) || (a.tierPosition ?? 0) - (b.tierPosition ?? 0) || (a.bracketMin ?? 0) - (b.bracketMin ?? 0)), [rules]);

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
        <tbody>
          {sorted.map((r) => (
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
          {rules.length === 0 && <tr><td colSpan={4} style={{ padding: 12, color: 'var(--fg-muted)' }}>No rules yet — add one below.</td></tr>}
        </tbody>
      </table>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, rgba(0,0,0,0.1))' }}>
        <SelectField label="Rule type" value={form.ruleType} onChange={(v) => set('ruleType', v as RateRuleType)}
          options={(Object.keys(RULE_LABEL) as RateRuleType[]).map((k) => [k, RULE_LABEL[k]])} />
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

// ── Cost calculator (live) ────────────────────────────────────────────────────
const CalculatorPanel = ({ cardId, basis, zones }: { cardId: string; basis: string; zones: string[] }) => {
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

  const breakdown = compute.data?.breakdown;

  return (
    <section style={{ border: '1px solid var(--border, rgba(0,0,0,0.1))', borderRadius: 8, padding: 16 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 'var(--fs-15)' }}>Cost calculator</h3>
      <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>
        Price a drop against this card. Sofas are priced by their compartment bracket (comma-separated per sofa), separately from the {basis === 'ITEM' ? 'item' : 'set'} tiers.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        <RMLikeInput label={basis === 'ITEM' ? 'Items' : 'Sets'} value={facts.count} onChange={(v) => set('count', v)} />
        <RMLikeInput label="Sofa comps (e.g. 3,6)" value={facts.sofa} onChange={(v) => set('sofa', v)} />
        <SelectField label="Destination zone" value={facts.zone} onChange={(v) => set('zone', v)} options={[['', 'In-town'], ...zones.map((z) => [z, z] as [string, string])]} />
        <RMLikeInput label="Dispose" value={facts.dispose} onChange={(v) => set('dispose', v)} />
        <RMLikeInput label="Setup" value={facts.setup} onChange={(v) => set('setup', v)} />
        <RMLikeInput label="Dismantle" value={facts.dismantle} onChange={(v) => set('dismantle', v)} />
        <RMLikeInput label="Service" value={facts.service} onChange={(v) => set('service', v)} />
        <RMLikeInput label="Pickup" value={facts.pickup} onChange={(v) => set('pickup', v)} />
        <RMLikeInput label="Inspection" value={facts.inspection} onChange={(v) => set('inspection', v)} />
        <RMLikeInput label="Transfer" value={facts.transfer} onChange={(v) => set('transfer', v)} />
      </div>
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
  const [form, setForm] = useState({ name: '', carrierCompanyId: initialCarrierCompanyId ?? '', basis: 'SET' as 'SET' | 'ITEM', aggregation: 'DROP' as 'DROP' | 'CUSTOMER', isOwnFleet: false });
  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    /* A carrier card is NAMED BY ITS COMPANY (server-side), so the name is only
       asked for — and only required — when there is no company to name it. */
    if (!form.carrierCompanyId && !form.name.trim()) {
      notify({ title: 'Pick a 3PL company, or name the card.', tone: 'error' }); return;
    }
    create.mutate(
      { name: form.carrierCompanyId ? undefined : form.name.trim(), carrierCompanyId: form.carrierCompanyId || null, basis: form.basis, aggregation: form.aggregation, isOwnFleet: form.isOwnFleet },
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
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Aggregation</span>
              <select className={styles.fieldInput} value={form.aggregation} onChange={(e) => set('aggregation', e.target.value as 'DROP' | 'CUSTOMER')}>
                <option value="DROP">Per drop</option><option value="CUSTOMER">Per customer</option>
              </select>
            </label>
          </div>
          <label className={styles.field}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <input type="checkbox" checked={form.isOwnFleet} onChange={(e) => set('isOwnFleet', e.target.checked)} /> Own-fleet card (cost structure)
            </span>
          </label>
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
