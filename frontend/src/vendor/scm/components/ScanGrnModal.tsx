// ----------------------------------------------------------------------------
// ScanGrnModal — "Scan Delivery Order" on the Goods Receipt list: upload,
// check, then create (owner 2026-11-03, after Hookka's scan modal).
//   1. Upload: drop any number of files — one PDF holding twenty delivery
//      orders, or twenty files. The server splits each PDF into its documents
//      and reads every one in the background (POST /scan-gr/check/upload).
//   2. Check: each delivery order is a card — supplier, D.O. no, date, and the
//      lines with the PO line each receives into. Edit one, or select several
//      and set their date together. Every edit is saved on the server, so the
//      operator can close this, log out, and come back to the same list.
//      One already received under another goods receipt says so ("Already
//      HC-GRN-…"); it starts unticked and can still be created or deleted.
//   3. Create: the ticked cards become DRAFT goods receipts, converted from
//      their PO lines. Nothing posts stock until the draft is posted.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { compressForOcr } from '../../shared/image-compress';
import { writeFailedAs } from '../lib/mutation-error';
import {
  PENDING_KEY, createFromScans, discardScans, fetchPending, fetchPoLines, localBlock, markGold, retryScan, saveReview, uploadScans,
  type CheckPoLine, type CreateResult, type GrnReview,
} from '../lib/scan-gr-check';
import { DateField } from './DateField';
import { ScanGrnCheckCard } from './ScanGrnCheckCard';
import styles from './ScanOrderModal.module.css';
import check from './ScanGrnCheck.module.css';

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';
const isAcceptedFile = (f: File): boolean =>
  /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type) || /\.(jpe?g|png|webp|pdf)$/i.test(f.name);

