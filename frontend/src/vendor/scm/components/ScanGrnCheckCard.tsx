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
import { useGrnRackOptions } from '../lib/grn-line-rack';
import { SearchableSelect } from './SearchableSelect';
import { fetchDocFileBlobUrl } from '../lib/payment-voucher-queries';
import { writeFailedAs } from '../lib/mutation-error';
import { fmtDate, todayMY } from '../../shared/format';
import {
  fetchSupplierSkus, isOddDate, newLineKey, poOptions, receiptItems, shortNote, skuOptions, printedText, skuValue, swappedDate, warehouseTone,
  type CheckDoc, type SkuOption, type CheckPoLine, type CheckSupplier, type GrnReview, type ReviewLine,
} from '../lib/scan-gr-check';
import styles from './ScanGrnCheck.module.css';
import { openLoadedTab } from '../../../lib/openLoadedTab';

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

/** In the open list an option also says its PO and what is owed. */
export const skuOption = (o: SkuOption) => (o.detail ? `${o.label} · ${o.detail}` : o.label);

/** The racks of the row's warehouse, as on the GRN page. A rack read off the paper
 *  stays shown until it is changed, even if it is not one of them. */
const WH_TONES = [styles.wh0, styles.wh1, styles.wh2, styles.wh3, styles.wh4, styles.wh5, styles.wh6, styles.wh7];

const rackShort = (rack: string): string => rack.replace(/^\s*rack\s*/i, '');
const rackKeyOf = (rack: string): string => rackShort(rack).toUpperCase().replace(/[\s:]/g, '').replace(/[-,_]/g, '.');

/** Labels drop the "Rack " every shelf name starts with: in a narrow cell every
 *  option showed as "Rack...". A rack read off the paper ("L16.1") shows as the
 *  shelf it names ("Rack L16.1"); one that names no shelf ("X") stays as read. */
export function rackCellOptions(value: string | null, racks: ReadonlyArray<{ rack: string }>): { value: string; options: { value: string; label: string }[] } {
  const named = value ? racks.find((r) => rackKeyOf(r.rack) === rackKeyOf(value)) : undefined;
  const options = racks.map((r) => ({ value: r.rack, label: rackShort(r.rack) }));
  if (value && !named) options.unshift({ value, label: value });
  return { value: named?.rack ?? value ?? '', options };
}

