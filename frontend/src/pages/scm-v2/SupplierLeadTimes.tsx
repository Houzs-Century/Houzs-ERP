// ----------------------------------------------------------------------------
// SupplierLeadTimes — the owner's MANUAL per-(supplier, category) lead time,
// edited on the supplier page (owner 2026-09-11: 「我会在每一个 Supplier 去 set
// 它的 Category lead time 多久」).
//
// A value here OVERRIDES the category default (the MRP "Lead Times" table) when
// a PO is raised for THIS supplier — highest priority. It is "days BEFORE the
// customer's delivery date to order", exactly like the base. Leave a box BLANK
// to use the default; typing a number (0 allowed = order same-day) sets an
// override; clearing it removes the override so the default applies again.
//
// Self-contained (its own query hooks) so the 4,000-line SupplierDetail grows by
// one import + one panel, not by this whole section — the file-size ceiling.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailed } from '../../vendor/scm/lib/mutation-error';
import { useCategoryLeadTimes, GLOBAL_LEAD_KEY, LEAD_CATEGORIES, type LeadCategory } from '../../vendor/scm/lib/mrp-queries';
import { Button } from '../../components/Button';

/* The orderable categories — every lead category except service (a service line
   creates no purchase), mirroring the base "Lead Times" dialog. Derived from the
   shared LEAD_CATEGORIES rather than re-listed, so the vocabulary has one home. */
const CATEGORIES: LeadCategory[] = LEAD_CATEGORIES.filter((c) => c !== 'service');

/* null = not overridden (the default applies); a number = the override. */
type SupplierLeadTimes = Record<LeadCategory, number | null>;

function useSupplierLeadTimes(supplierId: string) {
  return useQuery({
    queryKey: ['mrp-supplier-lead-times', supplierId],
    queryFn: () =>
      authedFetch<{ leadTimes: SupplierLeadTimes }>(
        `/mrp-supplier-lead-times?supplierId=${encodeURIComponent(supplierId)}`,
      ),
    staleTime: 60_000,
  });
}

function useSaveSupplierLeadTime(supplierId: string) {
  const qc = useQueryClient();
  return useMutation({
    // leadDays null = clear the override (DELETE); a number = set it (PUT).
    mutationFn: (body: { category: LeadCategory; leadDays: number | null }) =>
      authedFetch(`/mrp-supplier-lead-times`, {
        method: body.leadDays === null ? 'DELETE' : 'PUT',
        body: JSON.stringify(
          body.leadDays === null
            ? { supplierId, category: body.category }
            : { supplierId, category: body.category, leadDays: body.leadDays },
        ),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mrp-supplier-lead-times', supplierId] });
      void qc.invalidateQueries({ queryKey: ['mrp'] }); // order-by dates recompute
    },
    onError: writeFailed,
  });
}

export function SupplierLeadTimes({ supplierId }: { supplierId: string }) {
  const q = useSupplierLeadTimes(supplierId);
  const save = useSaveSupplierLeadTime(supplierId);
  const baseQ = useCategoryLeadTimes();
  const globalBase = baseQ.data?.leadTimes[GLOBAL_LEAD_KEY];

  const stored = q.data?.leadTimes;
  const [draft, setDraft] = useState<Partial<Record<LeadCategory, string>>>({});

  const storedStr = (cat: LeadCategory): string => {
    const v = stored?.[cat];
    return v === null || v === undefined ? '' : String(v);
  };
  const valueFor = (cat: LeadCategory): string => draft[cat] ?? storedStr(cat);
  const dirty = (cat: LeadCategory): boolean =>
    draft[cat] !== undefined && draft[cat] !== storedStr(cat);

  const saveCat = (cat: LeadCategory) => {
    const raw = valueFor(cat).trim();
    const leadDays = raw === '' ? null : Math.max(0, Math.floor(Number(raw) || 0));
    save.mutate(
      { category: cat, leadDays },
      { onSuccess: () => setDraft((s) => { const x = { ...s }; delete x[cat]; return x; }) },
    );
  };

  if (q.isError) {
    return (
      <section className="rounded-md border border-border bg-surface p-4 text-[13px] text-ink-muted shadow-stone">
        Lead times could not be loaded. Setting a supplier lead time needs MRP access.
      </section>
    );
  }

  return (
    <section className="rounded-md border border-border bg-surface p-4 shadow-stone">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-ink-secondary">
        Lead Times
      </h2>
      <p className="mb-3 max-w-2xl text-[13px] text-ink-muted">
        How many days <strong>before</strong> the customer&rsquo;s delivery date a PO to this supplier
        is ordered, per category. This <strong>overrides</strong> the category default for this
        supplier. Leave a box blank to use the default; a number (0 = same day) sets an override.
      </p>
      {q.isLoading ? (
        <p className="text-[13px] text-ink-muted">Loading&hellip;</p>
      ) : (
        <div className="flex flex-col gap-2">
          {CATEGORIES.map((cat) => {
            const base = globalBase?.[cat];
            const isSet = storedStr(cat) !== '';
            return (
              <label key={cat} className="flex items-center gap-3">
                <span className="w-28 text-[13px] font-medium capitalize text-ink">{cat}</span>
                <input
                  type="number"
                  min={0}
                  className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-right text-[13px]"
                  value={valueFor(cat)}
                  placeholder={base !== undefined ? `default ${base}` : 'default'}
                  onChange={(e) => setDraft((s) => ({ ...s, [cat]: e.target.value }))}
                  aria-label={`${cat} lead time override in days`}
                />
                <span className="text-[13px] text-ink-muted">days early</span>
                <Button
                  type="button"
                  variant="primary"
                  disabled={save.isPending || !dirty(cat)}
                  onClick={() => saveCat(cat)}
                >
                  Save
                </Button>
                <span className="text-[12px] text-ink-muted">
                  {isSet ? 'override set' : base !== undefined ? `using default (${base})` : 'using default'}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
