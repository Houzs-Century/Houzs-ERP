
import { useState } from 'react';
import { Button } from '../../components/Button';
import type { LeadCategoryOption } from '../../vendor/scm/lib/mrp-queries';

export type LeadTimeChange = { category: string; leadDays: number | null };

const asStr = (n: number | undefined) => (n === undefined ? '' : String(n));
const parse = (raw: string): number | null => (raw.trim() === '' ? null : Math.max(0, Math.floor(Number(raw) || 0)));

export function LeadTimesTable({
  categories, stored, fallbackLabel, canClear, onSave,
}: {
  categories: LeadCategoryOption[];
  stored: (category: string) => number | undefined;
  fallbackLabel: (category: string) => string;
  canClear: boolean;
  onSave: (changes: LeadTimeChange[]) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Partial<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const changes: LeadTimeChange[] = categories.flatMap(({ key }) => {
    const raw = draft[key];
    if (raw === undefined) return [];
    const next = parse(raw);
    if (next === null && !canClear) return [];
    return next === (stored(key) ?? null) ? [] : [{ category: key, leadDays: next }];
  });

  const save = async () => {
    setSaving(true);
    try {
      await onSave(changes);
      setDraft({});
      setSaved(true);
    } catch {
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <table className="w-full max-w-xl text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[12px] text-ink-muted">
            <th className="py-1.5 pr-3 font-medium">Category</th>
            <th className="py-1.5 pr-3 font-medium">Days early</th>
            <th className="py-1.5 font-medium">When blank</th>
          </tr>
        </thead>
        <tbody>
          {categories.map(({ key, label }) => {
            const changed = changes.some((c) => c.category === key);
            return (
              <tr key={key} className="border-b border-border/60">
                <td className="py-1.5 pr-3 font-medium text-ink">{label}</td>
                <td className="py-1.5 pr-3">
                  <input
                    type="number"
                    min={0}
                    className={`h-8 w-24 rounded-md border bg-surface px-2 text-right text-[13px] ${changed ? 'border-accent' : 'border-border'}`}
                    value={draft[key] ?? asStr(stored(key))}
                    placeholder="—"
                    onChange={(e) => { setSaved(false); setDraft((s) => ({ ...s, [key]: e.target.value })); }}
                    aria-label={`${label} lead time in days`}
                  />
                </td>
                <td className="py-1.5 text-[12px] text-ink-muted">{fallbackLabel(key)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <Button type="button" variant="primary" disabled={saving || changes.length === 0} onClick={() => void save()}>
          {saving ? 'Saving…' : changes.length > 1 ? `Save ${changes.length} changes` : 'Save changes'}
        </Button>
        <Button type="button" variant="secondary" disabled={saving || Object.keys(draft).length === 0} onClick={() => setDraft({})}>
          Discard
        </Button>
        {saved && changes.length === 0 && <span className="text-[12px] text-ink-muted">Saved</span>}
      </div>
    </div>
  );
}