function RackCell({ warehouseId, value, onChange, label }: { warehouseId: string | null; value: string | null; onChange: (rack: string | null) => void; label: string }) {
  const { racks } = useGrnRackOptions(warehouseId ?? undefined);
  const cell = rackCellOptions(value, racks);
  return <SearchableSelect value={cell.value} onChange={(v) => onChange(v || null)} options={cell.options} placeholder="Rack" className={styles.cell} ariaLabel={label} />;
}

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
  const warehouses = [...new Set(tied.map((l) => l.warehouse))].filter((w): w is string => Boolean(w));
  const items = receiptItems(review);
  const poList = [...new Set(tied.map((l) => l.poNumber))];
  const pos = poList.join(', ');
  const firstPo = poList[0];
  const morePos = poList.length - 1;
  const repeat = doc.duplicateOf ?? null;
  const today = todayMY();
  const oddDate = isOddDate(review.deliveryDate, today);
  const swapped = swappedDate(review.deliveryDate, today);
  const anyTied = review.lines.some((l) => l.poItemId || l.gift);

  const set = (patch: Partial<GrnReview>) => onChange({ ...review, ...patch });
  const setLine = (key: string, patch: Partial<ReviewLine>) => set({ lines: review.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const viewFile = async () => {
    try {
      await openLoadedTab(async () => (await fetchDocFileBlobUrl(`/scan-gr/check/${doc.id}/file`)).url, 60_000);
    } catch (e) { writeFailedAs('Could not open the file')(e); }
  };
  const pickPo = (key: string, v: string) => {
    const onPo = mine.filter((l) => l.poNumber === v);
    setLine(key, { poNumber: v || null, gift: null, suggested: false, poItemId: onPo.length === 1 ? onPo[0].poItemId : null });
  };
  const pickSku = (key: string, v: string) => {
    if (v.startsWith('gift:')) {
      const code = v.slice(5);
      setLine(key, { poItemId: null, poNumber: null, suggested: false, gift: { itemCode: code, name: skus.data?.find((s) => s.code === code)?.name ?? code } });
    } else {
      const id = v.slice(5);
      setLine(key, { poItemId: id, poNumber: byId.get(id)?.poNumber ?? null, gift: null, suggested: false });
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
          <div className={styles.metaLine}>
            {warehouses.length === 0 ? '—' : warehouses.map((w) => <span key={w} className={`${styles.wh} ${WH_TONES[warehouseTone(w, WH_TONES.length)]}`}>{w}</span>)}
          </div>
          <div className={`${styles.metaLine} ${styles.metaPo} ${styles.mono}`} title={pos}>{firstPo || 'No PO line yet'}{morePos > 0 && ` +${morePos}`}</div>
          <div className={styles.metaPo}>{items} item{items === 1 ? '' : 's'}</div>
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
      {oddDate && (
        <div className={styles.hint}>
          This date is far from today.{' '}
          {swapped && <button type="button" className={styles.bannerLink} onClick={() => set({ deliveryDate: swapped })}>Change to {fmtDate(swapped)}</button>}
        </div>
      )}
      {!anyTied && repeat === null && !doc.duplicateOf && (shortNote(doc.note) ?? block) && <div className={styles.hint}>{shortNote(doc.note) ?? block}</div>}
      {!anyTied && doc.duplicateOf && <div className={styles.hint}>This delivery order is on the goods receipt above, so it has no rows to pick here.</div>}
      {anyTied && block && <div className={styles.hint}>{block}</div>}

      {open && (
        <div className={styles.lines}>
          <div className={`${styles.row} ${styles.rowHead}`}>
            <span>#</span><span>PO</span><span>SKU</span><span>Description</span><span>Rack</span><span className={styles.right}>Owed</span><span className={styles.right}>Qty</span><span />
          </div>
          {review.lines.map((l, i) => {
            const line = l.poItemId ? byId.get(l.poItemId) : undefined;
            const po = l.poNumber ?? line?.poNumber ?? '';
            const printed = l.read ? printedText(l.read) : '';
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
                  renderOption={skuOption}
                />
                <div className={styles.desc}>
                  <div className={styles.metaLine}>{l.gift?.name ?? line?.name ?? '—'}</div>
                  {line?.spec && <div className={styles.metaLine} title={line.spec}>{line.spec}</div>}
                  {printed && <div className={styles.printed} title={l.read?.description ?? undefined}>{l.suggested ? 'Matched by name, check: ' : 'Paper: '}{printed}</div>}
                </div>
                <RackCell warehouseId={line?.warehouseId ?? null} value={l.rack} onChange={(rack) => setLine(l.key, { rack })} label={`Rack for row ${i + 1}`} />
                <span className={styles.right}>{line?.remaining ?? '—'}</span>
                <input className={`${styles.cell} ${styles.qty}`} type="number" min={0} step="1" value={l.qty} onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value) || 0) })} aria-label={`Qty for row ${i + 1}`} />
                <button type="button" className={`${styles.icon} ${styles.caret}`} onClick={() => set({ lines: review.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove row ${i + 1}`}><X size={13} /></button>
              </div>
            );
          })}
          <button type="button" className={styles.addLine} onClick={() => set({ lines: [...review.lines, { key: newLineKey(), poItemId: null, poNumber: null, gift: null, qty: 1, rack: null, suggested: false, read: null }] })}>+ Add line</button>
          {review.lines.some((l) => !l.poItemId && !l.gift) && <p className={styles.leftOut}>A row with no SKU chosen is left off the draft.</p>}
        </div>
      )}
    </div>
  );
}
