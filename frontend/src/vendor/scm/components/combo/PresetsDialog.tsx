// Combos: the list New combo starts from (Products > Combo Pricing > Combos).
// The code says "preset", the screen says "combo" (owner 2026-11-17). Add,
// rename, change compartments, switch on or off, delete, and drag to order.
// Each write shows its failure (combo-presets-queries) and an editor stays
// open when its save fails, so nothing typed is lost.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { GripVertical } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { SOFA_MODULES } from '@2990s/shared';
import { downloadCSV, toCSV } from '../../../../lib/csv';
import { todayMyt } from '../../lib/dates';
import {
  useComboPresets, useCreateComboPreset, useDeleteComboPreset, useReorderComboPresets, useUpdateComboPreset, type ComboPreset,
} from '../../lib/combo-presets-queries';
import { useConfirm } from '../ConfirmDialog';
import { Dialog, fieldLabel, fieldStyle, ModulePicker, noteText } from './ComboDialogs';
import { presetModuleCodes, presetPieces } from './comboBook';
import { errText } from './comboErrors';

const PRESET_CODES = presetModuleCodes(SOFA_MODULES.map((m) => m.id));
const MODULE_NAMES: Record<string, string> = Object.fromEntries(SOFA_MODULES.map((m) => [m.id, m.label]));
const RED = 'var(--c-festive-b, #8f2c1a)';
/** About ten module rows in the editor's list. */
const EDITOR_LIST_HEIGHT = 450;

/** The combo list as a CSV file, in order. */
export const presetsCsv = (presets: readonly ComboPreset[]): string =>
  toCSV([...presets], [
    { key: 'order', label: 'Order', getValue: (p) => p.sortOrder + 1 },
    { key: 'name', label: 'Name', getValue: (p) => p.name },
    { key: 'slots', label: 'Compartments', getValue: (p) => presetPieces(p.slots) },
    { key: 'active', label: 'Active', getValue: (p) => (p.active ? 'Yes' : 'No') },
  ]);

/** `ids` with the one at `from` moved to `to`. */
export const moveId = (ids: readonly string[], from: number, to: number): string[] => {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
};

/** Where the dragged row belongs: the index of the row whose middle the pointer passed last. */
export const dropIndex = (middles: readonly number[], pointerY: number, from: number): number => {
  let to = from;
  middles.forEach((mid, i) => {
    if (i < from && pointerY < mid && to === from) to = i;
    if (i > from && pointerY > mid) to = i;
  });
  return to;
};

