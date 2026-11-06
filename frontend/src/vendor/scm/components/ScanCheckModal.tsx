// ----------------------------------------------------------------------------
// ScanCheckModal — upload, check, then create, for any scanned document (owner
// 2026-11-03, after Hookka's scan modal; 2026-11-04, Claude design). Goods
// receipts (ScanGrnModal) and purchase invoices (ScanInvoiceModal) differ only
// in their card and their calls.
//   1. Upload: drop any number of files. The server splits each PDF into its
//      documents and reads every one in the background.
//   2. Check: each document is a card. Edit one, or select several and set their
//      date together. Every edit is saved on the server, so the operator can
//      close this, log out, and come back to the same list. A repeat of a
//      document already made says so; it starts unticked and can still be
//      created or deleted.
//   3. Create: the ticked cards become DRAFT documents. Nothing is posted.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Upload, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { compressForOcr } from '../../shared/image-compress';
import { writeFailedAs } from '../lib/mutation-error';
import { DateField } from './DateField';
import styles from './ScanOrderModal.module.css';
import check from './ScanGrnCheck.module.css';

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';
const isAcceptedFile = (f: File): boolean =>
  /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type) || /\.(jpe?g|png|webp|pdf)$/i.test(f.name);

export type CheckDocBase<R> = { id: string; state: 'reading' | 'pending' | 'failed'; review: R | null; duplicateOf: unknown; repeatOf: string | null };
export type CheckResult = { id: string; ok: boolean; docNumbers: string[]; reason: string | null; note: string | null };
export type CardProps<R, D> = {
  doc: D;
  review: R | null;
  checked: boolean;
  block: string | null;
  onToggle: () => void;
  onChange: (review: R) => void;
  onDelete: () => void;
  onRetry: () => void;
  onGold: () => void;
  onOpenDoc: (path: string) => void;
};

type Props<R, D extends CheckDocBase<R>, P extends { documents: D[] }> = {
  title: string;
  noun: string;
  listName: string;
  listPath: string;
  dropText: string;
  dateLabel: string;
  queryKey: readonly string[];
  listKey: readonly string[];
  api: {
    fetchPending: () => Promise<P>;
    upload: (files: File[]) => Promise<unknown>;
    save: (id: string, review: R) => Promise<unknown>;
    create: (ids: string[]) => Promise<CheckResult[]>;
    discard: (ids: string[]) => Promise<unknown>;
    retry: (id: string) => Promise<unknown>;
    gold: (id: string) => Promise<unknown>;
  };
  blockOf: (review: R, data: P) => string | null;
  withDate: (review: R, date: string) => R;
  onEdit?: (review: R) => void;
  renderCard: (card: CardProps<R, D> & { key: string }, data: P) => ReactNode;
  // What the document receives or bills, counted for the toolbar.
  itemsOf: (review: R) => number;
  onClose: () => void;
};

