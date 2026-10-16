import { useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { useCreateBindingsBatch, type BindingRow } from '../../vendor/scm/lib/suppliers-queries';
import type { MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { findModelSkuGaps, gapToNewBinding } from '../../vendor/scm/lib/supplier-model-gaps';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';

/* BUG-97: a compartment added to a Model this supplier already maps has no row
   in this tab until it is bound, so there is nowhere to put its price. Nothing
   is pre-ticked: a supplier may leave some of a Model's codes out on purpose
   (a STOOL it does not make), and those stay listed here until someone maps them. */
export const UnmappedModelSkus = ({
  supplierId,
  bindings,
  products,
}: {
  supplierId: string;
  bindings: BindingRow[];
  products: MfgProductRow[];
}) => {
  const gaps = useMemo(() => findModelSkuGaps(bindings, products), [bindings, products]);
  const batch = useCreateBindingsBatch();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  if (gaps.length === 0) return null;

  const live = gaps.filter((g) => picked.has(g.product.code));
  const allPicked = live.length === gaps.length;
  const toggle = (code: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const submit = () => {
    if (live.length === 0) return;
    batch.mutate({ supplierId, bindings: live.map(gapToNewBinding) }, {
      onSuccess: (res) => {
        setPicked(new Set());
        void notify({
          title: `Mapped ${res.inserted} code${res.inserted === 1 ? '' : 's'}.`,
          body: 'Fill their prices in the table below.',
        });
      },
      onError: (err: unknown) => notify({
        title: 'Mapping failed',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      }),
    });
  };

  return (
    <div className="border-t border-border bg-warning-bg px-4 py-3 text-[13px] text-warning-text">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {gaps.length} code{gaps.length === 1 ? '' : 's'} under Models this supplier already maps
          {gaps.length === 1 ? ' is' : ' are'} not mapped here, so {gaps.length === 1 ? 'it has' : 'they have'} no price row.
        </span>
        <Button variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Hide' : 'Review'}
        </Button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="inline-flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() => setPicked(allPicked ? new Set() : new Set(gaps.map((g) => g.product.code)))}
            />
            Select all
          </label>
          <ul className="flex flex-col gap-1">
            {gaps.map((g) => (
              <li key={g.product.code}>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(g.product.code)}
                    onChange={() => toggle(g.product.code)}
                  />
                  <code className="font-semibold text-ink">{g.product.code}</code>
                  <span>as</span>
                  <code>{g.supplierSku}</code>
                </label>
              </li>
            ))}
          </ul>
          <div>
            <Button variant="primary" onClick={submit} disabled={live.length === 0 || batch.isPending}>
              {batch.isPending ? 'Mapping…' : `Map ${live.length} selected`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
