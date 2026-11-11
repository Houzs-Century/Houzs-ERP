// Add or edit one zone rule, with the live effect on the map shown before saving:
// which postcodes the rule covers and which ones change zone because of it.
import { useState } from 'react';
import { ResizableDrawer } from '../../../components/ResizableDrawer';
import { cn } from '../../../lib/utils';
import { useConfirm } from '../../../vendor/scm/components/ConfirmDialog';
import { writeFailed, writeFailedAs } from '../../../vendor/scm/lib/mutation-error';
import {
  useCreateZoneRule, useDeleteZoneRule, useUpdateZoneRule, type ZoneRuleRow,
} from '../../../vendor/scm/lib/delivery-zones-queries';
import {
  coverageChanges, effectiveMap, pad2, tiedPrefixes, withRule, parseRuleForm, rangeText, zoneByPrefix, zoneColour, zoneName,
  type RuleForm, type ZoneRange,
} from './zoneModel';

export type DrawerTarget = { kind: 'new'; initial: RuleForm } | { kind: 'edit'; rule: ZoneRuleRow };

const inputCls = 'min-h-[40px] w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink';
const labelCls = 'flex flex-col gap-1 text-[11.5px] font-semibold text-ink-muted';

export function ZoneRuleDrawer({ target, rules, defaultMap, knownZones, onClose }: {
  target: DrawerTarget;
  rules: ZoneRuleRow[];
  defaultMap: ZoneRange[];
  knownZones: string[];
  onClose: () => void;
}) {
  const editing = target.kind === 'edit' ? target.rule : null;
  const [form, setForm] = useState<RuleForm>(() => editing
    ? { zone: editing.zone, from: pad2(editing.prefixStart), to: pad2(editing.prefixEnd), label: editing.label ?? '' }
    : target.kind === 'new' ? target.initial : { zone: '', from: '', to: '', label: '' });
  const [active, setActive] = useState(editing ? editing.isActive : true);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const create = useCreateZoneRule();
  const update = useUpdateZoneRule();
  const del = useDeleteZoneRule();
  const askConfirm = useConfirm();
  const set = (k: keyof RuleForm, v: string) => { setForm((f) => ({ ...f, [k]: v })); setError(null); };

  const parsed = parseRuleForm(form);
  const zones = editing && !knownZones.includes(editing.zone) ? [editing.zone, ...knownZones] : knownZones;

  const preview = (() => {
    if (!parsed.ok) return null;
    const v = parsed.value;
    const changes = coverageChanges(rules, defaultMap, { ...v, isActive: active }, editing?.id ?? null);
    const after = zoneByPrefix(effectiveMap(withRule(rules, { ...v, isActive: active }, editing?.id ?? null), defaultMap).map);
    const ties = active ? tiedPrefixes(rules, v, editing?.id ?? null) : [];
    const lost = active ? Array.from({ length: v.prefixEnd - v.prefixStart + 1 }, (_, i) => v.prefixStart + i).filter((p) => after[p] !== v.zone && !ties.includes(p)) : [];
    const switchesOffDefault = active && effectiveMap(rules, defaultMap).usingDefault && changes.some((c) => c.before && !c.after);
    return { v, changes, after, lost, ties, switchesOffDefault };
  })();

  const busy = create.isPending || update.isPending || del.isPending;

  const save = () => {
    if (!parsed.ok) { setError({ field: parsed.field, message: parsed.message }); return; }
    const v = parsed.value;
    if (!editing) {
      create.mutate({ ...v, isActive: active }, { onSuccess: onClose, onError: writeFailedAs('Rule not added') });
      return;
    }
    const patch: Parameters<typeof update.mutate>[0] = { id: editing.id };
    if (v.zone !== editing.zone) patch.zone = v.zone;
    if (v.prefixStart !== editing.prefixStart) patch.prefixStart = v.prefixStart;
    if (v.prefixEnd !== editing.prefixEnd) patch.prefixEnd = v.prefixEnd;
    if (v.label !== (editing.label ?? null)) patch.label = v.label;
    if (active !== editing.isActive) patch.isActive = active;
    if (Object.keys(patch).length === 1) { onClose(); return; }
    update.mutate(patch, { onSuccess: onClose, onError: writeFailed });
  };

  const remove = async () => {
    if (!editing) return;
    if (!(await askConfirm({
      title: `Delete the rule ${zoneName(editing.zone)} ${rangeText(editing.prefixStart, editing.prefixEnd)}?`,
      body: 'Postcodes in this range go to whichever other rule covers them, or have no zone. You can add the rule again later.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    del.mutate(editing.id, { onSuccess: onClose, onError: writeFailedAs('Rule not deleted') });
  };

  return (
    <ResizableDrawer onClose={onClose} storageKey="delivery-zone-rule-drawer" defaultWidth={520} ariaLabel={editing ? 'Edit zone rule' : 'Add zone rule'}
      title={editing ? 'Edit zone rule' : 'Add zone rule'}
      subtitle={editing ? `${zoneName(editing.zone)} · ${rangeText(editing.prefixStart, editing.prefixEnd)}` : 'A rule sends a range of postcodes to one zone'}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          {editing
            ? <button type="button" onClick={() => void remove()} disabled={busy} className="min-h-[40px] rounded-md border border-[#e3b4b4] px-3 text-[12.5px] font-semibold text-[color:var(--hz-dk-err,#8a2c2c)] disabled:opacity-50">Delete rule</button>
            : <span />}
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className="min-h-[40px] rounded-md border border-border px-3 text-[12.5px] font-semibold text-ink">Cancel</button>
            <button type="button" onClick={save} disabled={busy} className="min-h-[40px] rounded-md bg-primary px-4 text-[12.5px] font-semibold text-white disabled:opacity-50">
              {busy ? 'Saving…' : editing ? 'Save' : 'Add rule'}
            </button>
          </span>
        </div>
      }>
      <div className="space-y-4 p-4">
        <fieldset className="space-y-1.5">
          <legend className="text-[11.5px] font-semibold text-ink-muted">Zone</legend>
          <div className="flex flex-wrap gap-1.5">
            {zones.map((z) => {
              const [bg, fg] = zoneColour(z);
              const on = form.zone === z;
              return (
                <button key={z} type="button" aria-pressed={on} onClick={() => set('zone', z)}
                  className={cn('min-h-[34px] rounded-full px-3 text-[12px] font-semibold', on ? 'ring-2 ring-primary' : '')}
                  style={{ background: bg, color: fg }}>
                  {zoneName(z)}
                </button>
              );
            })}
          </div>
          {error?.field === 'zone' && <p className="text-[12px] text-[color:var(--hz-dk-err,#8a2c2c)]">{error.message}</p>}
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>Prefix from (00–99)
            <input inputMode="numeric" value={form.from} onChange={(e) => set('from', e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="e.g. 43"
              className={cn(inputCls, error?.field === 'from' && 'border-[#c0392b]')} />
          </label>
          <label className={labelCls}>Prefix to (blank = same)
            <input inputMode="numeric" value={form.to} onChange={(e) => set('to', e.target.value.replace(/\D/g, '').slice(0, 2))} placeholder="e.g. 43"
              className={cn(inputCls, error?.field === 'to' && 'border-[#c0392b]')} />
          </label>
        </div>
        {(error?.field === 'from' || error?.field === 'to') && <p className="text-[12px] text-[color:var(--hz-dk-err,#8a2c2c)]">{error.message}</p>}

        <label className={labelCls}>Name
          <input value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Kajang / Semenyih" className={inputCls} maxLength={120} />
        </label>

        <label className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
          <span className="text-[12.5px]"><span className="font-semibold text-ink">In use</span><span className="block text-ink-muted">A turned-off rule stays here but does not decide any zone.</span></span>
          <input type="checkbox" role="switch" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-5 w-5 accent-[#16695f]" aria-label="In use" />
        </label>

        <section className="rounded-xl border border-border bg-surface p-4" aria-live="polite">
          <h3 className="mb-2 text-[13px] font-semibold text-ink">What this rule does</h3>
          {!preview ? (
            <p className="text-[12.5px] text-ink-muted">Enter a prefix to see which postcodes it covers.</p>
          ) : (
            <div className="space-y-3">
              <div className="text-[18px] font-semibold tabular-nums text-ink">{rangeText(preview.v.prefixStart, preview.v.prefixEnd)}</div>
              <div>
                <div className="flex h-5 gap-px overflow-hidden rounded-md">
                  {preview.after.map((z, p) => {
                    const inRange = p >= preview.v.prefixStart && p <= preview.v.prefixEnd;
                    return <span key={p} className="flex-1" style={{ background: inRange ? (active ? 'var(--hz-c-primary)' : '#9fb8b3') : z ? 'var(--hz-c-border)' : 'var(--hz-c-bg)' }} />;
                  })}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-ink-muted"><span>00</span><span>25</span><span>50</span><span>75</span><span>99</span></div>
              </div>
              {preview.changes.length === 0
                ? <p className="text-[12.5px] text-ink-secondary">No postcode changes zone.</p>
                : (
                  <ul className="space-y-1 text-[12.5px]">
                    {preview.changes.slice(0, 8).map((c) => (
                      <li key={c.from} className="flex flex-wrap justify-between gap-2 border-t border-border-subtle pt-1 first:border-t-0 first:pt-0">
                        <span className="tabular-nums text-ink">{rangeText(c.from, c.to)}</span>
                        <span className={c.after ? 'text-ink-secondary' : 'font-semibold text-[color:var(--hz-dk-err,#8a2c2c)]'}>
                          {c.before ? zoneName(c.before) : 'No zone'} to {c.after ? zoneName(c.after) : 'no zone'}
                        </span>
                      </li>
                    ))}
                    {preview.changes.length > 8 && <li className="text-ink-muted">and {preview.changes.length - 8} more ranges</li>}
                  </ul>
                )}
              {preview.switchesOffDefault && (
                <p className="rounded-lg bg-[#f6ecd4] px-3 py-2 text-[12.5px] text-[#80501c]">
                  The built-in map only applies while no rule is in use, so saving this leaves the postcodes above with no zone. Load the default map as editable rules first to keep them.
                </p>
              )}
              {preview.ties.length > 0 && (
                <p className="rounded-lg bg-[#f6ecd4] px-3 py-2 text-[12.5px] text-[#80501c]">
                  {preview.ties.map(pad2).join(', ')} {preview.ties.length === 1 ? 'is' : 'are'} also covered by another zone's rule of the same width, so which zone wins is not certain. Make one of the two ranges narrower.
                </p>
              )}
              {preview.lost.length > 0 && (
                <p className="text-[12px] text-ink-muted">
                  {preview.lost.map(pad2).join(', ')} stay{preview.lost.length === 1 ? 's' : ''} with a narrower rule. When rules overlap, the narrower range wins.
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </ResizableDrawer>
  );
}
