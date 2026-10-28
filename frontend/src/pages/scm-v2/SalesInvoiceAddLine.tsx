/* useSalesInvoiceAddLine — the sales invoice's "Add line", as one module.
 *
 * WHAT WAS WRONG. Of the six SCM documents the SALES INVOICE was the only one
 * where a line could not be added by hand on ANY surface. The backend route
 * `POST /sales-invoices/:id/items` existed, was tenancy-guarded, audited, and
 * resynced GL revenue; `useAddSalesInvoiceItem` existed in the query layer —
 * with ZERO call sites in `frontend/src`. A finished, guarded endpoint nobody
 * could reach. The other four documents got their button on 2026-09-13
 * (docs/bugs/0853); the invoice was left out and the gap written down instead.
 *
 * WHY THIS SHAPE RATHER THAN THE SIBLINGS'. The four siblings put an "Add line"
 * button on the V2 detail page that hands the operator to a SEPARATE V1 editor
 * page through `vendor/scm/lib/add-line-handoff.ts` — that contract exists
 * because the add row lives on another page. The sales invoice has exactly one
 * page, `SalesInvoiceDetailV2.tsx`; there is nothing to hand off TO, and
 * building a second editor page to carry one button would be a whole surface of
 * new code, new permissions and new drift for an affordance that fits in a row.
 * So the add row opens in place, in the Line items section where the lines
 * already are. `ADD_LINE_LABEL` is still the word on the button, so the owner
 * reads ONE name across all five documents that can do this.
 *
 * WHY A HOOK RETURNING ELEMENTS. `SalesInvoiceDetailV2.tsx` sits ~30 lines
 * under the repo's 2,000-line ceiling (`scripts/check-file-size.mjs` charges
 * GROWTH), and the affordance needs TWO slots in that file — the Section's
 * `actions` header and its body. A hook handing back both costs the detail page
 * three lines and keeps the state, the draft, the validation and the error
 * surface here, where they can be read together.
 *
 * WHEN IT IS OFFERED — the same answer the server gives, computed on the client
 * so a refusal never has to be the way the operator finds out:
 *   · `pageAccess('scm.sales.invoices')` in (edit | full) — the page's own Edit
 *     gate, so one permission answers for both;
 *   · status DRAFT only. `isIssuedSi` (backend) is "any status but DRAFT and
 *     CANCELLED", and lines are frozen WHOLESALE there: adding one raises what
 *     the customer owes and void+reposts the GL while the PDF in their hand
 *     does not change. CANCELLED is refused too. Cancel → fix → reopen is the
 *     sanctioned correction path and is already first-class on this page.
 *
 * THE ERROR PATH IS THE POINT, not a decoration. `POST /:id/items` can refuse
 * with an unknown item code (409), a line still pending on the source Delivery
 * Order (409), an over-remaining quantity (409), a cancelled or issued invoice
 * (409) — each carrying a sentence worth reading. Those arrive INLINE, beside
 * the row, which stays open holding what was typed. `useAddSalesInvoiceItem`
 * additionally carries `onError: writeFailedAs('Line not added')`; that stays,
 * deliberately, as the shared guarantee that a refusal is never silent for any
 * future caller (vendor/scm/lib/mutation-error.ts). Inline is the CONTEXT; the
 * dialog is the FLOOR.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Save, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { ADD_LINE_LABEL } from '../../vendor/scm/lib/add-line-handoff';
import { useAddSalesInvoiceItem } from '../../vendor/scm/lib/sales-invoice-queries';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { mfgCategoryLabel } from '../../vendor/shared/product-categories';

export type SalesInvoiceAddLine = {
  /** Goes in the Line items Section's `actions` slot. `null` when not offered. */
  action: ReactNode;
  /** Goes inside that Section, under the table. `null` while closed. */
  panel: ReactNode;
};

type Draft = {
  itemCode: string;
  description: string;
  qty: number;
  unitPriceSen: number;
  discountSen: number;
};

const EMPTY: Draft = { itemCode: '', description: '', qty: 1, unitPriceSen: 0, discountSen: 0 };

const DATALIST_ID = 'si-add-line-products';

/* Same clamp the server applies in `buildItemRow` — shown so the operator sees
   the figure that will be stored, not one the server will quietly lower. */
const lineTotalSen = (d: Draft): number =>
  Math.max(0, d.qty * d.unitPriceSen - d.discountSen);

