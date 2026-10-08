// ----------------------------------------------------------------------------
// PmsRequestModals — the dialogs behind a CONTRACT row's 「Request payment」 and
// 「补正式单」 (owner 2026-10-08; PmsRequestPayment.tsx). Loaded on first use.
//
//   request   tick the row's file(s) that are the bill → the payment request
//             form, the files read at once, the row's event fixed.
//   official  tick the row's file(s) that are the actual invoice → uploaded on
//             the request as its official invoice (补正式单): the payment
//             answering it moves to 待核对 for Finance to check.
//
// Only a PDF or an image can be a bill (the request's own rule); a row's other
// files show, greyed, with why. The dialogs live in the SCM shell's providers —
// the PMS page has none of its own — mounted at the body, out of the row.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@2990s/design-system';
import { api } from '../../api/client';
import { Scm2990Shell } from '../scm-v2/Scm2990Shell';
import { RequestForm, type RequestSeed } from '../scm-v2/PaymentRequestForm';
import { Modal } from '../../vendor/scm/components/Modal';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useUploadOfficialDoc } from '../../vendor/scm/lib/official-doc-queries';
import { fileToBase64 } from '../../vendor/scm/lib/payment-voucher-queries';
import { fmtDateOrDash } from '../../vendor/shared/format';
import type { TaskAttachment } from './types';

export type PmsModalProps =
  | { mode: 'request'; itemId: number; itemTitle: string; attachments: TaskAttachment[]; projectId: number; eventLabel: string; onClose: () => void }
  | { mode: 'official'; requestId: string; requestNo: string; attachments: TaskAttachment[]; onClose: () => void };

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };

const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const BILL_MIMES = new Set(Object.values(MIME_BY_EXT));

/** The type a row file goes to Finance as — a PDF or an image, else null (not a bill). */
export function billMimeOf(a: Pick<TaskAttachment, 'file_name' | 'content_type'>): string | null {
  const ct = String(a.content_type ?? '').toLowerCase();
  if (BILL_MIMES.has(ct)) return ct;
  const ext = String(a.file_name.split('.').pop() ?? '').toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

/** The row file's bytes, as a File the request form reads like one picked here. */
async function attachmentAsFile(a: TaskAttachment): Promise<File> {
  const mime = billMimeOf(a) ?? 'application/pdf';
  const blob = await api.fetchBlob(`/api/projects/attachments/${a.r2_key}`, mime);
  return new File([blob], a.file_name, { type: mime });
}

/** The row's files with a tick each — the newest usable one ticked to start. */
function FilePicker({ attachments, ticked, onTick }: { attachments: TaskAttachment[]; ticked: Set<number>; onTick: (id: number, on: boolean) => void }) {
  return (
    <div role="group" aria-label="The row's files" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.map((a) => {
        const usable = billMimeOf(a) != null;
        return (
          <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line, #ece9e2)', opacity: usable ? 1 : 0.55, cursor: usable ? 'pointer' : 'not-allowed' }}>
            <input type="checkbox" checked={ticked.has(a.id)} disabled={!usable} onChange={(e) => onTick(a.id, e.target.checked)} aria-label={a.file_name} />
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: 'var(--fs-13)', overflowWrap: 'anywhere' }}>{a.file_name}</span>
              <span style={soft}>{a.uploader_name ?? '—'} · {fmtDateOrDash(a.uploaded_at)}{usable ? '' : ' · not a PDF or an image — it cannot go to Finance as a bill'}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function Inner(props: PmsModalProps) {
  const notify = useNotify();
  const upload = useUploadOfficialDoc();
  const firstUsable = props.attachments.find((a) => billMimeOf(a) != null);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(firstUsable ? [firstUsable.id] : []));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [seed, setSeed] = useState<RequestSeed | null>(null);
  const onTick = (id: number, on: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const chosen = props.attachments.filter((a) => ticked.has(a.id));

  const fetchChosen = async (): Promise<File[] | null> => {
    setBusy(true);
    setProblem(null);
    try {
      return await Promise.all(chosen.map(attachmentAsFile));
    } catch (e) {
      setProblem(`The row's file could not be fetched — ${e instanceof Error ? e.message : 'try again'}.`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (props.mode === 'request') {
    if (seed) {
      return (
        <Modal title={`New payment request — ${props.itemTitle}`} onClose={props.onClose} width="min(760px, 100%)" ariaLabel="New payment request">
          <RequestForm
            initial={null}
            hasEvents
            seed={seed}
            onDone={() => {
              void notify({ title: 'Sent to Finance · 已提交', body: 'The request shows under this row; Finance answers it from Payment Requests.', tone: 'info' });
              props.onClose();
            }}
            onCancel={props.onClose}
          />
        </Modal>
      );
    }
    const next = async () => {
      const files = await fetchChosen();
      if (files) setSeed({ files, projectId: props.projectId, eventLabel: props.eventLabel, checklistItemId: props.itemId });
    };
    return (
      <Modal title="Request payment · 申请付款 — which file is the bill?" onClose={props.onClose} width="min(560px, 100%)" ariaLabel="Request payment — pick the bill">
        <div style={soft}>Tick the invoice Finance should pay — several files are one bill's pages. A proforma or quotation is fine; Finance marks it to follow up the actual invoice.</div>
        <FilePicker attachments={props.attachments} ticked={ticked} onTick={onTick} />
        {problem && <div role="alert" style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-12)' }}>{problem}</div>}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => void next()} disabled={busy || chosen.length === 0}>{busy ? 'Fetching the file…' : 'Next — fill the request'}</Button>
        </div>
      </Modal>
    );
  }

  /* 补正式单 — the actual invoice, uploaded on the request as its official invoice. */
  const send = async () => {
    const files = await fetchChosen();
    if (!files) return;
    setBusy(true);
    try {
      const notes: string[] = [];
      let differs = false;
      for (const f of files) {
        const res = await upload.mutateAsync({ requestId: props.requestId, file: { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) } });
        /* The reader's note: the official invoice differs from the proforma it follows. */
        if (res.note) { notes.push(res.note); differs = true; }
        else if (res.received.length > 0) notes.push(`Finance checks it on ${res.received.map((d) => d.number ?? d.kind).join(', ')}.`);
      }
      void notify({ title: 'Official invoice sent · 已补正式单', body: notes.join(' ') || 'It is kept with the request and its payment.', tone: differs ? 'error' : 'info' });
      props.onClose();
    } catch { /* the mutation's own onError told the user */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Send the actual invoice · 补正式单 — ${props.requestNo}`} onClose={props.onClose} width="min(560px, 100%)" ariaLabel="Send the actual invoice">
      <div style={soft}>Tick the actual invoice — attach it to this row first (Attach) if it is not here yet. It goes to the request as its official invoice, and Finance checks it.</div>
      {props.attachments.length > 0
        ? <FilePicker attachments={props.attachments} ticked={ticked} onTick={onTick} />
        : <div style={soft}>No file on this row yet.</div>}
      {problem && <div role="alert" style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-12)' }}>{problem}</div>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void send()} disabled={busy || upload.isPending || chosen.length === 0}>{busy || upload.isPending ? 'Sending…' : 'Send as the official invoice'}</Button>
      </div>
    </Modal>
  );
}

export default function PmsRequestModals(props: PmsModalProps) {
  return createPortal(<Scm2990Shell><Inner {...props} /></Scm2990Shell>, document.body);
}
