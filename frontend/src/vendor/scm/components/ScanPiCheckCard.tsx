// ----------------------------------------------------------------------------
// One scanned supplier invoice in the check step, the twin of ScanGrnCheckCard:
// the head row is the supplier, invoice no and date; rows split GRN, SKU and
// description, and bill a Goods Receipt line. The draft bills the supplier's
// printed price; one that differs from the PO shows in red for the operator.
// ----------------------------------------------------------------------------
import { useState } from 'react';
import { ChevronRight, FileText, Loader2, Star, X } from 'lucide-react';
import { DateField } from './DateField';
import { skuOption } from './ScanGrnCheckCard';
import { SearchableSelect } from './SearchableSelect';
import { fetchDocFileBlobUrl } from '../lib/payment-voucher-queries';
import { writeFailedAs } from '../lib/mutation-error';
import { fmtDate, fmtSen, todayMY } from '../../shared/format';
import { isOddDate, printedText, shortNote, swappedDate, type CheckSupplier } from '../lib/scan-gr-check';
import { billSkuOptions, grnOptions, lineTierNote, newPiLineKey, piAmounts, piAmountsDiffer, piQtyTotals, priceDiffers, type BillLine, type PiCheckDoc, type PiReview, type PiReviewLine } from '../lib/scan-pi-check';
import type { CardProps } from './ScanCheckModal';
import styles from './ScanGrnCheck.module.css';
import { openLoadedTab } from '../../../lib/openLoadedTab';

type Props = Omit<CardProps<PiReview, PiCheckDoc>, 'onOpenDoc'> & { suppliers: CheckSupplier[]; billLines: BillLine[]; onOpenPi: (id: string) => void };