const LABEL = 'text-[12px] text-ink-muted';
const INPUT =
  'rounded-md border border-border bg-canvas px-2 py-1.5 text-[13px] text-ink focus:border-primary focus:outline-none';

export function useSalesInvoiceAddLine(
  invoiceId: string | null,
  canAdd: boolean,
): SalesInvoiceAddLine {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const addItem = useAddSalesInvoiceItem();

  /* The SKU catalogue behind the code field. Only fetched while the row is
     open — a detail page that is only ever READ must not pull the catalogue. */
  const products = useMfgProducts({ enabled: open });

  const close = () => {
    setOpen(false);
    setDraft(EMPTY);
    setError(null);
  };

  const submit = async () => {
    const itemCode = draft.itemCode.trim();
    if (!itemCode) {
      /* The server answers 400 `item_code_required`. Saying it here costs one
         round trip less and keeps what was typed. */
      setError('Item code is required — pick a SKU before adding the line.');
      return;
    }
    if (!(draft.qty > 0)) {
      setError('Quantity must be more than zero.');
      return;
    }
    if (!invoiceId) {
      setError('This invoice is still loading — try again in a moment.');
      return;
    }
    setError(null);
    try {
      await addItem.mutateAsync({
        id: invoiceId,
        itemCode,
        description: draft.description.trim() || null,
        qty: draft.qty,
        unitPriceSen: draft.unitPriceSen,
        discountSen: draft.discountSen,
        uom: 'UNIT',
      });
      close();
    } catch (e) {
      /* The row STAYS OPEN holding the typing. Every 409 this endpoint answers
         is actionable — pick a different code, go through "Add from Delivery
         Order", lower the quantity — and none of that is possible from a form
         that has cleared itself. */
      setError(e instanceof Error ? e.message : 'The line was not added. Please try again.');
    }
  };

  const action = useMemo<ReactNode>(() => {
    if (!canAdd || open) return null;
    return (
      <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setOpen(true)}>
        {ADD_LINE_LABEL}
      </Button>
    );
  }, [canAdd, open]);

  if (!canAdd || !open) return { action, panel: null };

  const panel = (
    /* A fieldset, not a div: the line table's own column headers carry
       "Unit price" / "Discount" filter buttons, so the add row's fields are
       only unambiguously addressable — to a screen reader and to a test —
       inside a named group. */
    <fieldset className="mt-3 rounded-lg border border-primary/40 bg-surface p-4">
      <legend className="px-1 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
        New line
      </legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Item code</span>
          <input
            type="text"
            list={DATALIST_ID}
            className={`${INPUT} font-mono`}
            placeholder="Type to search SKUs by code or name…"
            value={draft.itemCode}
            onChange={(e) => setDraft((d) => ({ ...d, itemCode: e.target.value }))}
          />
          <datalist id={DATALIST_ID}>
            {(products.data ?? []).map((p) => (
              <option key={p.id} value={p.code}>
                {p.name} · {mfgCategoryLabel(p.category)}
              </option>
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Description</span>
          <input
            type="text"
            className={INPUT}
            placeholder="What the customer is being billed for"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </label>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Qty</span>
          <NumberInput
            sign="unsigned"
            decimal={false}
            className={`${INPUT} text-right`}
            value={draft.qty}
            onValueChange={(n) => setDraft((d) => ({ ...d, qty: n ?? 0 }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Unit price</span>
          <MoneyInput
            bare
            selectOnFocus
            inputClassName={`${INPUT} text-right`}
            valueSen={draft.unitPriceSen}
            onCommit={(sen) => setDraft((d) => ({ ...d, unitPriceSen: sen ?? 0 }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Discount</span>
          <MoneyInput
            bare
            selectOnFocus
            inputClassName={`${INPUT} text-right`}
            valueSen={draft.discountSen}
            onCommit={(sen) => setDraft((d) => ({ ...d, discountSen: sen ?? 0 }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Amount</span>
          <output className={`${INPUT} bg-surface-dim text-right tabular-nums text-ink-muted`}>
            {(lineTotalSen(draft) / 100).toLocaleString('en-MY', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </output>
        </label>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" icon={<X size={14} />} onClick={close} disabled={addItem.isPending}>
          Cancel
        </Button>
        <Button variant="primary" icon={<Save size={14} />} onClick={() => void submit()} disabled={addItem.isPending}>
          {addItem.isPending ? 'Adding…' : 'Add to invoice'}
        </Button>
      </div>
    </fieldset>
  );

  return { action, panel };
}
