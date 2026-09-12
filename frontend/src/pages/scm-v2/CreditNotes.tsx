// ----------------------------------------------------------------------------
// CreditNotes — /scm/credit-notes (owner 2026-09-05: CN/DN approved; 2026-09-12:
// 这个要做). One page for the three notes: CN to a customer (they owe less),
// DN to a customer (they owe more), SCN from a supplier (we owe less). A note
// is raised as a DRAFT — the customer from the sales order or the invoice it
// answers, or the name typed; the supplier picked — with lines that land on
// RETURN INWARDS / PURCHASES RETURN unless the line says otherwise, then
// posted through the one gate, or cancelled (contra). The server refuses
// what it refuses; this page only shows the reason.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { Modal } from '../../vendor/scm/components/Modal';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { DateField } from '../../vendor/scm/components/DateField';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAccounts, leafAccounts } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useCreditNotes, useCreditNoteDetail, useCreateCreditNote, useUpdateCreditNote, usePostCreditNote, useCancelCreditNote,
  type CreditNote, type CreditNoteLineInput, type NoteKind, type NoteStatus,
} from '../../vendor/scm/lib/credit-note-queries';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';

const KIND_WORD: Record<NoteKind, string> = { CN: 'Credit note', DN: 'Debit note', SCN: 'Supplier credit note' };
/* The kind filter's tabs, off the one label map — not a second list of kinds. */
const KIND_TABS: Array<NoteKind | 'ALL'> = ['ALL', ...(Object.keys(KIND_WORD) as NoteKind[])];
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 0, overflowX: 'auto' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-13)', borderBottom: '1px solid var(--border-weak, #f0eee8)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, minWidth: 180 };

type FormLine = { rid: number; description: string; accountCode: string; amountRm: string };
type FormValues = {
  kind: NoteKind; noteDate: string; soDocNo: string; partyName: string; supplierId: string;
  sourceDocNo: string; reason: string; lines: FormLine[];
};
const emptyLine = (rid: number): FormLine => ({ rid, description: '', accountCode: '', amountRm: '' });
const emptyForm = (kind: NoteKind = 'CN'): FormValues => ({ kind, noteDate: myt(), soDocNo: '', partyName: '', supplierId: '', sourceDocNo: '', reason: '', lines: [emptyLine(1)] });
const toSen = (rm: string): number => Math.round(Number(rm) * 100);

/* The body the server takes, off the form — the lines with a sen amount; an
   account left blank lets the server land it on the kind's default. */
export const bodyOf = (v: FormValues): { kind: NoteKind; noteDate: string; reason: string | null; sourceDocNo: string | null; soDocNo?: string; partyName?: string; supplierId?: string; lines: CreditNoteLineInput[] } => ({
  kind: v.kind,
  noteDate: v.noteDate,
  reason: v.reason.trim() || null,
  sourceDocNo: v.sourceDocNo.trim() || null,
  ...(v.kind === 'SCN' ? { supplierId: v.supplierId } : v.soDocNo.trim() ? { soDocNo: v.soDocNo.trim() } : { partyName: v.partyName.trim() }),
  lines: v.lines
    .filter((l) => l.amountRm.trim() !== '')
    .map((l) => ({ description: l.description.trim() || null, accountCode: l.accountCode || null, amountSen: toSen(l.amountRm) })),
});

const StatusPill = ({ status }: { status: NoteStatus }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', color: status === 'POSTED' ? good : status === 'CANCELLED' ? danger : 'var(--fg-muted)' }}>
    {status}
  </span>
);

export const CreditNotes = () => {
  const [kind, setKind] = useState<NoteKind | 'ALL'>('ALL');
  const [status, setStatus] = useState<NoteStatus | 'ALL'>('ALL');
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: 'new' | 'edit'; id?: string; values: FormValues } | null>(null);
  const listQ = useCreditNotes(kind, status);
  const rows = listQ.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Credit & Debit Notes"
        description="A credit note to a customer, a debit note to a customer, a credit note from a supplier. Raised as a draft, posted to the ledger, cancelled by contra."
        primaryAction={<Button size="sm" onClick={() => setForm({ mode: 'new', values: emptyForm() })}><Plus size={16} strokeWidth={1.75} /> New note</Button>} />
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="tablist" aria-label="Note kind" style={{ display: 'inline-flex', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, overflow: 'hidden' }}>
          {KIND_TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              style={{ padding: '4px 12px', fontSize: 'var(--fs-12)', border: 'none', cursor: 'pointer', background: kind === k ? 'var(--c-ink, #221f20)' : 'transparent', color: kind === k ? '#fff' : 'inherit' }}>
              {k === 'ALL' ? 'All' : k}
            </button>
          ))}
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as NoteStatus | 'ALL')} aria-label="Note status" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
          <option value="ALL">Any status</option>
          <option value="DRAFT">Draft</option>
          <option value="POSTED">Posted</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <span style={soft}>CN: the customer owes less. DN: the customer owes more. SCN: we owe the supplier less.</span>
      </div>

      {listQ.isLoading && <div style={soft}>Loading…</div>}
      {listQ.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The list did not load — {errText(listQ.error)}</div>}
      {listQ.data && rows.length === 0 && <div style={soft}>No note yet. New note raises one.</div>}
      {rows.length > 0 && (
        <div style={card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Number</th><th style={th}>Kind</th><th style={th}>Date</th><th style={th}>Party</th><th style={th}>Reference</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th><th style={th}>Status</th><th style={th}>Journal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id} onClick={() => setOpenId(n.id)} style={{ cursor: 'pointer' }} data-note={n.note_number}>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{n.note_number}</td>
                  <td style={td}>{n.kind}</td>
                  <td style={td}>{fmtDateOrDash(n.note_date)}</td>
                  <td style={td}>{n.party_name ?? n.party_code ?? '—'}</td>
                  <td style={td}>{[n.so_doc_no, n.source_doc_no].filter(Boolean).join(' · ') || '—'}</td>
                  <td style={{ ...td, ...num }}>{fmtSen(n.total_sen)}</td>
                  <td style={td}><StatusPill status={n.status} /></td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{n.je_no ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && (
        <NoteDetail id={openId} onClose={() => setOpenId(null)}
          onEdit={(n, lines) => {
            setForm({
              mode: 'edit', id: n.id,
              values: {
                kind: n.kind, noteDate: n.note_date, soDocNo: n.so_doc_no ?? '', partyName: n.party_name ?? '', supplierId: n.supplier_id ?? '',
                sourceDocNo: n.source_doc_no ?? '', reason: n.reason ?? '',
                lines: lines.length > 0 ? lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', accountCode: l.account_code, amountRm: (l.amount_sen / 100).toFixed(2) })) : [emptyLine(1)],
              },
            });
            setOpenId(null);
          }} />
      )}
      {form && <NoteForm mode={form.mode} id={form.id} initial={form.values} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); setOpenId(id); }} />}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
    {label}
    {children}
  </label>
);

