// ----------------------------------------------------------------------------
// One scanned delivery order in the check step (owner 2026-11-04, Claude
// design). Everything is shown once, where it is edited: the head row IS the
// supplier, D.O. no and received date; the rows split PO, SKU and description,
// and a row's PO and SKU are the same kind of dropdown. Free gifts come from the
// same SKU dropdown: a SKU of this supplier on no open PO.
// ----------------------------------------------------------------------------
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, Loader2, Star, X } from 'lucide-react';
import { DateField } from './DateField';
import { SearchableSelect } from './SearchableSelect';
import { fetchDocFileBlobUrl } from '../lib/payment-voucher-queries';
import { writeFailedAs } from '../lib/mutation-error';
import { fmtDate, todayMY } from '../../shared/format';
import {
  fetchSupplierSkus, isOddDate, newLineKey, poOptions, skuOptions, skuValue,
  type CheckDoc, type CheckPoLine, type CheckSupplier, type GrnReview, type ReviewLine,
} from '../lib/scan-gr-check';
import styles from './ScanGrnCheck.module.css';

type Props = {
  doc: CheckDoc;
  review: GrnReview | null;
  suppliers: CheckSupplier[];
  poLines: CheckPoLine[];
  checked: boolean;
  block: string | null;
  onToggle: () => void;
  onChange: (review: GrnReview) => void;
  onDelete: () => void;
  onRetry: () => void;
  onGold: () => void;
  onOpenGrn: (grnId: string) => void;
};

