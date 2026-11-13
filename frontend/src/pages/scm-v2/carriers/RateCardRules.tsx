// A rate card's prices, one category at a time. Owner 2026-11-11 on the card
// editor: 「先帮我重新design 这个UI 先，看了很乱」 — the four categories ran down
// one long page with a pencil and a bin beside every price. Now each category
// is a tab, its prices a ruled table (a price clicked changes or removes it), outstation towns
// sit together by price (OutstationPrices.tsx), and Price check is the fifth
// tab (「做多一个categories按钮」, PriceCheck.tsx).
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Calculator, Plus } from 'lucide-react';
import type { RateArea, RateCard, RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { cn } from '../../../lib/utils';
import { DataTable, type Column } from '../../../components/DataTable';
import { useSmallViewport } from '../../../hooks/useSmallViewport';
import { CATEGORY_HINT, CATEGORY_LABEL, RULE_LABEL } from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { CATEGORY_ORDER, flatTitle, flatTypesOf, type FlatRuleType, type PriceCell, type RuleBlock, type RuleSection } from './rateCardLayout';
import { AddPriceCell, AddRule, Panel, PriceButton, panelId, tabId, type RateSection } from './ruleEditors';
import { OutstationPrices } from './OutstationPrices';
import { PriceCheck } from './PriceCheck';
import type { PriceCheckForm } from './priceCheckFacts';
import { BTN_QUIET, Pill } from './ui';

export type { RateSection } from './ruleEditors';
const SECTIONS: readonly RateSection[] = [...CATEGORY_ORDER, 'PRICE_CHECK'];

/** The card's tabs, at the foot of its header: each category with how many
 *  prices it holds ("—" for none), then Price check. Arrow keys move along.
 *  Outstation counts the card's areas with its town prices. */
export const SectionTabs = ({ sections, areaCount, value, onChange }: {
  sections: RuleSection[]; areaCount: number; value: RateSection; onChange: (s: RateSection) => void;
}) => {
  const refs = useRef(new Map<RateSection, HTMLButtonElement>());
  const onKey = (e: KeyboardEvent, from: RateSection) => {
    const i = SECTIONS.indexOf(from);
    const to = e.key === 'ArrowRight' ? SECTIONS[(i + 1) % SECTIONS.length]
      : e.key === 'ArrowLeft' ? SECTIONS[(i - 1 + SECTIONS.length) % SECTIONS.length]
      : e.key === 'Home' ? SECTIONS[0]
      : e.key === 'End' ? SECTIONS[SECTIONS.length - 1]
      : null;
    if (to == null) return;
    e.preventDefault();
    onChange(to);
    refs.current.get(to)?.focus();
  };
  const tab = (s: RateSection, content: ReactNode) => {
    const on = value === s;
    return (
      <button key={s} type="button" role="tab" id={tabId(s)} aria-selected={on} aria-controls={on ? panelId(s) : undefined} tabIndex={on ? 0 : -1}
        ref={(el) => { if (el) refs.current.set(s, el); else refs.current.delete(s); }}
        onClick={() => onChange(s)} onKeyDown={(e) => onKey(e, s)}
        className={cn('flex min-h-[44px] flex-none items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13px]',
          on ? 'border-primary font-semibold text-ink' : 'border-transparent font-medium text-ink-muted hover:text-ink')}>
        {content}
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="Rate card sections" className="no-scrollbar relative -mx-5 flex items-center overflow-x-auto overflow-y-hidden border-t border-border px-3">
      {CATEGORY_ORDER.map((cat) => {
        const count = (sections.find((s) => s.category === cat)?.count ?? 0) + (cat === 'OUTSTATION' ? areaCount : 0);
        return tab(cat, (
          <>
            {CATEGORY_LABEL[cat]}
            <span aria-hidden className="tabular-nums text-ink-muted">{count || '—'}</span>
            <span className="sr-only">{count ? `, ${count} ${count === 1 ? 'price' : 'prices'}` : ', none'}</span>
          </>
        ));
      })}
      <span aria-hidden className="mx-1.5 h-5 w-px flex-none bg-border" />
      {tab('PRICE_CHECK', <><Calculator size={15} strokeWidth={1.75} aria-hidden />Price check</>)}
    </div>
  );
};

type Ladder = Extract<RuleBlock, { kind: 'ladder' }>;
interface PriceGroup { id: string; title: string; cells: PriceCell[]; missing: FlatRuleType[] }

/** One line of a category's price table: a price the card carries, or one it
 *  could carry and does not (added from its RM cell). */
interface PriceLine { key: string; group: string; label: string; cell: PriceCell | null; missing: FlatRuleType | null }

const priceLines = (groups: readonly PriceGroup[]): PriceLine[] => groups.flatMap((g) => [
  ...g.cells.map((c) => ({ key: c.rule.id, group: g.title, label: c.label, cell: c, missing: null })),
  ...g.missing.map((t) => ({ key: `add-${t}`, group: g.title, label: RULE_LABEL[t], cell: null, missing: t })),
]);

/** Delivery, Setup & dismantle and Service calls: their prices as a finance
 *  table (owner 2026-11-11: 「这个也整理一下」, then 「table 可以用 finance table」):
 *  a shaded group row per kind, a line per price, an Add line for each price the
 *  category could carry and the card does not; widths, columns, print and
 *  export from the header menu, as on every Finance list. */
const PricesPanel = ({ cardId, section, zones }: { cardId: string; section: RuleSection; zones: string[] }) => {
  const [adding, setAdding] = useState(false);
  const cat = section.category;
  const label = CATEGORY_LABEL[cat];
  const ladders = section.blocks.filter((b): b is Ladder => b.kind === 'ladder');
  const present = new Set(ladders.flatMap((b) => b.cells.map((c) => c.rule.ruleType as string)));
  const missing = flatTypesOf(cat).filter((t) => !present.has(t));
  const groups: PriceGroup[] = ladders.map((b) => ({ id: b.id, title: b.title, cells: b.cells, missing: b.id === 'flat' ? missing : [] }));
  if (!ladders.some((b) => b.id === 'flat') && missing.length > 0) groups.push({ id: 'flat', title: flatTitle(cat), cells: [], missing });
  /* Positions, cap overage and sofa brackets need more than an amount, so
     Delivery keeps the full form; the other two take amounts only. */
  const needsForm = cat === 'DELIVERY';
  const lines = useMemo(() => priceLines(groups), [groups]);
  /* A phone keeps the grid, not cards: cards drop the shaded kind rows. */
  const small = useSmallViewport();
  const columns = useMemo<Column<PriceLine>[]>(() => [
    { key: 'kind', label: 'Kind', defaultHidden: true, disableSort: true, getValue: (r) => r.group, render: (r) => r.group },
    {
      key: 'price', label: 'Price', disableSort: true, getValue: (r) => r.label,
      render: (r) => (r.cell
        ? <span className="inline-flex items-center gap-1.5">{r.label}{r.cell.duplicate && <Pill tone="amber">Twice</Pill>}</span>
        : <span className="text-ink-muted">{r.label}</span>),
    },
    {
      key: 'rm', label: 'RM', align: 'right', width: '170px', disableSort: true,
      getValue: (r) => (r.cell ? r.cell.rule.amountSen / 100 : null),
      exportValue: (r) => (r.cell ? r.cell.rule.amountSen / 100 : ''),
      render: (r) => (r.cell
        ? <PriceButton cardId={cardId} rule={r.cell.rule} name={r.label} />
        : r.missing && <AddPriceCell cardId={cardId} rule={{ ruleType: r.missing }} label={r.label} />),
    },
  ], [cardId]);
  return (
    <Panel section={cat} title={label} note={null} hint={CATEGORY_HINT[cat]}
      actions={needsForm && !adding
        ? <button type="button" className={cn(BTN_QUIET, 'min-h-[36px] px-3 text-[13px]')} onClick={() => setAdding(true)} aria-label={`Add a ${label} rule`}>
            <Plus size={15} strokeWidth={1.75} />Add rule
          </button>
        : null}>
      {section.count === 0 && <p className="text-[13px] text-ink-muted">This card has no {label.toLowerCase()} prices yet.</p>}
      {groups.length > 0 && (
        <div className="max-w-[680px]">
          <DataTable<PriceLine>
            tableId="rate-card-prices" embedded={small} exportName={`rate-card-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`} exportXlsx
            columns={columns} rows={lines} getRowKey={(r) => r.key} groupBy={{ key: 'kind' }}
            emptyLabel={`This card has no ${label.toLowerCase()} prices yet.`}
            freezeHeight="off"
          />
        </div>
      )}
      {adding && <AddRule cardId={cardId} category={cat} zones={zones} initialType={null} onDone={() => setAdding(false)} />}
    </Panel>
  );
};

/** The open tab's content. */
export const RateCardSection = ({ card, rules, areas, areaRules, unit, sections, zones, section, checkForm, onCheckForm }: {
  card: RateCard; rules: readonly RateRule[]; areas: readonly RateArea[]; areaRules: readonly RateRule[]; unit: string;
  sections: RuleSection[]; zones: string[]; section: RateSection;
  checkForm: PriceCheckForm; onCheckForm: (f: PriceCheckForm) => void;
}) => {
  if (section === 'PRICE_CHECK') return <PriceCheck card={card} rules={rules} areas={areas} areaRules={areaRules} form={checkForm} onForm={onCheckForm} />;
  const s = sections.find((x) => x.category === section);
  if (!s) return null;
  /* Keyed by category: each tab starts with its own add form closed, rather
     than one tab's open form following the user to the next. */
  return section === 'OUTSTATION'
    ? <OutstationPrices cardId={card.id} rules={rules} areas={areas} areaRules={areaRules} unit={unit} section={s} zones={zones} />
    : <PricesPanel key={section} cardId={card.id} section={s} zones={zones} />;
};