const NoteDetail = ({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (n: CreditNote, lines: Array<{ description: string | null; account_code: string; amount_sen: number }>) => void }) => {
  const q = useCreditNoteDetail(id);
  const post = usePostCreditNote();
  const cancel = useCancelCreditNote();
  const askConfirm = useConfirm();
  const n = q.data?.note;
  const lines = q.data?.lines ?? [];
  const busy = post.isPending || cancel.isPending;
  const failed = post.isError ? post.error : cancel.isError ? cancel.error : null;
  return (
    <Modal title={n ? `${KIND_WORD[n.kind]} ${n.note_number}` : 'Note'} onClose={onClose} width="min(820px, 100%)" ariaLabel="Credit or debit note"
      actions={n && (
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {n.status === 'DRAFT' && <Button variant="ghost" size="sm" onClick={() => onEdit(n, lines)} disabled={busy}>Edit</Button>}
          {n.status === 'DRAFT' && <Button size="sm" onClick={() => post.mutate(n.id)} disabled={busy}>{post.isPending ? 'Posting…' : 'Post to ledger'}</Button>}
          {n.status !== 'CANCELLED' && (
            <Button variant="ghost" size="sm" disabled={busy}
              onClick={async () => {
                const yes = await askConfirm({
                  title: `Cancel ${n.note_number}?`,
                  body: n.status === 'POSTED' ? 'Its journal is reversed by a contra dated today. The note stays on file as cancelled.' : 'The draft stays on file as cancelled.',
                  confirmLabel: 'Cancel note', danger: true,
                });
                if (yes) cancel.mutate(n.id);
              }}>
              Cancel note
            </Button>
          )}
        </div>
      )}>
      {q.isLoading && <div style={soft}>Loading…</div>}
      {n && (
        <div className="space-y-3">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <div><div style={soft}>Party</div>{n.party_name ?? '—'}{n.party_code ? <span style={soft}> · {n.party_code}</span> : null}</div>
            <div><div style={soft}>Date</div>{fmtDateOrDash(n.note_date)}</div>
            <div><div style={soft}>Reference</div>{[n.so_doc_no, n.source_doc_no].filter(Boolean).join(' · ') || '—'}</div>
            <div><div style={soft}>Status</div><StatusPill status={n.status} />{n.je_no ? <span style={soft}> · {n.je_no}</span> : null}</div>
            <div style={{ gridColumn: '1 / -1' }}><div style={soft}>Reason</div>{n.reason ?? '—'}</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>#</th><th style={th}>Description</th><th style={th}>Account</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}><td style={td}>{l.line_no}</td><td style={td}>{l.description ?? '—'}</td><td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{l.account_code}</td><td style={{ ...td, ...num }}>{fmtSen(l.amount_sen)}</td></tr>
              ))}
              <tr><td colSpan={3} style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{fmtSen(n.total_sen)}</td></tr>
            </tbody>
          </table>
          {post.isSuccess && <div style={{ fontSize: 'var(--fs-13)', color: good }}>Posted as {post.data.jeNo}.</div>}
          {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
        </div>
      )}
    </Modal>
  );
};

