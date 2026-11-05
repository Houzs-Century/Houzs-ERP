// ----------------------------------------------------------------------------
// NotePage — a credit or debit note as its own document page in the owner's
// Claude Design (batch 4 step 6): /scm/supplier-notes/:id under Money out and
// /scm/credit-notes/:id under Money in. The same note the CN / DN page's
// pop-out shows (CreditNotes.tsx — useNoteDoc, NoteActions, NoteBody: Print,
// Edit, Post to ledger, Cancel note, Knock off, files), on a page with Back to
// where it was opened, Add task, and a trail from its stamps. Posting is
// unchanged.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ListPlus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { fmtDateTime } from '../../vendor/shared/format';
import { returnToWorkspaceOpener, useWorkspaceOpener } from '../../lib/useWorkspaceOpener';
import { KIND_WORD, NoteActions, NoteBody, NoteForm, noteEditValues, useNoteDoc, type FormValues } from './CreditNotes';
import { VoucherTaskDrawer } from './PvDocParts';
import styles from './SalesOrderDetail.module.css';
import mo from './MoneyOut.module.css';

export function NotePage({ side }: { side: 'AR' | 'AP' }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const cameFrom = useWorkspaceOpener();
  const doc = useNoteDoc(id);
  const [editing, setEditing] = useState<FormValues | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const n = doc.n;
  const area = side === 'AP' ? 'Finance · Money out' : 'Finance · Money in';

  if (doc.q.isLoading) return <div className={mo.hint}>Reading the note…</div>;
  if (doc.q.isError || !n) {
    return (
      <div className="space-y-4">
        <PageHeader back eyebrow={area} title="Note" />
        <div className={mo.hint} role="alert">The note did not load — {doc.q.error instanceof Error ? doc.q.error.message : 'it is not in the company you are working in.'}</div>
      </div>
    );
  }

  /* A supplier's or other debtor's note says whether its credit is used (the design's To use / Used). */
  const left = doc.q.data?.leftSen;
  const tag = n.status === 'CANCELLED' ? { text: 'Cancelled', tone: mo.toneCalm }
    : n.status === 'DRAFT' ? { text: 'Draft', tone: mo.toneCalm }
      : left != null ? (left > 0 ? { text: 'To use', tone: mo.toneInfo } : { text: 'Used', tone: mo.toneCalm })
        : { text: 'Posted', tone: mo.toneCalm };
  const path = `/scm/${side === 'AP' ? 'supplier-notes' : 'credit-notes'}/${n.id}`;

  return (
    <div className="space-y-4">
      <PageHeader back
        beforeBack={() => {
          /* Opened as a document from another page: back to THAT page and its tab. */
          const href = cameFrom ? returnToWorkspaceOpener() : null;
          if (href) { navigate(href); return false; }
          return true;
        }}
        eyebrow={KIND_WORD[n.kind]}
        title={n.note_number}
        actions={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span className={`${mo.tag} ${tag.tone}`}>{tag.text}</span>
            <NoteActions doc={doc} onEdit={(note, lines, allocations) => setEditing(noteEditValues(note, lines, allocations))} />
            <Button variant="ghost" size="sm" onClick={() => setAddingTask(true)}><ListPlus size={16} strokeWidth={1.75} /> Add task</Button>
          </div>
        )}
      />

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <NoteBody doc={doc} />
        </div>
      </section>

      {/* The trail from the note's own stamps (notes write no entity audit). */}
      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Trail</h2></div>
        <div className={styles.cardBody}>
          <ol className={mo.trail}>
            <li><b>Raised</b><span className={mo.trailWho}> · {n.created_by ?? 'System'} · {fmtDateTime(n.created_at)}</span></li>
            {n.posted_at && <li><b>Posted</b><span className={mo.trailWho}> · {fmtDateTime(n.posted_at)}</span>{n.je_no && <div className={mo.trailNote}>{n.je_no}</div>}</li>}
            {(doc.allocations).map((a) => (
              <li key={a.id}><b>Knocked off {a.number ?? 'a bill'}</b><span className={mo.trailWho}>{a.createdBy ? ` · ${a.createdBy}` : ''}{a.createdAt ? ` · ${fmtDateTime(a.createdAt)}` : ''}</span></li>
            ))}
            {n.cancelled_at && <li><b>Cancelled</b><span className={mo.trailWho}> · {fmtDateTime(n.cancelled_at)}</span></li>}
          </ol>
        </div>
      </section>

      {addingTask && (
        <VoucherTaskDrawer onClose={() => setAddingTask(false)}
          link={{ type: KIND_WORD[n.kind], no: n.note_number, name: n.party_name ?? '', to: path }} />
      )}
      {editing && (
        <NoteForm mode="edit" id={n.id} kinds={[n.kind]} initial={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
      )}
    </div>
  );
}
