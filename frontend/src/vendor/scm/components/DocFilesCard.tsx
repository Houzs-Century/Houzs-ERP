// ----------------------------------------------------------------------------
// DocFilesCard — the Files card a money document shows for its evidence: the
// voucher's scanned bill (2026-09-03) and, since 2026-09-06, the AP invoice's
// supplier bill (owner: 附件也一起做). One card, two callers — each binds its
// own hooks (list / attach / remove / stream) and words its own rules; the
// card only knows that a LOCKED document keeps its files (remove hidden —
// the server refuses too) and a CLOSED one takes no more (attach hidden).
// sort_no = attach order = the order printing appends the files. View
// streams the bytes through the Worker (authed) into a blob tab — there is
// no public URL to leak.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDate } from '../../shared/format';
import { useConfirm } from './ConfirmDialog';
import { useNotify } from './NotifyDialog';
import { fileToBase64, PV_FILE_ACCEPT, type PvFile, type PvFilePayload } from '../lib/payment-voucher-queries';
import styles from '../../../pages/scm-v2/SalesOrderDetail.module.css';

export type DocFilesCardProps = {
  files: PvFile[];
  canWrite: boolean;
  /** Evidence stays: remove hidden (the server refuses too). */
  locked: boolean;
  /** Takes no more evidence: attach hidden as well. */
  closed: boolean;
  /** Shown after the count while locked, e.g. " · locked with the checked voucher". */
  lockedNote: string;
  emptyNote: string;
  /** The confirm dialog's body before a remove. */
  removeBody: string;
  attachAriaLabel: string;
  uploading: boolean;
  removing: boolean;
  onUpload: (file: PvFilePayload) => Promise<unknown>;
  onRemove: (fileId: string) => Promise<unknown>;
  openUrl: (fileId: string) => Promise<{ url: string }>;
};

const fmtSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const DocFilesCard = ({
  files, canWrite, locked, closed, lockedNote, emptyNote, removeBody, attachAriaLabel, uploading, removing, onUpload, onRemove, openUrl,
}: DocFilesCardProps) => {
  const notify = useNotify();
  const askConfirm = useConfirm();
  const [viewingId, setViewingId] = useState<string | null>(null);

  const view = async (fileId: string, fileName: string) => {
    setViewingId(fileId);
    try {
      const { url } = await openUrl(fileId);
      window.open(url, '_blank', 'noopener');
      /* Revoke AFTER the new tab has loaded the blob — immediate revocation
         races the open and shows a blank tab. */
      setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    } catch (e) {
      void notify({ title: `Couldn't open ${fileName}`, body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setViewingId(null);
    }
  };

  const onPick = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    for (const f of [...list]) {
      try {
        await onUpload({ name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) });
      } catch (e) {
        void notify({ title: `${f.name} did not attach`, body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
        break;
      }
    }
  };

  const onDelete = async (fileId: string, fileName: string) => {
    if (!(await askConfirm({ title: `Remove ${fileName}?`, body: removeBody, confirmLabel: 'Remove file', danger: true }))) return;
    try {
      await onRemove(fileId);
    } catch (e) {
      void notify({ title: 'Not removed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Files</h2>
        {canWrite && !closed && (
          <label style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)', cursor: 'pointer', fontWeight: 600 }}>
            📎 {uploading ? 'Attaching…' : 'Attach file'}
            <input type="file" multiple accept={PV_FILE_ACCEPT}
              aria-label={attachAriaLabel} style={{ display: 'none' }}
              disabled={uploading}
              onChange={(e) => { void onPick(e.target.files); e.target.value = ''; }} />
          </label>
        )}
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          {files.length} file{files.length === 1 ? '' : 's'}{locked ? lockedNote : ''}
        </span>
      </div>
      <div className={styles.cardBody}>
        {files.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', margin: 0 }}>{emptyNote}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map((f) => (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--fs-13)', padding: '4px 0' }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', width: 18, textAlign: 'right' }}>{f.sort_no}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-12)', whiteSpace: 'nowrap' }}>
                  {f.mime === 'application/pdf' ? 'PDF' : 'image'} · {fmtSize(f.size_bytes)} · {fmtDate(f.created_at)}
                </span>
                <Button variant="secondary" size="sm" disabled={viewingId === f.id} onClick={() => void view(f.id, f.file_name)}>
                  {viewingId === f.id ? 'Opening…' : 'View'}
                </Button>
                {canWrite && !locked && !closed && (
                  <button type="button" aria-label={`Remove ${f.file_name}`} disabled={removing}
                    onClick={() => void onDelete(f.id, f.file_name)}
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 }}>
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