export function ScanCheckModal<R, D extends CheckDocBase<R>, P extends { documents: D[] }>({
  title, noun, listName, listPath, dropText, dateLabel, queryKey, listKey, api, blockOf, withDate, onEdit, renderCard, itemsOf, onClose,
}: Props<R, D, P>) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [edits, setEdits] = useState<Partial<Record<string, R>>>({});
  const [ticked, setTicked] = useState<Partial<Record<string, boolean>>>({});
  const [bulkDate, setBulkDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /* What is waiting for this user — read on open, so a batch left yesterday comes
     straight back; polled while any document is still being read. */
  const q = useQuery({
    queryKey,
    queryFn: api.fetchPending,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.documents.some((d) => d.state === 'reading') ? 4000 : false),
  });
  // As scanned: the server sends them oldest first, each PDF's documents in page order.
  const docs = useMemo(() => q.data?.documents ?? [], [q.data]);
  const data = q.data;
  const reviewOf = useCallback((id: string) => edits[id] ?? docs.find((d) => d.id === id)?.review ?? null, [edits, docs]);

  // A newly read card starts ticked, unless it repeats a document already made.
  useEffect(() => {
    setTicked((cur) => {
      const next = { ...cur };
      for (const d of docs) if (d.state === 'pending' && next[d.id] === undefined) next[d.id] = !d.duplicateOf && !d.repeatOf;
      return next;
    });
  }, [docs]);

  const showUpload = adding || (!q.isLoading && docs.length === 0 && results.length === 0);
  const refresh = () => qc.invalidateQueries({ queryKey });

  const addFiles = (list: FileList | File[] | null) => {
    const ok = Array.from(list ?? []).filter(isAcceptedFile);
    if (ok.length) setFiles((cur) => [...cur, ...ok]);
  };

  const upload = async () => {
    if (uploading || files.length === 0) return;
    setUploading(true);
    try {
      await api.upload(await Promise.all(files.map((f) => compressForOcr(f))));
      setFiles([]);
      setAdding(false);
      setResults([]);
      await refresh();
    } catch (e) {
      writeFailedAs('The files were not uploaded')(e);
    } finally {
      setUploading(false);
    }
  };

  // Each edit shows at once and is saved on the server shortly after.
  const edit = (id: string, review: R) => {
    setEdits((cur) => ({ ...cur, [id]: review }));
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => { api.save(id, review).catch(writeFailedAs('That change was not saved')); }, 600);
    onEdit?.(review);
  };
  // Saves still waiting go out before anything is created or the window shuts.
  const flush = async () => {
    const waiting = Object.entries(timers.current);
    timers.current = {};
    for (const [, t] of waiting) clearTimeout(t);
    await Promise.all(waiting.map(([id]) => { const r = edits[id]; return r ? api.save(id, r) : null; }));
  };
  useEffect(() => () => { for (const t of Object.values(timers.current)) clearTimeout(t); }, []);

  const pending = docs.filter((d) => d.state === 'pending');
  const block = (id: string) => { const r = reviewOf(id); return r && q.data ? blockOf(r, q.data) : 'Still reading.'; };
  const selected = pending.filter((d) => ticked[d.id]);
  const creatable = selected.filter((d) => !block(d.id));
  const items = selected.reduce((sum, d) => { const r = reviewOf(d.id); return sum + (r ? itemsOf(r) : 0); }, 0);
  const reading = docs.filter((d) => d.state === 'reading').length;

  const remove = async (ids: string[]) => {
    try {
      await api.discard(ids);
      setEdits((cur) => { const n = { ...cur }; for (const id of ids) delete n[id]; return n; });
      await refresh();
    } catch (e) { writeFailedAs('Could not delete')(e); }
  };

  const create = async () => {
    if (creating || creatable.length === 0) return;
    setCreating(true);
    try {
      await flush();
      const res = await api.create(creatable.map((d) => d.id));
      setResults(res);
      setEdits((cur) => { const n = { ...cur }; for (const r of res) if (r.ok) delete n[r.id]; return n; });
      await refresh();
      void qc.invalidateQueries({ queryKey: listKey });
    } catch (e) {
      writeFailedAs(`The ${noun}s were not created`)(e);
    } finally {
      setCreating(false);
    }
  };

  const applyBulkDate = () => {
    if (!bulkDate) return;
    for (const d of selected) { const r = reviewOf(d.id); if (r) edit(d.id, withDate(r, bulkDate)); }
  };

  const close = () => { void flush(); onClose(); };
  const made = results.flatMap((r) => r.docNumbers);
  const refused = results.filter((r) => !r.ok);
  const notes = results.flatMap((r) => (r.note ? [r.note] : []));

  return (
    <div className={styles.modal} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles.panel} style={{ maxWidth: 1240, width: '96vw' }}>
        <div className={styles.head} style={{ alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1, flexWrap: 'wrap' }}>
            <h2 className={styles.title} style={{ margin: 0 }}>{title}</h2>
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
              {selected.length} of {pending.length} selected · {items} item{items === 1 ? '' : 's'}{reading > 0 ? ` · ${reading} still reading` : ''}
            </label>
            <span style={{ flex: 1 }} />
            {selected.length > 1 && (
              <>
                <span>{dateLabel} for selected</span>
                <DateField value={bulkDate} onChange={setBulkDate} aria-label={`${dateLabel} for selected`} />
                <Button variant="secondary" size="sm" onClick={applyBulkDate} disabled={!bulkDate}>Apply</Button>
              </>
            )}
            {selected.length > 0 && <Button variant="secondary" size="sm" onClick={() => void remove(selected.map((d) => d.id))}>Delete selected</Button>}
            <Button variant="secondary" size="sm" onClick={() => void remove(docs.map((d) => d.id))}>Clear all</Button>
          </div>
        )}

        <div className={styles.body}>
          {q.error && <div className={styles.error}>Could not load your scans: {q.error.message}</div>}

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
                <div>{dropText}</div>
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
                      <div className={styles.resultMain}>{made.length} draft {noun}{made.length === 1 ? '' : 's'}: {made.join(', ')}. Open each from the {listName} to post it.</div>
                    </div>
                  )}
                  {notes.map((n) => (
                    <div key={n} className={styles.resultRow}>
                      <span className={`${styles.chip} ${styles.chipGreen}`}>Note</span>
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
                {data && docs.map((d) => renderCard({
                  key: d.id,
                  doc: d,
                  review: reviewOf(d.id),
                  checked: !!ticked[d.id],
                  block: d.state === 'pending' ? block(d.id) : null,
                  onToggle: () => setTicked((cur) => ({ ...cur, [d.id]: !cur[d.id] })),
                  onChange: (r) => edit(d.id, r),
                  onDelete: () => void remove([d.id]),
                  onOpenDoc: (path) => { close(); navigate(path); },
                  onGold: () => { api.gold(d.id).then(refresh).catch(writeFailedAs('Could not mark it as gold')); },
                  onRetry: () => { api.retry(d.id).then(refresh).catch(writeFailedAs('Could not read it again')); },
                }, data))}
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
              {made.length > 0 && <Button variant="secondary" size="sm" onClick={() => { close(); navigate(listPath); }}>Go to the {listName}</Button>}
              <Button variant="primary" size="sm" onClick={() => void create()} disabled={creating || creatable.length === 0}>
                {creating ? 'Creating…' : `Create ${creatable.length} ${noun}${creatable.length === 1 ? '' : 's'} as draft`}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