const NoteForm = ({ mode, id, initial, onClose, onSaved }: { mode: 'new' | 'edit'; id?: string; initial: FormValues; onClose: () => void; onSaved: (id: string) => void }) => {
  const [v, setV] = useState<FormValues>(initial);
  const [postAfter, setPostAfter] = useState(false);
  const accountsQ = useAccounts();
  const suppliersQ = useSuppliers();
  const create = useCreateCreditNote();
  const update = useUpdateCreditNote();
  const post = usePostCreditNote();
  const leaves = useMemo(() => leafAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const supplierOptions = useMemo(() => (suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })), [suppliersQ.data]);
  const totalSen = v.lines.reduce((s, l) => s + (l.amountRm.trim() ? toSen(l.amountRm) : 0), 0);
  const busy = create.isPending || update.isPending || post.isPending;
  const failed = create.isError ? create.error : update.isError ? update.error : post.isError ? post.error : null;
  const setLine = (rid: number, patch: Partial<FormLine>) => setV((p) => ({ ...p, lines: p.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const canSave = totalSen > 0 && v.noteDate !== '' && (v.kind === 'SCN' ? v.supplierId !== '' : v.soDocNo.trim() !== '' || v.partyName.trim() !== '');

  const save = async () => {
    try {
      const body = bodyOf(v);
      let noteId = id ?? '';
      if (mode === 'new') {
        const r = await create.mutateAsync(body);
        noteId = r.note.id;
      } else if (id) {
        await update.mutateAsync({ id, noteDate: body.noteDate, reason: body.reason, sourceDocNo: body.sourceDocNo, lines: body.lines });
      }
      if (postAfter && noteId) await post.mutateAsync(noteId);
      onSaved(noteId);
    } catch { /* the hook holds the error; it is shown below */ }
  };

  return (
    <Modal title={mode === 'new' ? 'New note' : `Edit ${initial.kind}`} onClose={onClose} width="min(900px, 100%)" ariaLabel="Note form">
      <div className="space-y-3">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
          <Field label="Kind">
            <select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as NoteKind })} disabled={mode === 'edit'} aria-label="Kind" style={input}>
              <option value="CN">CN — credit note to a customer</option>
              <option value="DN">DN — debit note to a customer</option>
              <option value="SCN">SCN — credit note from a supplier</option>
            </select>
          </Field>
          <Field label="Date"><DateField value={v.noteDate} onChange={(d) => setV({ ...v, noteDate: d })} aria-label="Note date" /></Field>
          {v.kind === 'SCN' ? (
            <Field label="Supplier">
              <SearchCombo options={supplierOptions} value={v.supplierId} onChange={(s) => setV({ ...v, supplierId: s })} aria-label="Supplier" placeholder="— type to search suppliers —" />
            </Field>
          ) : (
            <>
              <Field label="Sales order (the customer comes from it)">
                <input value={v.soDocNo} onChange={(e) => setV({ ...v, soDocNo: e.target.value })} placeholder="2990-SO-2607-019" aria-label="Sales order" style={input} disabled={mode === 'edit'} />
              </Field>
              <Field label="or customer name">
                <input value={v.partyName} onChange={(e) => setV({ ...v, partyName: e.target.value })} placeholder="when there is no order" aria-label="Customer name" style={input} disabled={mode === 'edit' || v.soDocNo.trim() !== ''} />
              </Field>
            </>
          )}
          <Field label="Reference (return, invoice, complaint)">
            <input value={v.sourceDocNo} onChange={(e) => setV({ ...v, sourceDocNo: e.target.value })} placeholder="DR-2609-001" aria-label="Reference" style={input} />
          </Field>
          <Field label="Reason">
            <input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="why this note" aria-label="Reason" style={input} />
          </Field>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Description</th><th style={th}>Account (blank = the kind's default)</th><th style={{ ...th, textAlign: 'right' }}>Amount (RM)</th><th style={th} /></tr></thead>
          <tbody>
            {v.lines.map((l) => (
              <tr key={l.rid}>
                <td style={td}><input value={l.description} onChange={(e) => setLine(l.rid, { description: e.target.value })} aria-label={`Line ${l.rid} description`} style={{ ...input, minWidth: 220 }} /></td>
                <td style={td}><AccountSelect accounts={leaves} value={l.accountCode} onChange={(code) => setLine(l.rid, { accountCode: code })} placeholder="— default for this kind —" /></td>
                <td style={{ ...td, ...num }}><input type="number" min={0} step="0.01" value={l.amountRm} onChange={(e) => setLine(l.rid, { amountRm: e.target.value })} aria-label={`Line ${l.rid} amount`} style={{ ...input, minWidth: 120, textAlign: 'right' }} /></td>
                <td style={td}>
                  {v.lines.length > 1 && (
                    <button type="button" onClick={() => setV({ ...v, lines: v.lines.filter((x) => x.rid !== l.rid) })} aria-label={`Remove line ${l.rid}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)' }}><X size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} style={td}>
                <Button variant="ghost" size="sm" onClick={() => setV({ ...v, lines: [...v.lines, emptyLine(Math.max(0, ...v.lines.map((x) => x.rid)) + 1)] })}><Plus size={14} /> Add line</Button>
              </td>
              <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtSen(totalSen)}</td>
              <td style={td} />
            </tr>
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={postAfter} onChange={(e) => setPostAfter(e.target.checked)} aria-label="Post to the ledger after saving" />
            post to the ledger after saving
          </label>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Close</Button>
          <Button size="sm" onClick={() => void save()} disabled={!canSave || busy}>{busy ? 'Saving…' : mode === 'new' ? 'Save note' : 'Save changes'}</Button>
        </div>
        {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
      </div>
    </Modal>
  );
};
