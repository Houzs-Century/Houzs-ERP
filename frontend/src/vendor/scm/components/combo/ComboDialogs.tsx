// The dialogs of the combo screen. Each write shows its failure and keeps the dialog
// open, so nothing typed is lost.

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildComboLabel, comboSlotsKey, fmtDate, type SofaPriceTier } from '@2990s/shared';
import { DateField } from '../DateField';
import { useNotify } from '../NotifyDialog';
import { SearchableSelect } from '../SearchableSelect';
import styles from './ComboScreen.module.css';
import { errText } from './comboErrors';
import {
  COMBO_PRESETS, comboKey, costAt, familyMatches, fitSlots, hasPrice, MODULE_GROUPS, moduleFamilies, modulesBrief, presetSlots, tierLabel,
  type ComboLine,
} from './comboBook';
import { combosFileName, comboSheets, downloadComboWorkbook, planComboImport, readComboFile, type ComboImportPlan } from './comboExcel';
import {
  useApplyCombos, useComboAssignTargets, useRecomposeCombos, useRetireCombos, type ApplyComboItem,
} from '../../lib/sofa-combos-queries';

export const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: 40, padding: '0 11px', fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-13)', color: 'var(--c-ink)', background: 'var(--c-cream)',
  border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-sm)', outline: 'none',
};
const tickRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, minHeight: 46, padding: '4px 12px', marginBottom: 6,
  border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
};
const noteText: CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-soft)' };
const fieldLabel: CSSProperties = { fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--fg-soft)', marginBottom: 4 };

export function Dialog({ title, subtitle, width, onClose, footer, children }: {
  title: string; subtitle: string | null; width: number; onClose: () => void; footer: ReactNode; children: ReactNode;
}) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: width, background: 'var(--c-cream)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '16px 20px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--fs-18)' }}>{title}</h3>
            {subtitle && <div style={{ ...noteText, marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} style={{ width: 44, height: 44, marginTop: -8, marginRight: -10, border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--fg-soft)' }}>
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div style={{ padding: '16px 20px' }}>{children}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 10, padding: '12px 20px', background: 'var(--c-paper)' }}>{footer}</div>
      </div>
    </div>
  );
}

// ─── New combo ─────────────────────────────────────────────────────────

const PRESET = 'preset';
const BY_HAND = 'by-hand';

type Candidate = { key: string; name: string; label?: string; note: string; modules: string[][]; blocked: string | null };