export function ScanGrnCheckCard({ doc, review, suppliers, poLines, checked, block, onToggle, onChange, onDelete, onRetry, onGold, onOpenGrn }: Props) {
  const [open, setOpen] = useState(false);
  const skus = useQuery({
    queryKey: ['scan-gr-check', 'skus', review?.supplierId],
    queryFn: () => fetchSupplierSkus(review?.supplierId as string),
    enabled: open && !!review?.supplierId,
    staleTime: 300_000,
  });
  const pages = doc.pages ? ` · pages ${doc.pages[0]}–${doc.pages[1]}` : '';

  if (doc.state !== 'pending' || !review) {
    return (
      <div className={styles.card}>
        <div className={styles.reading}>
          {doc.state === 'reading' ? <Loader2 size={15} /> : <X size={15} color="#b23a3a" />}
          <span className={styles.grow}>{doc.fileName ?? 'Document'}{pages}</span>
          <span>{doc.state === 'reading' ? 'Reading…' : doc.note ?? 'Could not read this document.'}</span>
          {doc.state === 'failed' && <button type="button" className={styles.bannerBtn} onClick={onRetry}>Read again</button>}
          <button type="button" className={styles.icon} onClick={onDelete} aria-label="Delete this scan"><X size={14} /></button>
        </div>
      </div>
    );
  }

  const byId = new Map(poLines.map((l) => [l.poItemId, l]));
  const mine = poLines.filter((l) => l.supplierId === review.supplierId);
  const tied = review.lines.flatMap((l) => (l.poItemId && byId.get(l.poItemId) ? [byId.get(l.poItemId) as CheckPoLine] : []));
  const warehouses = [...new Set(tied.map((l) => l.warehouse).filter(Boolean))].join(', ');
  const pos = [...new Set(tied.map((l) => l.poNumber))].join(', ');
  const repeat = doc.duplicateOf ?? null;
  const oddDate = isOddDate(review.deliveryDate, todayMY());

  const set = (patch: Partial<GrnReview>) => onChange({ ...review, ...patch });
  const setLine = (key: string, patch: Partial<ReviewLine>) => set({ lines: review.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const viewFile = async () => {
    try {
      const { url } = await fetchDocFileBlobUrl(`/scan-gr/check/${doc.id}/file`);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { writeFailedAs('Could not open the file')(e); }
  };
  const pickPo = (key: string, v: string) => {
    const onPo = mine.filter((l) => l.poNumber === v);
    setLine(key, { poNumber: v || null, gift: null, poItemId: onPo.length === 1 ? onPo[0].poItemId : null });
  };
  const pickSku = (key: string, v: string) => {
    if (v.startsWith('gift:')) {
      const code = v.slice(5);
      setLine(key, { poItemId: null, poNumber: null, gift: { itemCode: code, name: skus.data?.find((s) => s.code === code)?.name ?? code } });
    } else {
      const id = v.slice(5);
      setLine(key, { poItemId: id, poNumber: byId.get(id)?.poNumber ?? null, gift: null });
    }
  };

  const cardClass = [styles.card, repeat || doc.repeatOf ? styles.cardRepeat : checked ? styles.cardOn : ''].join(' ');
  return (
    <div className={cardClass}>
      <div className={styles.head}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label="Include this delivery order" />
        <button type="button" className={`${styles.icon} ${styles.caret}`} onClick={() => setOpen((v) => !v)} aria-label={open ? 'Hide the lines' : 'Show the lines'} aria-expanded={open}>
          <ChevronRight size={15} className={open ? styles.caretOpen : ''} />
        </button>
        <SearchableSelect
          value={review.supplierId ?? ''}
          onChange={(v) => set({ supplierId: v || null, lines: review.lines.map((l) => ({ ...l, poItemId: null, poNumber: null, gift: null })) })}
          options={suppliers.map((s) => ({ value: s.id, label: s.name ?? s.code ?? s.id, search: s.code ?? undefined }))}
          placeholder={review.supplierRead ? `Read: ${review.supplierRead}` : 'Choose the supplier'}
          className={`${styles.field} ${styles.supplier}`}
          ariaLabel="Supplier"
        />
        <input className={`${styles.field} ${styles.mono}`} value={review.doNo ?? ''} onChange={(e) => set({ doNo: e.target.value || null })} placeholder="D.O. no" aria-label="Delivery order number" />
        <div className={oddDate ? styles.dateOdd : ''}>
          <DateField value={review.deliveryDate ?? ''} onChange={(v) => set({ deliveryDate: v || null })} aria-label="Received date" fullWidth />
        </div>
        <div className={styles.meta}>
          <div className={styles.metaLine}>{warehouses || '—'}</div>
          <div className={`${styles.metaLine} ${styles.metaPo} ${styles.mono}`}>{pos || 'No PO line yet'}</div>
        </div>
        <div className={styles.icons}>
          {doc.canGold && (
            <button type="button" className={`${styles.icon} ${styles.gold}`} onClick={onGold} disabled={doc.gold} aria-label={doc.gold ? 'Marked as gold' : 'Mark as gold'} title={doc.gold ? 'Marked as gold' : 'Mark as gold: the scanner learns from this read'}>
              <Star size={16} fill={doc.gold ? 'currentColor' : 'none'} />
            </button>
          )}
          {doc.hasFile && <button type="button" className={styles.icon} onClick={() => void viewFile()} aria-label="View the file" title={`${doc.fileName ?? 'File'}${pages}`}><FileText size={16} /></button>}
          <button type="button" className={styles.icon} onClick={onDelete} aria-label="Delete this scan" title="Delete"><X size={15} /></button>
        </div>
      </div>

      {repeat && (
        <div className={styles.banner}>
          <strong>Already received</strong>
          <span>
            D.O. {review.doNo} of this supplier is on goods receipt{' '}
            <button type="button" className={styles.bannerLink} onClick={() => onOpenGrn(repeat.id)}>{repeat.grnNumber}</button>
            {' '}({repeat.status.toLowerCase()}{repeat.receivedAt ? `, ${fmtDate(repeat.receivedAt)}` : ''}). Left unticked so it is not received twice.
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.bannerBtn} onClick={onToggle}>{checked ? 'Do not create' : 'Create anyway'}</button>
          <button type="button" className={`${styles.bannerBtn} ${styles.bannerDanger}`} onClick={onDelete}>Delete this scan</button>
        </div>
      )}
      {!repeat && doc.repeatOf && (
        <div className={styles.banner}>
          <strong>Twice in this list</strong>
          <span>The same D.O. is also in {doc.repeatOf}. Left unticked.</span>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.bannerBtn} onClick={onToggle}>{checked ? 'Do not create' : 'Create anyway'}</button>
          <button type="button" className={`${styles.bannerBtn} ${styles.bannerDanger}`} onClick={onDelete}>Delete this scan</button>
        </div>
      )}
      {oddDate && <div className={styles.hint}>This date is far from today. Check the day and month were not read swapped.</div>}
      {block && <div className={styles.hint}>{block}</div>}
      {doc.note && open && <div className={styles.hint}>{doc.note}</div>}

      {open && (
        <div className={styles.lines}>
          <div className={`${styles.row} ${styles.rowHead}`}>
            <span>#</span><span>PO</span><span>SKU</span><span>Description</span><span className={styles.right}>Owed</span><span className={styles.right}>Qty</span><span />
          </div>
          {review.lines.map((l, i) => {
            const line = l.poItemId ? byId.get(l.poItemId) : undefined;
            const po = l.poNumber ?? line?.poNumber ?? '';
            const printed = l.read ? [l.read.itemCode, l.read.description, l.read.poNo ? `PO ${l.read.poNo}` : null].filter(Boolean).join(' · ') : '';
            return (
              <div key={l.key} className={styles.row}>
                <span className={styles.num}>{i + 1}</span>
                {l.gift ? (
                  <button type="button" className={styles.gift} onClick={() => setLine(l.key, { gift: null })} title="Not a free gift">Free gift · RM0 <X size={11} /></button>
                ) : (
                  <SearchableSelect value={po} onChange={(v) => pickPo(l.key, v)} options={poOptions(mine)} placeholder="Choose PO" className={`${styles.cell} ${styles.mono}`} ariaLabel={`PO for row ${i + 1}`} />
                )}
                <SearchableSelect
                  value={skuValue(l)}
                  onChange={(v) => pickSku(l.key, v)}
                  options={skuOptions(mine, skus.data ?? [], po || null, l)}
                  placeholder={review.supplierId ? 'Choose SKU' : 'Choose the supplier first'}
                  className={styles.cell}
                  ariaLabel={`SKU for row ${i + 1}`}
                />
                <div className={styles.desc}>
                  <div className={styles.metaLine}>{l.gift?.name ?? line?.name ?? '—'}</div>
                  {printed && <div className={styles.printed}>Printed: {printed}</div>}
                </div>
                <span className={styles.right}>{line?.remaining ?? '—'}</span>
                <input className={`${styles.cell} ${styles.qty}`} type="number" min={0} step="1" value={l.qty} onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value) || 0) })} aria-label={`Qty for row ${i + 1}`} />
                <button type="button" className={`${styles.icon} ${styles.caret}`} onClick={() => set({ lines: review.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove row ${i + 1}`}><X size={13} /></button>
              </div>
            );
          })}
          <button type="button" className={styles.addLine} onClick={() => set({ lines: [...review.lines, { key: newLineKey(), poItemId: null, poNumber: null, gift: null, qty: 1, read: null }] })}>+ Add line</button>
          {review.lines.some((l) => !l.poItemId && !l.gift) && <p className={styles.leftOut}>A row with no SKU chosen is left off the draft.</p>}
        </div>
      )}
    </div>
  );
}
