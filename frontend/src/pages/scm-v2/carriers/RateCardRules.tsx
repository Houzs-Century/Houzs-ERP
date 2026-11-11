// A rate card's prices, one category at a time. Owner 2026-11-11 on the card
// editor: 「先帮我重新design 这个UI 先，看了很乱」 — the four categories ran down
// one long page with a pencil and a bin beside every price. Now each category
// is a tab, its prices a ruled table (a price clicked changes or removes it), outstation towns
// sit together by price (OutstationPrices.tsx), and Price check is the fifth
// tab (「做多一个categories按钮」, PriceCheck.tsx).
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Calculator, Plus } from 'lucide-react';
import type { RateArea, RateCard, RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { cn } from '../../../lib/utils';
import { CATEGORY_HINT, CATEGORY_LABEL, RULE_LABEL } from '../../../vendor/scm/lib/rate-rule-taxonomy';
import { CATEGORY_ORDER, flatTitle, flatTypesOf, type FlatRuleType, type PriceCell, type RuleBlock, type RuleSection } from './rateCardLayout';
import { AddPriceCell, AddRule, Panel, PriceButton, panelId, tabId, type RateSection } from './ruleEditors';
import { OutstationPrices } from './OutstationPrices';
import { PriceCheck } from './PriceCheck';
import type { PriceCheckForm } from './priceCheckFacts';
import { BTN_QUIET, Pill, T_CELL, T_HEAD, T_SECTION } from './ui';

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
        className={cn('flex min-h-[44px] flex-none items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-[13.5px]',
          on ? 'border-primary font-bold text-ink' : 'border-transparent font-medium text-ink-muted hover:text-ink')}>
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

/** Delivery, Setup & dismantle and Service calls: their prices as one ruled
 *  two-column table (owner 2026-11-11: 「这个也整理一下」, like the transporters'
 *  own rate sheets), a shaded row per kind, and an Add row for each price the
 *  category could carry and the card does not. */
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
  return (
    <Panel section={cat} title={label} note={null} hint={CATEGORY_HINT[cat]}
      actions={needsForm && !adding
        ? <button type="button" className={cn(BTN_QUIET, 'min-h-[36px] px-3 text-[13px]')} onClick={() => setAdding(true)} aria-label={`Add a ${label} rule`}>
            <Plus size={15} strokeWidth={1.75} />Add rule
          </button>
        : null}>
      {section.count === 0 && <p className="text-[13px] text-ink-muted">This card has no {label.toLowerCase()} prices yet.</p>}
      {groups.length > 0 && (
        <table className="w-full max-w-[640px] border-collapse text-[13px] tabular-nums">
          <thead>
            <tr>
              <th scope="col" className={cn(T_HEAD, 'text-left')}>Price</th>
              <th scope="col" className={cn(T_HEAD, 'w-[150px] text-right')}>RM</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.id} aria-label={g.title}>
              <tr><th scope="colgroup" colSpan={2} className={T_SECTION}>{g.title}</th></tr>
              {g.cells.map((c) => (
                <tr key={c.rule.id}>
                  <td className={T_CELL}>
                    <span className="inline-flex items-center gap-1.5">{c.label}{c.duplicate && <Pill tone="amber">Twice</Pill>}</span>
                  </td>
                  <td className={cn(T_CELL, 'text-right')}><PriceButton cardId={cardId} rule={c.rule} name={c.label} /></td>
                </tr>
              ))}
              {g.missing.map((t) => (
                <tr key={t}>
                  <td className={cn(T_CELL, 'text-ink-muted')}>{RULE_LABEL[t]}</td>
                  <td className={cn(T_CELL, 'text-right')}><AddPriceCell cardId={cardId} rule={{ ruleType: t }} label={RULE_LABEL[t]} /></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
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