export function ScanPiCheckCard({ doc, review, suppliers, billLines, checked, block, onToggle, onChange, onDelete, onRetry, onGold, onOpenPi }: Props) {
  const [open, setOpen] = useState(false);
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

  const byId = new Map(billLines.map((l) => [l.grnItemId, l]));
  const mine = billLines.filter((l) => l.supplierId === review.supplierId);
  const tied = review.lines.flatMap((l) => (l.grnItemId && byId.get(l.grnItemId) ? [byId.get(l.grnItemId) as BillLine] : []));
  const grns = [...new Set(tied.map((l) => l.grnNumber))].join(', ');
  const pos = [...new Set(tied.map((l) => l.poNumber).filter(Boolean))].join(', ');
  const repeat = doc.duplicateOf;
  const today = todayMY();
  const oddDate = isOddDate(review.invoiceDate, today);
  const swapped = swappedDate(review.invoiceDate, today);
  const anyTied = review.lines.some((l) => l.grnItemId);
  const amounts = piAmounts(review, byId);
  const { invoiceSen, oursSen, unmatched } = amounts;
  const qtyTotals = piQtyTotals(review, byId);
  const amountsDiffer = piAmountsDiffer(amounts);
  const tierNote = lineTierNote(review);
  const notMatched = unmatched > 0 && oursSen != null ? ` (${unmatched} ${unmatched === 1 ? 'line' : 'lines'} not matched)` : '';

  const set = (patch: Partial<PiReview>) => onChange({ ...review, ...patch });
  const setLine = (key: string, patch: Partial<PiReviewLine>) => set({ lines: review.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const viewFile = async () => {
    try {
      await openLoadedTab(async () => (await fetchDocFileBlobUrl(`/scan-pi/check/${doc.id}/file`)).url, 60_000);
    } catch (e) { writeFailedAs('Could not open the file')(e); }
  };
  const pickGrn = (key: string, v: string) => {
    const on = mine.filter((l) => l.grnNumber === v);
    setLine(key, { grnNumber: v || null, suggested: false, ai: false, grnItemId: on.length === 1 ? on[0].grnItemId : null });
  };

  const cardClass = [styles.card, repeat || doc.repeatOf ? styles.cardRepeat : checked ? styles.cardOn : ''].join(' ');
  return (
    <div className={cardClass}>
      <div className={styles.head}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label="Include this invoice" />
        <button type="button" className={`${styles.icon} ${styles.caret}`} onClick={() => setOpen((v) => !v)} aria-label={open ? 'Hide the lines' : 'Show the lines'} aria-expanded={open}>
          <ChevronRight size={15} className={open ? styles.caretOpen : ''} />
        </button>
        <SearchableSelect
          value={review.supplierId ?? ''}
          onChange={(v) => set({ supplierId: v || null, lines: review.lines.map((l) => ({ ...l, grnItemId: null, grnNumber: null, suggested: false, ai: false })) })}
          options={suppliers.map((s) => ({ value: s.id, label: s.name ?? s.code ?? s.id, search: s.code ?? undefined }))}
          placeholder={review.supplierRead ? `Read: ${review.supplierRead}` : 'Choose the supplier'}
          className={`${styles.field} ${styles.supplier}`}
          ariaLabel="Supplier"
        />
        <input className={`${styles.field} ${styles.mono}`} value={review.invoiceNumber ?? ''} onChange={(e) => set({ invoiceNumber: e.target.value || null })} placeholder="Invoice no" aria-label="Supplier invoice number" />
        <div className={oddDate ? styles.dateOdd : ''}>
          <DateField value={review.invoiceDate ?? ''} onChange={(v) => set({ invoiceDate: v || null })} aria-label="Invoice date" fullWidth />
        </div>
        <div className={styles.meta}>
          <div className={`${styles.metaLine} ${styles.mono}`}>{grns || 'No GRN yet'}</div>
          <div className={`${styles.metaLine} ${styles.metaPo} ${styles.mono}`}>{pos || (review.doNo ? `D.O. ${review.doNo}` : '—')}</div>
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

      <div className={styles.amounts}>
        <span>Invoice Amount <strong>{invoiceSen == null ? '—' : fmtSen(invoiceSen)}</strong></span>
        <span>PO Amount <strong className={amountsDiffer ? styles.priceOff : ''}>{oursSen == null ? '—' : fmtSen(oursSen)}</strong>{notMatched}</span>
      </div>
      {review.taxNote && <div className={styles.hint}>{review.taxNote}</div>}
      {tierNote && <div className={styles.hint}>{tierNote}</div>}

      {repeat && (
        <div className={styles.banner}>
          <strong>Already billed</strong>
          <span>
            Invoice {review.invoiceNumber} of this supplier is on{' '}
            <button type="button" className={styles.bannerLink} onClick={() => onOpenPi(repeat.id)}>{repeat.invoiceNumber}</button>
            {' '}({repeat.status.toLowerCase()}{repeat.invoiceDate ? `, ${fmtDate(repeat.invoiceDate)}` : ''}). Left unticked so it is not billed twice.
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.bannerBtn} onClick={onToggle}>{checked ? 'Do not create' : 'Create anyway'}</button>
          <button type="button" className={`${styles.bannerBtn} ${styles.bannerDanger}`} onClick={onDelete}>Delete this scan</button>
        </div>
      )}
      {!repeat && doc.repeatOf && (
        <div className={styles.banner}>
          <strong>Twice in this list</strong>
          <span>The same invoice is also in {doc.repeatOf}. Left unticked.</span>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.bannerBtn} onClick={onToggle}>{checked ? 'Do not create' : 'Create anyway'}</button>
          <button type="button" className={`${styles.bannerBtn} ${styles.bannerDanger}`} onClick={onDelete}>Delete this scan</button>
        </div>
      )}
      {oddDate && (
        <div className={styles.hint}>
          This date is far from today.{' '}
          {swapped && <button type="button" className={styles.bannerLink} onClick={() => set({ invoiceDate: swapped })}>Change to {fmtDate(swapped)}</button>}
        </div>
      )}
      {!anyTied && (shortNote(doc.note) ?? block) && <div className={styles.hint}>{shortNote(doc.note) ?? block}</div>}
      {anyTied && block && <div className={styles.hint}>{block}</div>}

      {open && (
        <div className={styles.lines}>
          <div className={`${styles.row} ${styles.rowPi} ${styles.rowHead}`}>
            <span>#</span><span>GRN</span><span>PO</span><span>SKU</span><span>Description</span><span className={styles.right}>Left</span><span className={styles.right}>Qty</span><span className={styles.right}>PO Price</span><span className={styles.right}>PI Price</span><span />
          </div>
          {review.lines.map((l, i) => {
            const line = l.grnItemId ? byId.get(l.grnItemId) : undefined;
            const grn = l.grnNumber ?? line?.grnNumber ?? '';
            const printed = l.read ? printedText(l.read) : '';
            const off = line != null && priceDiffers(l.read?.unitPrice, line.unitPriceSen);
            return (
              <div key={l.key} className={`${styles.row} ${styles.rowPi}`}>
                <span className={styles.num}>{i + 1}</span>
                <SearchableSelect value={grn} onChange={(v) => pickGrn(l.key, v)} options={grnOptions(mine)} placeholder="Choose GRN" className={`${styles.cell} ${styles.mono}`} ariaLabel={`GRN for row ${i + 1}`} />
                <span className={`${styles.mono} ${styles.po}`} title={line?.poNumber ?? undefined}>{line?.poNumber ?? '—'}</span>
                <SearchableSelect
                  value={l.grnItemId ?? ''}
                  onChange={(v) => setLine(l.key, { grnItemId: v, grnNumber: byId.get(v)?.grnNumber ?? null, suggested: false, ai: false })}
                  options={billSkuOptions(mine, grn || null)}
                  placeholder={review.supplierId ? 'Choose SKU' : 'Choose the supplier first'}
                  className={styles.cell}
                  ariaLabel={`SKU for row ${i + 1}`}
                  renderOption={skuOption}
                />
                <div className={styles.desc}>
                  <div className={styles.metaLine}>{line?.description ?? '—'}</div>
                  {printed && <div className={styles.printed} title={l.read?.description ?? undefined}>{l.ai ? 'AI match, please check: ' : l.suggested ? 'Matched by name, check: ' : 'Paper: '}{printed}</div>}
                </div>
                <span className={styles.right}>{line?.remaining ?? '—'}</span>
                <input className={`${styles.cell} ${styles.qty}`} type="number" min={0} step="1" value={l.qty} onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value) || 0) })} aria-label={`Qty for row ${i + 1}`} />
                <span className={styles.right}>{line ? fmtSen(line.unitPriceSen) : '—'}</span>
                <span className={`${styles.right} ${off ? styles.priceOff : ''}`}>{l.read?.unitPrice != null ? fmtSen(Math.round(l.read.unitPrice * 100)) : '—'}</span>
                <button type="button" className={`${styles.icon} ${styles.caret}`} onClick={() => set({ lines: review.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove row ${i + 1}`}><X size={13} /></button>
              </div>
            );
          })}
          <div className={`${styles.row} ${styles.rowPi} ${styles.rowTotal}`}>
            <span /><span>Total</span><span /><span /><span>{review.lines.length} {review.lines.length === 1 ? 'line' : 'lines'}</span>
            <span className={styles.right}>{qtyTotals.left}</span>
            <span className={styles.right}>{qtyTotals.qty}</span>
            <span className={`${styles.right} ${amountsDiffer ? styles.priceOff : ''}`} title={notMatched ? `Rows tied to a receipt line only${notMatched}` : undefined}>{oursSen == null ? '—' : fmtSen(oursSen)}</span>
            <span className={styles.right}>{invoiceSen == null ? '—' : fmtSen(invoiceSen)}</span>
            <span />
          </div>
          <button type="button" className={styles.addLine} onClick={() => set({ lines: [...review.lines, { key: newPiLineKey(), grnItemId: null, grnNumber: null, qty: 1, suggested: false, read: null }] })}>+ Add line</button>
          {review.lines.some((l) => !l.grnItemId) && <p className={styles.leftOut}>A row with no SKU chosen is left off the draft.</p>}
        </div>
      )}
    </div>
  );
}