export function PresetsDialog({ onClose }: { onClose: () => void }) {
  const presetsQ = useComboPresets();
  const update = useUpdateComboPreset();
  const reorder = useReorderComboPresets();
  const remove = useDeleteComboPreset();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ComboPreset | 'new' | null>(null);
  // The order on screen while a drag runs or its save is in flight; null = the server's.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const serverPresets = presetsQ.data;
  const presets = serverPresets ?? [];

  useEffect(() => { setOrder(null); }, [serverPresets]);

  if (editing !== null) {
    return <PresetEditor editing={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />;
  }

  const byId = new Map(presets.map((p) => [p.id, p]));
  const shown = order ? order.map((id) => byId.get(id)).filter((p): p is ComboPreset => !!p) : presets;

  const save = (ids: string[]) => {
    if (ids.join() === presets.map((p) => p.id).join()) { setOrder(null); return; }
    setOrder(ids);
    // The hook shows the failure; the list goes back to the saved order.
    reorder.mutate(ids, { onError: () => setOrder(null) });
  };

  const onHandleKey = (e: KeyboardEvent, index: number) => {
    const by = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (by === 0) return;
    e.preventDefault();
    const to = index + by;
    if (to < 0 || to >= shown.length || reorder.isPending) return;
    save(moveId(shown.map((p) => p.id), index, to));
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (reorder.isPending || e.button > 0) return;
    // Capture keeps the moves coming to the handle once the pointer leaves it.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not every browser (or jsdom) has it */ }
    setDragging(id);
    setOrder(shown.map((p) => p.id));
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (dragging === null || order === null) return;
    const middles = order.map((id) => {
      const box = rowRefs.current.get(id)?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : 0;
    });
    const from = order.indexOf(dragging);
    const to = dropIndex(middles, e.clientY, from);
    if (to !== from) setOrder(moveId(order, from, to));
  };
  const onPointerUp = () => {
    if (dragging === null) return;
    setDragging(null);
    if (order) save(order);
  };

  const askDelete = async (p: ComboPreset) => {
    const ok = await confirm({
      title: `Delete combo '${p.name}'?`,
      body: 'This cannot be undone. Combos already added to a model keep their compartments and prices.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) remove.mutate(p.id);
  };

  return (
    <Dialog
      title="Combos"
      subtitle="New combo offers the active combos, in this order. Drag a combo by its handle to move it. A module with no side fits either side on the model."
      width={720}
      onClose={onClose}
      footer={(
        <>
          <Button variant="secondary" onClick={() => downloadCSV(`combos-${todayMyt()}.csv`, presetsCsv(presets))} disabled={presets.length === 0}>Export CSV</Button>
          <span style={{ flex: '1 1 40px' }} />
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => setEditing('new')}>Add combo</Button>
        </>
      )}
    >
      {presetsQ.isPending && <p style={noteText}>Loading the combos...</p>}
      {presetsQ.isError && <p style={{ ...noteText, color: RED }}>Couldn't load the combos. {errText(presetsQ.error)}</p>}
      {presetsQ.isSuccess && presets.length === 0 && <p style={noteText}>No combos yet. Add the first one.</p>}
      {shown.map((p, i) => (
        <div
          key={p.id}
          ref={(el) => { if (el) rowRefs.current.set(p.id, el); else rowRefs.current.delete(p.id); }}
          style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px 6px 4px', marginBottom: 6,
            border: `1px solid ${dragging === p.id ? 'var(--c-primary, #0f6b5c)' : 'var(--line)'}`, borderRadius: 'var(--radius-sm)',
            background: dragging === p.id ? 'var(--c-paper)' : 'transparent', opacity: p.active ? 1 : 0.6,
          }}
        >
          <button
            type="button"
            aria-label={`Move ${p.name}. Drag, or use the up and down arrow keys.`}
            title="Drag to move"
            disabled={reorder.isPending}
            onKeyDown={(e) => onHandleKey(e, i)}
            onPointerDown={(e) => onPointerDown(e, p.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{ width: 36, minHeight: 44, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--fg-soft)', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
          >
            <GripVertical size={18} strokeWidth={1.75} />
          </button>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{p.name}</div>
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
          <Button variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => { void askDelete(p); }} disabled={remove.isPending} style={{ color: RED }}>Delete</Button>
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
    if (!name.trim()) { setProblem('Give the combo a name.'); return; }
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
      title={editing ? `Edit combo: ${editing.name}` : 'New combo'}
      subtitle="A combo matches when each piece fills one slot. Either side fits LHF or RHF, whichever the model makes."
      width={920}
      onClose={onDone}
      footer={(
        <>
          {problem && <span style={{ ...noteText, flex: '1 1 160px', color: RED }}>{problem}</span>}
          <Button variant="ghost" onClick={onDone}>Back</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={create.isPending || update.isPending}>{editing ? 'Save combo' : 'Add combo'}</Button>
        </>
      )}
    >
      <label style={{ display: 'block', marginBottom: 12 }}>
        <div style={fieldLabel}>Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Combo name" maxLength={60} style={fieldStyle} />
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
          {i === active && <ModulePicker codes={PRESET_CODES} names={MODULE_NAMES} picked={slot} plainLabel="Either side" listHeight={EDITOR_LIST_HEIGHT} onToggle={(code) => toggle(i, code)} />}
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
