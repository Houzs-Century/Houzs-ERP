// Presets: the list New combo starts from (Products > Combo Pricing > Presets).
// Add, rename, change compartments, switch on or off, and order; nothing is
// deleted. Each write shows its failure (combo-presets-queries) and an editor
// stays open when its save fails, so nothing typed is lost.

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { SOFA_MODULES } from '@2990s/shared';
import { downloadCSV, toCSV } from '../../../../lib/csv';
import { todayMyt } from '../../lib/dates';
import {
  useComboPresets, useCreateComboPreset, useReorderComboPresets, useUpdateComboPreset, type ComboPreset,
} from '../../lib/combo-presets-queries';
import { Dialog, fieldLabel, fieldStyle, ModulePicker, noteText } from './ComboDialogs';
import { presetModuleCodes, presetPieces } from './comboBook';
import { errText } from './comboErrors';

const PRESET_CODES = presetModuleCodes(SOFA_MODULES.map((m) => m.id));
const MODULE_NAMES: Record<string, string> = Object.fromEntries(SOFA_MODULES.map((m) => [m.id, m.label]));
const RED = 'var(--c-festive-b, #8f2c1a)';

/** The preset list as a CSV file, in order. */
export const presetsCsv = (presets: readonly ComboPreset[]): string =>
  toCSV([...presets], [
    { key: 'order', label: 'Order', getValue: (p) => p.sortOrder + 1 },
    { key: 'name', label: 'Name', getValue: (p) => p.name },
    { key: 'slots', label: 'Compartments', getValue: (p) => presetPieces(p.slots) },
    { key: 'active', label: 'Active', getValue: (p) => (p.active ? 'Yes' : 'No') },
  ]);

export function PresetsDialog({ onClose }: { onClose: () => void }) {
  const presetsQ = useComboPresets();
  const update = useUpdateComboPreset();
  const reorder = useReorderComboPresets();
  const [editing, setEditing] = useState<ComboPreset | 'new' | null>(null);
  const presets = presetsQ.data ?? [];

  if (editing !== null) {
    return <PresetEditor editing={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }

  const move = (index: number, by: -1 | 1) => {
    const ids = presets.map((p) => p.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    reorder.mutate(ids);
  };

  return (
    <Dialog
      title="Presets"
      subtitle="New combo offers the active presets, in this order. A module with no side fits either side on the model."
      width={720}
      onClose={onClose}
      footer={(
        <>
          <Button variant="secondary" onClick={() => downloadCSV(`combo-presets-${todayMyt()}.csv`, presetsCsv(presets))} disabled={presets.length === 0}>Export CSV</Button>
          <span style={{ flex: '1 1 40px' }} />
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => setEditing('new')}>Add preset</Button>
        </>
      )}
    >
      {presetsQ.isPending && <p style={noteText}>Loading the presets...</p>}
      {presetsQ.isError && <p style={{ ...noteText, color: RED }}>Couldn't load the presets. {errText(presetsQ.error)}</p>}
      {presetsQ.isSuccess && presets.length === 0 && <p style={noteText}>No presets yet. Add the first one.</p>}
      {presets.map((p, i) => (
        <div key={p.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px', marginBottom: 6, border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', opacity: p.active ? 1 : 0.6 }}>
          <div style={{ display: 'flex', gap: 2 }}>
            <Button variant="ghost" aria-label={`Move ${p.name} up`} onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending}>Up</Button>
            <Button variant="ghost" aria-label={`Move ${p.name} down`} onClick={() => move(i, 1)} disabled={i === presets.length - 1 || reorder.isPending}>Down</Button>
          </div>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{i + 1}. {p.name}</div>
            <div style={noteText}>{presetPieces(p.slots)}</div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={p.active}
              aria-label={`${p.name} active`}
              disabled={update.isPending}
              onChange={() => update.mutate({ id: p.id, active: !p.active })}
              style={{ width: 18, height: 18 }}
            />
            Active
          </label>
          <Button variant="secondary" onClick={() => setEditing(p)}>Edit</Button>
        </div>
      ))}
    </Dialog>
  );
}

function PresetEditor({ editing, onDone }: { editing: ComboPreset | null; onDone: () => void }) {
  const create = useCreateComboPreset();
  const update = useUpdateComboPreset();
  const [name, setName] = useState(editing?.name ?? '');
  const [slots, setSlots] = useState<string[][]>(() => (editing ? editing.slots.map((s) => [...s]) : [[]]));
  const [active, setActive] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = (index: number, code: string) =>
    setSlots((cur) => cur.map((slot, i) => {
      if (i !== index) return slot;
      return slot.includes(code) ? slot.filter((c) => c !== code) : [...slot, code];
    }));

  const save = async () => {
    const kept = slots.filter((s) => s.length > 0);
    if (!name.trim()) { setProblem('Give the preset a name.'); return; }
    if (kept.length === 0) { setProblem('Pick at least one module.'); return; }
    setProblem(null);
    try {
      if (editing) await update.mutateAsync({ id: editing.id, name: name.trim(), slots: kept });
      else await create.mutateAsync({ name: name.trim(), slots: kept });
      onDone();
    } catch {
      // The failure is already on screen (writeFailedAs); the editor stays open.
    }
  };

  return (
    <Dialog
      title={editing ? `Edit preset: ${editing.name}` : 'New preset'}
      subtitle="A combo matches when each piece fills one slot. Either side fits LHF or RHF, whichever the model makes."
      width={680}
      onClose={onDone}
      footer={(
        <>
          {problem && <span style={{ ...noteText, flex: '1 1 160px', color: RED }}>{problem}</span>}
          <Button variant="ghost" onClick={onDone}>Back</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={create.isPending || update.isPending}>{editing ? 'Save preset' : 'Add preset'}</Button>
        </>
      )}
    >
      <label style={{ display: 'block', marginBottom: 12 }}>
        <div style={fieldLabel}>Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Preset name" maxLength={60} style={fieldStyle} />
      </label>
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
              style={{ minHeight: 44, minWidth: 44, border: 0, background: 'transparent', color: RED, fontSize: 'var(--fs-12)', fontWeight: 600, cursor: 'pointer' }}
            >
              Remove
            </button>
          </div>
          {i === active && <ModulePicker codes={PRESET_CODES} names={MODULE_NAMES} picked={slot} plainLabel="Either side" onToggle={(code) => toggle(i, code)} />}
        </div>
      ))}
      <button
        type="button"
        onClick={() => { setSlots((cur) => [...cur, []]); setActive(slots.length); }}
        style={{ width: '100%', minHeight: 44, border: '1px dashed var(--line-strong)', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--c-primary, #0f6b5c)', fontWeight: 600, cursor: 'pointer' }}
      >
        Add a slot
      </button>
    </Dialog>
  );
}
