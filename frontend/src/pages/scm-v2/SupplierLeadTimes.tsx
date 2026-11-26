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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailed } from '../../vendor/scm/lib/mutation-error';
import { useCategoryLeadTimes, GLOBAL_LEAD_KEY, leadFallbackLabel } from '../../vendor/scm/lib/mrp-queries';
import { LeadTimesTable } from './LeadTimesTable';

type SupplierLeadTimes = Partial<Record<string, number>>;

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
    mutationFn: (body: { category: string; leadDays: number | null }) =>
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
      void qc.invalidateQueries({ queryKey: ['mrp'] });
    },
    onError: writeFailed,
  });
}

export function SupplierLeadTimes({ supplierId }: { supplierId: string }) {
  const q = useSupplierLeadTimes(supplierId);
  const save = useSaveSupplierLeadTime(supplierId);
  const baseQ = useCategoryLeadTimes();
  const categories = baseQ.data?.categories ?? [];
  const labelOf = (c: string) => categories.find((o) => o.key === c)?.label ?? c;
  const override = (c: string) => q.data?.leadTimes[c];
  const base = (c: string) => baseQ.data?.leadTimes[GLOBAL_LEAD_KEY]?.[c];

  if (q.isError || baseQ.isError) {
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
        is ordered, per category. A number here (0 = same day) <strong>overrides</strong> the
        default for this supplier. Leave it blank to use what the last column says.
      </p>
      {q.isLoading || baseQ.isLoading ? (
        <p className="text-[13px] text-ink-muted">Loading&hellip;</p>
      ) : (
        <LeadTimesTable
          categories={categories}
          stored={override}
          fallbackLabel={(c) => leadFallbackLabel(c, [override, base], labelOf, 'Default')}
          canClear
          onSave={async (changes) => {
            for (const ch of changes) await save.mutateAsync(ch);
          }}
        />
      )}
    </section>
  );
}
