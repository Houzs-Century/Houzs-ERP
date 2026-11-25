// ----------------------------------------------------------------------------
// OpeningBillsDialog — where the Cash Flow puts payments of the opening bills
// (the AutoCount bills brought over at go-live), kept by Finance (owner
// 2026-11-25, 「要，做 A」). Each supplier with opening bills gets a Cash Flow
// line: Automatic (what its own bills in the ERP give, else the creditor
// control), a category, or an account; a supplier whose bills are for
// different things (「根据purpose去放」) can have a line per bill, which comes
// first. Each pick is kept at once. Cash Flow only: nothing posts.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { Modal } from '../../../vendor/scm/components/Modal';
import { useToastOptional } from '../../../hooks/useToast';
import { fmtDate, fmtSenPlain } from '../../../vendor/shared/format';
import {
  useOpeningBillRows, useOpeningBills, useSaveOpeningBillPlace,
  type OpeningBillsPayload, type OpeningSupplierRow, type PlaceChange, type PlaceOut,
} from '../../../vendor/scm/lib/opening-bill-places-queries';
import f from './Forecast.module.css';

/** A pick as the select keeps it: '' = none, `cat:<id>`, `acc:<code>`. */
export const valueOf = (p: PlaceOut | null): string => (p === null ? '' : p.kind === 'account' ? `acc:${p.code}` : `cat:${p.id}`);

/** The select's value as the account or category to keep (both null: clear the choice). */
export function changeOf(value: string): Pick<PlaceChange, 'account' | 'category'> {
  if (value.startsWith('acc:')) return { account: value.slice(4), category: null };
  if (value.startsWith('cat:')) return { account: null, category: value.slice(4) };
  return { account: null, category: null };
}

/** A line as words: an account by its code and name, a category by its name. */
export const placeText = (p: PlaceOut): string => (p.kind === 'account' ? `${p.code} · ${p.name}` : `${p.label} (category)`);

/** What Automatic gives a supplier. */
export const autoText = (s: OpeningSupplierRow): string => (s.auto === null ? 'Creditor control' : placeText(s.auto));

function PlacePick({ data, value, first, label, disabled, onPick }: {
  data: OpeningBillsPayload; value: string; first: string; label: string; disabled: boolean; onPick: (value: string) => void;
}) {
  return (
    <select className={f.select} aria-label={label} value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)} style={{ maxWidth: 360 }}>
      <option value="">{first}</option>
      <optgroup label="Cash Flow categories">
        {data.categories.map((k) => <option key={k.id} value={`cat:${k.id}`}>{k.path}</option>)}
      </optgroup>
      <optgroup label="Accounts">
        {data.accounts.map((a) => <option key={a.code} value={`acc:${a.code}`}>{a.code} · {a.name}</option>)}
      </optgroup>
    </select>
  );
}