export function ScanGrnModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [edits, setEdits] = useState<Partial<Record<string, GrnReview>>>({});
  const [ticked, setTicked] = useState<Partial<Record<string, boolean>>>({});
  const [extraLines, setExtraLines] = useState<CheckPoLine[]>([]);
  const [bulkDate, setBulkDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<CreateResult[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /* What is waiting for this user — read on open, so a batch left yesterday comes
     straight back; polled while any document is still being read. */
  const q = useQuery({
    queryKey: PENDING_KEY,
    queryFn: fetchPending,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.data.documents.some((d) => d.state === 'reading') ? 4000 : false),
  });
  const docs = useMemo(() => q.data?.data.documents ?? [], [q.data]);
  const suppliers = q.data?.data.suppliers ?? [];
  const poLines = useMemo(() => {
    const m = new Map<string, CheckPoLine>();
    for (const l of [...(q.data?.data.poLines ?? []), ...extraLines]) m.set(l.poItemId, l);
    return m;
  }, [q.data, extraLines]);
  const reviewOf = useCallback((id: string) => edits[id] ?? docs.find((d) => d.id === id)?.review ?? null, [edits, docs]);

  // A newly read card starts ticked, unless it repeats a receipt already made.
  useEffect(() => {
    setTicked((cur) => {
      const next = { ...cur };
      for (const d of docs) if (d.state === 'pending' && next[d.id] === undefined) next[d.id] = !d.duplicateOf && !d.repeatOf;
      return next;
    });
  }, [docs]);

  const showUpload = adding || (!q.isLoading && docs.length === 0 && results.length === 0);

  const addFiles = (list: FileList | File[] | null) => {
    const ok = Array.from(list ?? []).filter(isAcceptedFile);
    if (ok.length) setFiles((cur) => [...cur, ...ok]);
  };

  const upload = async () => {
    if (uploading || files.length === 0) return;
    setUploading(true);
    try {
      const ready = await Promise.all(files.map((f) => compressForOcr(f)));
      await uploadScans(ready);
      setFiles([]);
      setAdding(false);
      setResults([]);
      await qc.invalidateQueries({ queryKey: PENDING_KEY });
    } catch (e) {
      writeFailedAs('The files were not uploaded')(e);
    } finally {
      setUploading(false);
    }
  };

  // Each edit shows at once and is saved on the server shortly after.
  const edit = (id: string, review: GrnReview) => {
    setEdits((cur) => ({ ...cur, [id]: review }));
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => { saveReview(id, review).catch(writeFailedAs('That change was not saved')); }, 600);
    if (review.supplierId && ![...poLines.values()].some((l) => l.supplierId === review.supplierId)) {
      fetchPoLines(review.supplierId).then((ls) => setExtraLines((cur) => [...cur, ...ls])).catch(writeFailedAs('Could not load that supplier\'s PO lines'));
    }
  };
  // Saves still waiting go out before anything is created or the window shuts.
  const flush = async () => {
    const pending = Object.entries(timers.current);
    timers.current = {};
    for (const [, t] of pending) clearTimeout(t);
    await Promise.all(pending.map(([id]) => { const r = edits[id]; return r ? saveReview(id, r) : null; }));
  };
  useEffect(() => () => { for (const t of Object.values(timers.current)) clearTimeout(t); }, []);

  const pending = docs.filter((d) => d.state === 'pending');
  const blockOf = (id: string) => { const r = reviewOf(id); return r ? localBlock(r, poLines) : 'Still reading.'; };
  const selected = pending.filter((d) => ticked[d.id]);
  const creatable = selected.filter((d) => !blockOf(d.id));
  const reading = docs.filter((d) => d.state === 'reading').length;

  const remove = async (ids: string[]) => {
    try {
      await discardScans(ids);
      setEdits((cur) => { const n = { ...cur }; for (const id of ids) delete n[id]; return n; });
      await qc.invalidateQueries({ queryKey: PENDING_KEY });
    } catch (e) { writeFailedAs('Could not delete')(e); }
  };

  const create = async () => {
    if (creating || creatable.length === 0) return;
    setCreating(true);
    try {
      await flush();
      const res = await createFromScans(creatable.map((d) => d.id));
      setResults(res);
      setEdits((cur) => { const n = { ...cur }; for (const r of res) if (r.ok) delete n[r.id]; return n; });
      await qc.invalidateQueries({ queryKey: PENDING_KEY });
      void qc.invalidateQueries({ queryKey: ['grns'] });
    } catch (e) {
      writeFailedAs('The goods receipts were not created')(e);
    } finally {
      setCreating(false);
    }
  };

  const applyBulkDate = () => {
    if (!bulkDate) return;
    for (const d of selected) { const r = reviewOf(d.id); if (r) edit(d.id, { ...r, deliveryDate: bulkDate }); }
  };

  const close = () => { void flush(); onClose(); };
  const made = results.filter((r) => r.ok).flatMap((r) => r.grnNumbers ?? []);
  const refused = results.filter((r) => !r.ok);
  const giftNotes = results.flatMap((r) => (r.giftNote ? [r.giftNote] : []));

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles.panel} style={{ maxWidth: 1240, width: '96vw' }}>
        <div className={styles.head} style={{ alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1, flexWrap: 'wrap' }}>
            <h2 className={styles.title} style={{ margin: 0 }}>Scan delivery orders</h2>
            <div className={check.steps}>
              {['Upload', 'Check', 'Create'].map((s, i) => {
                const at = showUpload ? 0 : results.length > 0 && pending.length === 0 ? 2 : 1;
                return <span key={s} style={{ display: 'contents' }}>{i > 0 && <span className={check.stepLine} />}<span className={i === at ? check.stepOn : ''}>{s}</span></span>;
              })}
            </div>
          </div>
          <button type="button" className={styles.closeBtn} onClick={close} aria-label="Close"><X size={18} strokeWidth={1.75} /></button>
        </div>

        {!showUpload && docs.length > 0 && (
          <div className={check.toolbar}>
            <label className={check.selectAll}>
              <input type="checkbox" checked={pending.length > 0 && selected.length === pending.length} onChange={(e) => setTicked(Object.fromEntries(pending.map((d) => [d.id, e.target.checked])))} />
              {selected.length} of {pending.length} selected{reading > 0 ? ` · ${reading} still reading` : ''}
            </label>
            <span style={{ flex: 1 }} />
            {selected.length > 1 && (
              <>
                <span>Received date for selected</span>
                <DateField value={bulkDate} onChange={setBulkDate} aria-label="Received date for selected" />
                <Button variant="secondary" size="sm" onClick={applyBulkDate} disabled={!bulkDate}>Apply</Button>
              </>
            )}
            {selected.length > 0 && <Button variant="secondary" size="sm" onClick={() => void remove(selected.map((d) => d.id))}>Delete selected</Button>}
            <Button variant="secondary" size="sm" onClick={() => void remove(docs.map((d) => d.id))}>Clear all</Button>
          </div>
        )}

        <div className={styles.body}>
          {q.error && <div className={styles.error}>Could not load your scans: {(q.error as Error).message}</div>}

          {showUpload && (
            <>
              <input ref={inputRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
              <div
                className={`${styles.slotZone} ${dragOver ? styles.slotZoneActive : ''}`}
                onClick={() => { if (!uploading) inputRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              >
                <Upload size={22} strokeWidth={1.5} />
                <div>Drop delivery orders here, or click — PDF, JPEG, PNG, WEBP. A PDF with many delivery orders is split for you.</div>
              </div>
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className={styles.slotFilled}>
                  <span className={styles.slotFileName}>{f.name}</span>
                  {!uploading && <button type="button" className={styles.removeBtn} onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`}><X size={14} /></button>}
                </div>
              ))}
            </>
          )}

          {!showUpload && (
            <>
              {(made.length > 0 || refused.length > 0) && (
                <div className={styles.results}>
                  {made.length > 0 && (
                    <div className={styles.resultRow}>
                      <span className={`${styles.chip} ${styles.chipTeal}`}><CheckCircle2 size={11} /> Created</span>
                      <div className={styles.resultMain}>{made.length} draft goods receipt{made.length === 1 ? '' : 's'}: {made.join(', ')}. Open each from the Goods Receipt list to post it.</div>
                    </div>
                  )}
                  {giftNotes.map((n) => (
                    <div key={n} className={styles.resultRow}>
                      <span className={`${styles.chip} ${styles.chipGreen}`}>Free gift</span>
                      <div className={styles.resultMain}>{n}</div>
                    </div>
                  ))}
                  {refused.map((r) => (
                    <div key={r.id} className={styles.resultRow}>
                      <span className={`${styles.chip} ${styles.chipYellow}`}>Not created</span>
                      <div className={styles.resultMain}>{r.reason}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className={check.list}>
              {docs.map((d) => (
                <ScanGrnCheckCard
                  key={d.id}
                  doc={d}
                  review={reviewOf(d.id)}
                  suppliers={suppliers}
                  poLines={[...poLines.values()]}
                  checked={!!ticked[d.id]}
                  block={d.state === 'pending' ? blockOf(d.id) : null}
                  onToggle={() => setTicked((cur) => ({ ...cur, [d.id]: !cur[d.id] }))}
                  onChange={(r) => edit(d.id, r)}
                  onDelete={() => void remove([d.id])}
                  onOpenGrn={(id) => { close(); navigate(`/scm/grns/${id}`); }}
                  onGold={() => { markGold(d.id).then(() => qc.invalidateQueries({ queryKey: PENDING_KEY })).catch(writeFailedAs('Could not mark it as gold')); }}
                  onRetry={() => { retryScan(d.id).then(() => qc.invalidateQueries({ queryKey: PENDING_KEY })).catch(writeFailedAs('Could not read it again')); }}
                />
              ))}
              </div>
              {docs.length === 0 && results.length > 0 && <p className={styles.sub}>Every scan you uploaded in the last 14 days has been created or deleted.</p>}
            </>
          )}
        </div>

        <div className={styles.foot}>
          {showUpload ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => (docs.length > 0 ? setAdding(false) : close())}>{docs.length > 0 ? 'Back to the list' : 'Cancel'}</Button>
              <Button variant="primary" size="sm" onClick={() => void upload()} disabled={uploading || files.length === 0}>
                {uploading ? 'Uploading and splitting…' : `Read ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>+ Add files</Button>
              {made.length > 0 && <Button variant="secondary" size="sm" onClick={() => { close(); navigate('/scm/grns'); }}>Go to Goods Receipts</Button>}
              <Button variant="primary" size="sm" onClick={() => void create()} disabled={creating || creatable.length === 0}>
                {creating ? 'Creating…' : `Create ${creatable.length} goods receipt${creatable.length === 1 ? '' : 's'} as draft`}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
