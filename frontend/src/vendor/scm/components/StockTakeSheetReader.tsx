// Upload the counted paper sheet (owner 2026-10-06: print the count sheet, count
// on paper, photo it, the counts and racks come back). Each page is read on its
// own (POST /stock-takes/:id/read-sheet — writes nothing), three at a time; the
// proposals are shown against what the sheet holds now, and only the ticked
// ones are applied to the on-screen sheet. Saving is the usual Save Counts.
import { useState } from 'react';
import { Camera, Check } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { readStockTakeSheet, type SheetProposal, type SheetUnmatched } from '../lib/stock-queries';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

const READ_AT_ONCE = 3;
const MAX_EDGE = 2400; // px — sharp enough for handwriting, small enough for the reader

export type SheetApply = { lineId: string; counted: number | null; rackId: string | null };

type Picked = SheetProposal & { page: number; apply: boolean };

/* A phone photo is 3–8 MB; the reader takes ~5 MB an image. Re-encode an image
   to JPEG at most MAX_EDGE on its long side; a PDF goes as it is. */
async function toUpload(file: File): Promise<{ name: string; mime: string; dataBase64: string }> {
  const asBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
  if (file.type === 'application/pdf') return { name: file.name, mime: file.type, dataBase64: await asBase64(file) };
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo.'))), 'image/jpeg', 0.85));
  return { name: file.name, mime: 'image/jpeg', dataBase64: await asBase64(blob) };
}

const REASON: Record<SheetUnmatched['reason'], string> = {
  not_on_sheet: 'not on this take',
  ambiguous_code: 'several lines have this code — type it on the right line',
  duplicate_row: 'this line was already read',
  no_code: 'no item code could be read',
};