export function NewComboDialog({ model, lines, sourceBook, ownModules, supplierId, today, onHand, onClose }: {
  model: string;
  lines: readonly ComboLine[];
  /** Combos to copy from, by model. */
  sourceBook: ReadonlyMap<string, ComboLine[]>;
  ownModules: readonly string[];
  supplierId: string | null;
  today: string;
  onHand: () => void;
  onClose: () => void;
}) {
  const notify = useNotify();
  const apply = useApplyCombos();
  const [source, setSource] = useState(PRESET);
  const [query, setQuery] = useState('');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});

  const have = useMemo(() => new Set(lines.map((l) => comboSlotsKey(l.modules))), [lines]);
  const fit = (name: string, note: string, slots: readonly (readonly string[])[]): Candidate => {
    const { modules, missing } = fitSlots(slots, ownModules);
    let blocked: string | null = null;
    if (missing.length > 0) blocked = `No ${missing.join(', ')} on this model`;
    else if (have.has(comboSlotsKey(modules))) blocked = 'Already here';
    return { key: name, name, note, modules, blocked };
  };
  const candidates = source === PRESET
    ? COMBO_PRESETS.map((p) => fit(p.name, p.pieces, presetSlots(p.pieces, ownModules)))
    : (sourceBook.get(source) ?? []).map((l) => ({ ...fit(l.name, modulesBrief(l.modules), l.modules), label: l.label }));
  const shown = candidates.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  const chosen = candidates.filter((c) => !c.blocked && ticked[c.key]);

  const options = [
    { value: PRESET, label: 'Preset' },
    { value: BY_HAND, label: 'Build by hand' },
    // A supplier starts from the master combos of the very model it is pricing.
    ...[...sourceBook.keys()].filter((m) => supplierId !== null || m !== model).sort().map((m) => ({ value: m, label: `Copy from model: ${m}` })),
  ];

  const add = async () => {
    if (chosen.length === 0) { void notify({ title: 'Tick at least one combo.', tone: 'error' }); return; }
    const items: ApplyComboItem[] = chosen.map((c) => ({
      baseModel: model, modules: c.modules, tier: 'PRICE_1', supplierId, prices: {}, effectiveFrom: today,
      label: c.label ?? buildComboLabel(c.modules),
    }));
    try {
      await apply.mutateAsync(items);
      onClose();
    } catch (e) {
      void notify({ title: "Couldn't add these combos", body: errText(e), tone: 'error' });
    }
  };

  return (
    <Dialog
      title={`New combo for ${model}`}
      subtitle="Copy from a preset or another model, or build it by hand. Prices stay empty."
      width={680}
      onClose={onClose}
      footer={(
        <>
          <span style={{ ...noteText, flex: '1 1 160px' }}>{chosen.length} {chosen.length === 1 ? 'combo' : 'combos'} selected</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void add(); }} disabled={apply.isPending}>Add combos</Button>
        </>
      )}
    >
      <div style={fieldLabel}>Start from</div>
      <SearchableSelect
        className={styles.field}
        ariaLabel="Start from"
        value=""
        placeholder={options.find((o) => o.value === source)?.label ?? 'Preset'}
        options={options}
        onChange={(v) => {
          if (!v) return;
          if (v === BY_HAND) { onHand(); return; }
          setSource(v);
          setTicked({});
          setQuery('');
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search combos" aria-label="Search combos" style={{ ...fieldStyle, flex: 1, minWidth: 0 }} />
        <Button variant="secondary" onClick={() => setTicked({ ...ticked, ...Object.fromEntries(shown.filter((c) => !c.blocked).map((c) => [c.key, true])) })}>Select all</Button>
      </div>
      <div style={{ marginTop: 10, maxHeight: 320, overflowY: 'auto' }}>
        {shown.map((c) => (
          <label key={c.key} style={{ ...tickRow, opacity: c.blocked ? 0.6 : 1, cursor: c.blocked ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={!c.blocked && !!ticked[c.key]}
              disabled={!!c.blocked}
              onChange={() => setTicked({ ...ticked, [c.key]: !ticked[c.key] })}
              style={{ width: 18, height: 18 }}
            />
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{c.name}</span>
            <span style={noteText}>{c.blocked ?? c.note}</span>
          </label>
        ))}
        {shown.length === 0 && <p style={noteText}>This model has no combos to copy.</p>}
      </div>
    </Dialog>
  );
}

// ─── Compartments ──────────────────────────────────────────────────────

function ModulePicker({ codes, names, picked, onToggle }: {
  codes: readonly string[]; names: Readonly<Record<string, string>>; picked: readonly string[]; onToggle: (code: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('All');
  const families = useMemo(() => moduleFamilies(codes), [codes]);
  const shown = families.filter((f) => (group === 'All' || f.group === group) && familyMatches(f, query, names));

  return (
    <div style={{ paddingBottom: 12 }}>
      {picked.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 84, overflowY: 'auto', marginBottom: 8 }}>
          {picked.map((code) => (
            <button key={code} type="button" aria-label={`Remove ${code}`} onClick={() => onToggle(code)} style={{ minHeight: 32, padding: '0 10px', border: 0, borderRadius: 'var(--radius-sm)', background: 'var(--c-primary, #0f6b5c)', color: '#fff', fontSize: 'var(--fs-12)', fontWeight: 600, cursor: 'pointer' }}>
              {code} x
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 8 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${codes.length} modules by code or name`} aria-label="Search modules" style={fieldStyle} />
        <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Module type" style={fieldStyle}>
          <option value="All">All types</option>
          {MODULE_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      <div style={{ maxHeight: 214, overflowY: 'auto', marginTop: 8, border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
        {shown.map((f) => (
          <div key={f.code} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '3px 10px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{f.code}</span>
            {f.variants.map((v) => {
              const on = picked.includes(v.code);
              return (
                <button key={v.code} type="button" aria-pressed={on} aria-label={v.code} onClick={() => onToggle(v.code)} style={{ minHeight: 36, minWidth: 54, padding: '0 10px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-12)', fontWeight: 600, cursor: 'pointer', border: `1px solid ${on ? 'var(--c-primary, #0f6b5c)' : 'var(--line-strong)'}`, background: on ? 'var(--c-primary, #0f6b5c)' : 'var(--c-cream)', color: on ? '#fff' : 'var(--c-ink)' }}>
                  {v.label}
                </button>
              );
            })}
          </div>
        ))}
        {shown.length === 0 && <p style={{ ...noteText, padding: 10, margin: 0 }}>No module matches.</p>}
      </div>
    </div>
  );
}

const compartmentNote = (editing: boolean, onSupplier: boolean, today: string): string => {
  if (!editing) return 'Prices stay empty until you fill them in.';
  if (onSupplier) return `Only this supplier changes, from ${fmtDate(today)}. It will no longer match the Products combo.`;
  return `Prices stay. The new compartments apply from ${fmtDate(today)}, on every supplier that has this combo.`;
};

export function CompartmentDialog({ model, editing, codes, names, supplierId, today, onClose }: {
  model: string;
  /** null = a new combo built by hand. */
  editing: ComboLine | null;
  codes: readonly string[];
  /** Module code to its name, for the search. */
  names: Readonly<Record<string, string>>;
  supplierId: string | null;
  today: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const apply = useApplyCombos();
  const recompose = useRecomposeCombos();
  const [slots, setSlots] = useState<string[][]>(() => (editing ? editing.modules.map((s) => [...s]) : [[]]));
  const [active, setActive] = useState(0);
  const [label, setLabel] = useState(editing?.label ?? '');
  const [notes, setNotes] = useState('');

  const toggle = (index: number, code: string) =>
    setSlots((cur) => cur.map((slot, i) => {
      if (i !== index) return slot;
      return slot.includes(code) ? slot.filter((c) => c !== code) : [...slot, code];
    }));

  const save = async () => {
    const modules = slots.filter((s) => s.length > 0);
    if (modules.length === 0) { void notify({ title: 'Pick at least one module.', tone: 'error' }); return; }
    try {
      if (editing) {
        const same = comboKey(model, modules) === editing.key && (label || null) === editing.label && !notes;
        if (!same) await recompose.mutateAsync([{ baseModel: model, from: editing.modules, to: modules, supplierId, label: label || null, notes: notes || null }]);
      } else {
        await apply.mutateAsync([{ baseModel: model, modules, tier: 'PRICE_1', supplierId, prices: {}, effectiveFrom: today, label: label || null, notes: notes || null }]);
      }
      onClose();
    } catch (e) {
      void notify({ title: "Couldn't save this combo", body: errText(e), tone: 'error' });
    }
  };

  return (
    <Dialog
      title={editing ? 'Edit compartments' : 'New combo'}
      subtitle={`${model}. A built sofa matches when each piece fills one slot.`}
      width={680}
      onClose={onClose}
      footer={(
        <>
          <span style={{ ...noteText, flex: '1 1 200px' }}>
            {compartmentNote(editing !== null, supplierId !== null, today)}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={apply.isPending || recompose.isPending}>{editing ? 'Save compartments' : 'Create combo'}</Button>
        </>
      )}
    >
      {slots.map((slot, i) => (
        <div key={i} style={{ border: `1px solid ${i === active ? 'var(--c-primary, #0f6b5c)' : 'var(--line)'}`, borderRadius: 'var(--radius-sm)', padding: '0 12px', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={() => setActive(i)} style={{ flex: 1, minWidth: 0, minHeight: 44, padding: 0, border: 0, background: 'transparent', textAlign: 'left', fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--c-ink)', cursor: 'pointer' }}>
              Slot {i + 1}: {slot.length > 2 ? `${slot.length} modules` : slot.join(' or ') || 'Pick a module'}
            </button>
            <button
              type="button"
              aria-label={`Remove slot ${i + 1}`}
              onClick={() => { setSlots((cur) => cur.filter((_, k) => k !== i)); setActive(0); }}
              style={{ minHeight: 44, minWidth: 44, border: 0, background: 'transparent', color: 'var(--c-festive-b, #8f2c1a)', fontSize: 'var(--fs-12)', fontWeight: 600, cursor: 'pointer' }}
            >
              Remove
            </button>
          </div>
          {i === active && <ModulePicker codes={codes} names={names} picked={slot} onToggle={(code) => toggle(i, code)} />}
        </div>
      ))}
      <button
        type="button"
        onClick={() => { setSlots((cur) => [...cur, []]); setActive(slots.length); }}
        style={{ width: '100%', minHeight: 44, border: '1px dashed var(--line-strong)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--c-primary, #0f6b5c)', fontWeight: 600, cursor: 'pointer' }}
      >
        Add a slot
      </button>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 14 }}>
        <label><div style={fieldLabel}>Label (optional)</div><input value={label} onChange={(e) => setLabel(e.target.value)} style={fieldStyle} /></label>
        <label><div style={fieldLabel}>Notes (optional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} style={fieldStyle} /></label>
      </div>
    </Dialog>
  );
}

// ─── Assign to supplier ────────────────────────────────────────────────

export function AssignDialog({ model, chosen, today, onDone, onClose }: {
  model: string; chosen: readonly ComboLine[]; today: string; onDone: (text: string) => void; onClose: () => void;
}) {
  const notify = useNotify();
  const apply = useApplyCombos();
  const targetsQ = useComboAssignTargets(model);
  const [query, setQuery] = useState('');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});

  const rows = (targetsQ.data ?? [])
    .filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
    .map((s) => {
      const held = new Set(s.held);
      const fresh = chosen.filter((l) => !held.has(comboSlotsKey(l.modules)));
      let note = `${fresh.length} new`;
      if (!s.linked) note = 'Does not supply this model';
      else if (fresh.length === 0) note = 'Already has these';
      return { ...s, fresh, note, off: !s.linked || fresh.length === 0 };
    })
    .sort((a, b) => Number(a.off) - Number(b.off));

  const assign = async () => {
    const picked = rows.filter((r) => !r.off && ticked[r.id]);
    if (picked.length === 0) { void notify({ title: 'Pick a supplier.', tone: 'error' }); return; }
    const items: ApplyComboItem[] = picked.flatMap((r) => r.fresh.map((l) => ({
      baseModel: model, modules: l.modules, tier: 'PRICE_1' as const, supplierId: r.id, prices: {}, effectiveFrom: today, label: l.label,
    })));
    try {
      await apply.mutateAsync(items);
      const n = chosen.length;
      onDone(`${n} ${n === 1 ? 'combo' : 'combos'} assigned to ${picked.map((r) => r.name).join(', ')}. Set the prices on the supplier page.`);
    } catch (e) {
      void notify({ title: "Couldn't assign these combos", body: errText(e), tone: 'error' });
    }
  };

  return (
    <Dialog
      title={`Assign ${chosen.length} ${chosen.length === 1 ? 'combo' : 'combos'} to supplier`}
      subtitle={`${model}: ${chosen.map((l) => l.name).join(', ')}`}
      width={620}
      onClose={onClose}
      footer={(
        <>
          <span style={{ ...noteText, flex: '1 1 200px' }}>Only the combo goes across. The supplier page shows it with no price.</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void assign(); }} disabled={apply.isPending}>Assign</Button>
        </>
      )}
    >
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search supplier" aria-label="Search supplier" style={fieldStyle} />
      <div style={{ marginTop: 10, maxHeight: 320, overflowY: 'auto' }}>
        {targetsQ.isLoading && <p style={noteText}>Loading suppliers...</p>}
        {targetsQ.isError && <p style={{ ...noteText, color: 'var(--c-festive-b, #8f2c1a)' }}>Couldn't load the suppliers. {errText(targetsQ.error)}</p>}
        {rows.map((r) => (
          <label key={r.id} style={{ ...tickRow, opacity: r.off ? 0.55 : 1, cursor: r.off ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={!r.off && !!ticked[r.id]} disabled={r.off} onChange={() => setTicked({ ...ticked, [r.id]: !ticked[r.id] })} style={{ width: 18, height: 18 }} />
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{r.name}</span>
            <span style={noteText}>{r.note}</span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

// ─── Delete ────────────────────────────────────────────────────────────

export function DeleteDialog({ chosen, supplierId, onDone, onClose }: {
  chosen: readonly ComboLine[]; supplierId: string | null; onDone: (text: string) => void; onClose: () => void;
}) {
  const notify = useNotify();
  const retire = useRetireCombos();
  const n = chosen.length;
  const run = async () => {
    try {
      await retire.mutateAsync({ items: chosen.map((l) => ({ baseModel: l.baseModel, modules: l.modules })), supplierId });
      onDone(`${n} ${n === 1 ? 'combo' : 'combos'} deleted.`);
    } catch (e) {
      void notify({ title: "Couldn't delete these combos", body: errText(e), tone: 'error' });
    }
  };
  return (
    <Dialog
      title={`Delete ${n} ${n === 1 ? 'combo' : 'combos'}?`}
      subtitle={null}
      width={480}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void run(); }} disabled={retire.isPending} style={{ background: 'var(--c-festive-b, #8f2c1a)', borderColor: 'var(--c-festive-b, #8f2c1a)' }}>Delete</Button>
        </>
      )}
    >
      <div style={{ fontWeight: 600 }}>{chosen.map((l) => l.name).join(', ')}</div>
      <p style={{ margin: '8px 0 0' }}>
        {supplierId ? 'Only this supplier loses these combos.' : 'They also go from every supplier that has them.'}
        {' '}New orders can no longer pick them. Orders already made keep their price, and the history stays.
      </p>
    </Dialog>
  );
}

// ─── Adjust by % ───────────────────────────────────────────────────────

export function AdjustDialog({ chosen, tier, supplierId, today, onDone, onClose }: {
  chosen: readonly ComboLine[]; tier: SofaPriceTier; supplierId: string | null; today: string; onDone: (text: string) => void; onClose: () => void;
}) {
  const notify = useNotify();
  const apply = useApplyCombos();
  const [percent, setPercent] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today);

  const run = async () => {
    const pct = Number(percent);
    if (percent.trim() === '' || !Number.isFinite(pct) || pct <= -100) { void notify({ title: 'Type a percentage, for example 5 or -3.', tone: 'error' }); return; }
    const items = chosen.flatMap((line): ApplyComboItem[] => {
      const rule = line.byTier[tier];
      if (!rule) return [];
      const prices: ApplyComboItem['prices'] = {};
      for (const h of Object.keys(rule.pricesByHeight)) {
        const sen = costAt(line, tier, h);
        if (sen !== null) prices[h] = Math.round(sen * (1 + pct / 100));
      }
      return Object.keys(prices).length > 0 ? [{ baseModel: line.baseModel, modules: line.modules, tier, supplierId, prices, effectiveFrom }] : [];
    });
    if (items.length === 0) { void notify({ title: `None of these combos has a price at ${tierLabel(tier)}.`, tone: 'error' }); return; }
    try {
      await apply.mutateAsync(items);
      onDone(`${items.length} ${items.length === 1 ? 'combo' : 'combos'} adjusted at ${tierLabel(tier)}.`);
    } catch (e) {
      void notify({ title: "Couldn't adjust these prices", body: errText(e), tone: 'error' });
    }
  };

  return (
    <Dialog
      title={`Adjust ${tierLabel(tier)} by %`}
      subtitle={chosen.map((l) => l.name).join(', ')}
      width={480}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void run(); }} disabled={apply.isPending}>Adjust</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <label><div style={fieldLabel}>Change by %</div><input value={percent} inputMode="decimal" onChange={(e) => setPercent(e.target.value)} style={fieldStyle} /></label>
        <div><div style={fieldLabel}>Effective from</div><DateField value={effectiveFrom} onChange={setEffectiveFrom} fullWidth aria-label="Effective from" /></div>
      </div>
    </Dialog>
  );
}

// ─── Export ────────────────────────────────────────────────────────────

export function ExportDialog({ model, book, supplierName, sizesOf, today, onClose }: {
  model: string | null;
  book: ReadonlyMap<string, ComboLine[]>;
  supplierName: string | null;
  sizesOf: (model: string) => readonly string[];
  today: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const all = [...book.values()].flat();
  const scopes = [
    { label: 'No price yet', note: 'Only what needs filling', lines: all.filter((l) => !hasPrice(l)) },
    { label: 'All combos', note: `${all.length} combos`, lines: all },
    ...(model ? [{ label: 'This model only', note: model, lines: book.get(model) ?? [] }] : []),
  ];
  const [picked, setPicked] = useState(0);
  const scope = scopes[Math.min(picked, scopes.length - 1)] as (typeof scopes)[number];

  const download = async () => {
    if (scope.lines.length === 0) { void notify({ title: 'There are no combos to export here.', tone: 'error' }); return; }
    try {
      await downloadComboWorkbook(comboSheets(scope.lines, supplierName, sizesOf), combosFileName(supplierName ?? 'Products', today));
      onClose();
    } catch (e) {
      void notify({ title: "Couldn't build the file", body: errText(e), tone: 'error' });
    }
  };

  return (
    <Dialog
      title="Export combos"
      subtitle="One sheet each for Price 1 to Price 4, plus Modules"
      width={520}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void download(); }}>Download</Button>
        </>
      )}
    >
      {scopes.map((s, i) => (
        <label key={s.label} style={tickRow}>
          <input type="radio" name="combo-export" checked={picked === i} onChange={() => setPicked(i)} style={{ width: 18, height: 18 }} />
          <span style={{ flex: 1, fontWeight: 600 }}>{s.label}</span>
          <span style={noteText}>{s.note}</span>
        </label>
      ))}
    </Dialog>
  );
}

// ─── Import ────────────────────────────────────────────────────────────

const PREVIEW_ROWS = 200;

export function ImportDialog({ lines, modulesByModel, sizes, supplierId, supplierName, today, onDone, onClose }: {
  lines: readonly ComboLine[];
  sizes: readonly string[];
  modulesByModel: Partial<Record<string, readonly string[]>>;
  supplierId: string | null;
  supplierName: string | null;
  today: string;
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const notify = useNotify();
  const apply = useApplyCombos();
  const retire = useRetireCombos();
  const recompose = useRecomposeCombos();
  const input = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ComboImportPlan | null>(null);
  const busy = apply.isPending || retire.isPending || recompose.isPending;

  const onFile = async (file: File) => {
    try {
      const grids = await readComboFile(file);
      const next = planComboImport(grids, { lines, modulesByModel, sizes, supplierId, supplierName, today });
      setPlan(next);
    } catch (e) {
      void notify({ title: "Couldn't read this file", body: errText(e), tone: 'error' });
    }
  };

  const confirm = async () => {
    if (!plan) return;
    try {
      if (plan.retire.length > 0) await retire.mutateAsync({ items: plan.retire, supplierId });
      if (plan.recompose.length > 0) await recompose.mutateAsync(plan.recompose.map((m) => ({ ...m, supplierId })));
      if (plan.apply.length > 0) await apply.mutateAsync(plan.apply);
      const n = plan.changes.length;
      onDone(`${n} ${n === 1 ? 'change' : 'changes'} imported.`);
    } catch (e) {
      void notify({ title: 'The import stopped partway', body: `${errText(e)} Export again to see what went in.`, tone: 'error' });
    }
  };

  const count = plan?.changes.length ?? 0;
  return (
    <Dialog
      title="Import combos"
      subtitle="Nothing is saved until you confirm."
      width={760}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void confirm(); }} disabled={busy || count === 0}>Confirm {count} {count === 1 ? 'change' : 'changes'}</Button>
        </>
      )}
    >
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        aria-label="Combo Excel file"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
        style={fieldStyle}
      />
      {plan && count === 0 && plan.refused.length === 0 && <p style={noteText}>This file changes nothing.</p>}
      {plan && plan.refused.length > 0 && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--c-festive-b-bg, var(--hz-dk-err-bg, #f7e9e9))', color: 'var(--c-festive-b, #8f2c1a)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontWeight: 600 }}>{plan.refused.length} refused. The rest can still go in.</div>
          {plan.refused.slice(0, 20).map((r) => <div key={r}>{r}</div>)}
          {plan.refused.length > 20 && <div>And {plan.refused.length - 20} more.</div>}
        </div>
      )}
      {count > 0 && (
        <div style={{ marginTop: 12, maxHeight: 340, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
          <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
            <thead>
              <tr style={{ background: 'var(--c-paper)', textAlign: 'left' }}>
                {['Change', 'Where', 'Before', 'After'].map((h) => <th key={h} style={{ padding: '8px 10px' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {plan?.changes.slice(0, PREVIEW_ROWS).map((c, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px 10px', fontWeight: 600 }}>{c.kind}</td>
                  <td style={{ padding: '8px 10px' }}>{c.where}</td>
                  <td style={{ padding: '8px 10px' }}>{c.before}</td>
                  <td style={{ padding: '8px 10px', fontWeight: 600 }}>{c.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {count > PREVIEW_ROWS && <p style={{ ...noteText, padding: '0 10px' }}>Showing the first {PREVIEW_ROWS} of {count}.</p>}
        </div>
      )}
    </Dialog>
  );
}