function SupplierBills({ data, supplier, canWrite, onSave, saving }: {
  data: OpeningBillsPayload; supplier: OpeningSupplierRow; canWrite: boolean; onSave: (c: PlaceChange) => void; saving: boolean;
}) {
  const q = useOpeningBillRows(supplier.id);
  const own = supplier.set ?? supplier.auto;
  const same = `Same as the supplier (${own === null ? 'Creditor control' : placeText(own)})`;
  return (
    <tr className={f.row} data-row={`bills:${supplier.id}`}>
      <td colSpan={5} style={{ padding: '6px 12px 10px 28px' }}>
        {q.isError && <p role="alert" className={f.alert}>Its bills did not load. Close this and try again.</p>}
        {!q.data && !q.isError && <p className={f.empty}>Loading its bills…</p>}
        {q.data && (
          <table className={f.table} aria-label={`${supplier.name} opening bills`}>
            <thead>
              <tr>
                <th className={`${f.th} ${f.textHead}`}>Bill</th>
                <th className={f.th}>Date</th>
                <th className={`${f.th} ${f.textHead}`}>What it says</th>
                <th className={f.th}>Amount</th>
                <th className={f.th}>Paid</th>
                <th className={`${f.th} ${f.textHead}`}>Cash Flow line</th>
              </tr>
            </thead>
            <tbody>
              {q.data.bills.map((b) => (
                <tr key={b.id} className={f.row} data-row={`bill:${b.id}`}>
                  <td className={f.text} style={{ whiteSpace: 'nowrap' }}>{b.number}</td>
                  <td className={f.cell}>{fmtDate(b.date)}</td>
                  <td className={f.text} style={{ maxWidth: 420 }}>{b.text || '-'}</td>
                  <td className={f.cell}>{fmtSenPlain(b.totalSen)}</td>
                  <td className={f.cell}>{fmtSenPlain(b.paidSen)}</td>
                  <td className={f.text}>
                    <PlacePick
                      data={data} value={valueOf(b.set)} first={same} label={`${b.number} Cash Flow line`} disabled={!canWrite || saving}
                      onPick={(v) => onSave({ supplierId: null, billId: b.id, ...changeOf(v) })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

export function OpeningBillsDialog({ onClose, canWrite }: { onClose: () => void; canWrite: boolean }) {
  const q = useOpeningBills(true);
  const save = useSaveOpeningBillPlace();
  const toast = useToastOptional();
  const [open, setOpen] = useState<string | null>(null);
  const keep = (change: PlaceChange) => {
    save.mutate(change, { onSuccess: () => toast?.success('Saved · the Cash Flow reads it now') });
  };
  return (
    <Modal title="Opening bills in the Cash Flow" onClose={onClose} ariaLabel="Opening bills in the Cash Flow" width="min(1280px, 100%)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div className={f.note} style={{ padding: 0, borderTop: 0 }}>
          Where a payment of an opening bill (the AutoCount bills brought over at go-live) reads in the Cash Flow. A bill&apos;s own line comes first, then its supplier&apos;s;
          Automatic reads the supplier&apos;s own bills in the ERP (one account, or one category they all sit in), else the creditor control.
          Each pick is kept at once. Cash Flow only: nothing posts.
        </div>
        {q.isError && <p role="alert" className={f.alert}>The list did not load. Close it and try again.</p>}
        {!q.data && !q.isError && <p className={f.empty}>Loading…</p>}
        {q.data && q.data.suppliers.length === 0 && <p className={f.empty}>This company has no opening bill.</p>}
        {q.data && q.data.suppliers.length > 0 && (
          <div className={f.card}>
            <div className={f.scroll}>
              <table className={f.table} aria-label="Opening bills by supplier">
                <thead>
                  <tr>
                    <th className={`${f.th} ${f.textHead}`}>Supplier</th>
                    <th className={f.th}>Opening bills</th>
                    <th className={f.th}>Still owed</th>
                    <th className={`${f.th} ${f.textHead}`}>Automatic</th>
                    <th className={`${f.th} ${f.textHead}`}>Cash Flow line</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.suppliers.flatMap((s) => {
                    const rows = [(
                      <tr key={s.id} className={f.row} data-row={`sup:${s.id}`}>
                        <td className={f.text} style={{ whiteSpace: 'nowrap' }}>
                          {s.name}<span className={f.hint}> · {s.code}</span>
                          <button
                            type="button" className={f.toggle} style={{ marginLeft: 10 }} aria-expanded={open === s.id}
                            onClick={() => setOpen((x) => (x === s.id ? null : s.id))}
                          >
                            {open === s.id ? 'Hide bills' : `Bills (${s.bills})`}
                          </button>
                          {s.billsSet > 0 && <span className={f.hint}> · {s.billsSet} with their own line</span>}
                        </td>
                        <td className={f.cell}>{s.openBills} open of {s.bills}</td>
                        <td className={f.cell}>{fmtSenPlain(s.owingSen)}</td>
                        <td className={f.text} style={{ whiteSpace: 'nowrap' }}>{autoText(s)}</td>
                        <td className={f.text}>
                          <PlacePick
                            data={q.data!} value={valueOf(s.set)} first={`Automatic (${autoText(s)})`} label={`${s.name} Cash Flow line`} disabled={!canWrite || save.isPending}
                            onPick={(v) => keep({ supplierId: s.id, billId: null, ...changeOf(v) })}
                          />
                        </td>
                      </tr>
                    )];
                    if (open === s.id) rows.push(<SupplierBills key={`b:${s.id}`} data={q.data!} supplier={s} canWrite={canWrite} onSave={keep} saving={save.isPending} />);
                    return rows;
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {!canWrite && q.data && <p className={f.hint}>You can read these lines; changing them needs the permission to arrange the financial statements.</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