export function StockTakeSheetReader({
  takeId, takeNo, current, rackLabel, onApply, onClose,
}: {
  takeId: string;
  takeNo: string;
  /* What the on-screen sheet holds now, per line id. */
  current: ReadonlyMap<string, { counted: string; rackId: string | null }>;
  rackLabel: (rackId: string | null) => string;
  onApply: (rows: SheetApply[]) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [unmatched, setUnmatched] = useState<Array<SheetUnmatched & { page: number }>>([]);
  const [pageNotes, setPageNotes] = useState<string[]>([]);

  const readAll = async () => {
    setBusy(true); setDone(0); setPicked([]); setUnmatched([]); setPageNotes([]);
    const results: Array<{ page: number; proposals: SheetProposal[]; unmatched: SheetUnmatched[] } | null> = new Array(files.length).fill(null);
    const notes: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        try {
          const r = await readStockTakeSheet(takeId, await toUpload(files[i]!));
          if (r.takeNoMatches === false) {
            notes.push(`Page ${i + 1} is ${r.takeNoRead ?? 'another stock take'}, not ${takeNo} — nothing taken from it.`);
          }
          results[i] = { page: i + 1, proposals: r.proposals, unmatched: r.unmatched };
        } catch (e) {
          notes.push(`Page ${i + 1} could not be read: ${e instanceof Error ? e.message : 'unknown error'}. Read it again.`);
        }
        setDone((d) => d + 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, files.length) }, worker));
    /* One line read on two pages (a page photographed twice): the first wins,
       the second is shown as already read. */
    const seen = new Set<string>();
    const nextPicked: Picked[] = [];
    const nextUnmatched: Array<SheetUnmatched & { page: number }> = [];
    for (const r of results) {
      if (!r) continue;
      for (const p of r.proposals) {
        if (seen.has(p.lineId)) {
          nextUnmatched.push({ no: p.no, itemCode: p.itemCode, counted: p.counted, rackText: p.rackText, reason: 'duplicate_row', page: r.page });
          continue;
        }
        seen.add(p.lineId);
        nextPicked.push({ ...p, page: r.page, apply: !p.unclear && (p.counted != null || p.rackId != null) });
      }
      nextUnmatched.push(...r.unmatched.map((u) => ({ ...u, page: r.page })));
    }
    setPicked(nextPicked); setUnmatched(nextUnmatched); setPageNotes(notes); setBusy(false);
  };

  const ticked = picked.filter((p) => p.apply);

  return (
    <div role="dialog" aria-label="Upload counted sheet" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
    }}>
      <div className={styles.card} style={{ width: 'min(980px, 100%)' }}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Upload counted sheet — {takeNo}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className={styles.cardBody}>
          <p style={{ marginTop: 0, fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
            Photo every page of the printed sheet you counted on. The handwritten Counted and Rack are read and
            shown below against what this take holds — nothing is saved until you apply them and press Save Counts.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept="image/*,application/pdf" multiple aria-label="Sheet pages"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
            <Button variant="secondary" size="md" disabled={busy || files.length === 0} onClick={() => { void readAll(); }}>
              <Camera size={14} strokeWidth={1.75} />
              {busy ? `Reading ${done}/${files.length}…` : `Read ${files.length || ''} page${files.length === 1 ? '' : 's'}`}
            </Button>
          </div>

          {pageNotes.map((n) => (
            <div key={n} style={{ marginTop: 8, color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>{n}</div>
          ))}

          {picked.length > 0 && (
            <table className={`${styles.table} ${styles.tableOwnWidths}`} style={{ marginTop: 'var(--space-3)' }}>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>Use</th>
                  <th style={{ width: 50 }}>Page</th>
                  <th>Item</th>
                  <th style={{ width: 110, textAlign: 'right' }}>Now</th>
                  <th style={{ width: 110, textAlign: 'right' }}>Read</th>
                  <th style={{ width: 160 }}>Rack read</th>
                </tr>
              </thead>
              <tbody>
                {picked.map((p) => {
                  const now = current.get(p.lineId);
                  return (
                    <tr key={p.lineId} style={p.unclear ? { background: 'rgba(184,51,31,0.06)' } : undefined}>
                      <td>
                        <input type="checkbox" checked={p.apply} aria-label={`Use the reading for ${p.itemCode}`}
                          onChange={(e) => setPicked((cur) => cur.map((x) => x.lineId === p.lineId ? { ...x, apply: e.target.checked } : x))} />
                      </td>
                      <td>{p.page}{p.no != null ? ` · #${p.no}` : ''}</td>
                      <td>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{p.itemCode}</span>
                        {p.variantLabel && <div style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>{p.variantLabel}</div>}
                        {p.unclear && <div style={{ fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>Hard to read — check the paper</div>}
                      </td>
                      <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)' }}>
                        {now?.counted || '—'}{now?.rackId ? <div style={{ fontSize: 'var(--fs-11)' }}>{rackLabel(now.rackId)}</div> : null}
                      </td>
                      <td className={styles.tableRight} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                        {p.counted ?? '—'}
                      </td>
                      <td style={{ fontSize: 'var(--fs-12)' }}>
                        {p.rackText == null ? '—'
                          : p.rackId ? rackLabel(p.rackId)
                          : <span style={{ color: 'var(--c-festive-b, #B8331F)' }}>"{p.rackText}" is not a rack here</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {unmatched.length > 0 && (
            <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
              <strong>Not applied — enter these by hand ({unmatched.length}):</strong>
              <ul style={{ margin: '4px 0 0 18px' }}>
                {unmatched.map((u, i) => (
                  <li key={`${u.page}-${i}`}>
                    Page {u.page}{u.no != null ? ` #${u.no}` : ''} {u.itemCode ?? ''} — counted {u.counted ?? '—'}
                    {u.rackText ? `, rack ${u.rackText}` : ''}: {REASON[u.reason]}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {picked.length > 0 && (
            <div style={{ marginTop: 'var(--space-3)', display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="primary" size="md" disabled={ticked.length === 0}
                onClick={() => {
                  onApply(ticked.map((p) => ({ lineId: p.lineId, counted: p.counted, rackId: p.rackId })));
                  onClose();
                }}>
                <Check size={14} strokeWidth={1.75} /> Apply {ticked.length} to the sheet
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
