// ----------------------------------------------------------------------------
// NoteKnockOffPage — Credit / debit notes › Knock off <no> (the owner's Claude
// Design, batch 5 §5, `?form=knock&id=`): a posted customer credit note's
// knock-off against the customer's sales invoices (owner 2026-11-03: 「要」 —
// "like AutoCount"). Tick = the invoice in full as far as the credit reaches,
// type = part; the rest stays as credit on the customer. Only the knock-off
// changes: the note's lines and amount stay, and knocking off posts nothing —
// PUT /credit-notes/:id/allocations sets it whole (acc/credit-note-si.ts).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { MoneyInput } from '../../../vendor/scm/components/MoneyInput';
import { useAccountRoles, useAccounts } from '../../../vendor/scm/lib/accounting-queries';
import {
  useCreditNoteDetail, useCreditNoteKnockOff, useSetCreditNoteAllocations, type KnockOffRow,
} from '../../../vendor/scm/lib/credit-note-queries';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useToastOptional } from '../../../hooks/useToast';
import { customerWords, pickFromRows, pickSen, pickTargets, type KnockOffPick } from '../CreditNoteKnockOff';
import { DocFormShell } from './MoneyInDocPage';
import ui from '../MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const samePick = (a: KnockOffPick, b: KnockOffPick): boolean => {
  const x = pickTargets(a);
  return x.length === pickTargets(b).length && x.every((t) => b[t.id]?.amountSen === t.amountSen);
};

function ReadField({ label, value, full = false }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`${ui.formField}${full ? ` ${ui.formFull}` : ''}`}>
      <span className={ui.formLabel}>{label}</span>
      <input className={ui.formInput} value={value} disabled aria-label={label} readOnly />
    </div>
  );
}

export function NoteKnockOffPage({ id, backLabel, onClose, onSaved }: {
  id: string;
  backLabel: string;
  onClose: () => void;
  /** Heard after the knock-off is saved (the lists read again). */
  onSaved: () => void;
}) {
  const toast = useToastOptional();
  const detailQ = useCreditNoteDetail(id);
  const knockQ = useCreditNoteKnockOff(id);
  const rolesQ = useAccountRoles();
  const accountsQ = useAccounts();
  const save = useSetCreditNoteAllocations();
  const [edit, setEdit] = useState<KnockOffPick | null>(null);
  const n = detailQ.data?.note;
  const rows = useMemo(() => knockQ.data?.rows ?? [], [knockQ.data]);
  const server = useMemo(() => pickFromRows(knockQ.data?.rows), [knockQ.data]);
  const pick = edit ?? server;
  const total = Number(n?.total_sen ?? 0);
  const taken = pickSen(pick);
  const named = customerWords(n?.party_name);

  /* The books line names the trade debtors control the server posts to (its role), never a typed code. */
  const ar = rolesQ.data?.roles.AR ?? '300-0000';
  const arName = (accountsQ.data?.accounts ?? []).find((a) => a.account_code === ar)?.account_name;
  const books = `Posts nothing · both sides sit in ${ar}${arName ? ` ${arName}` : ''} · knocks off ${fmtSen(taken)}${taken > 0 && total > taken ? ` · ${fmtSen(total - taken)} stays as credit` : ''}`;

  const over = rows.find((r) => (pick[r.id]?.amountSen ?? 0) > r.owedSen);
  const blocking = !n ? null
    : n.status === 'DRAFT' ? 'This note is a draft — its knock-off is planned on Edit and carried out when it posts.'
      : n.status === 'CANCELLED' ? 'This note is cancelled — it knocks nothing off.'
        : knockQ.data?.refusal ? knockQ.data.refusal
          : over ? `${over.number} only has ${fmtSen(over.owedSen)} outstanding.`
            : taken > total ? `The knock-offs add up to ${fmtSen(taken)}, more than the note (${fmtSen(total)}).`
              : null;
  const dirty = edit != null && !samePick(edit, server);

  const put = (r: KnockOffRow, sen: number): void => {
    const next = { ...pick };
    if (sen > 0) next[r.id] = { kind: r.kind, id: r.id, amountSen: sen };
    else delete next[r.id];
    setEdit(next);
  };

  const submit = () => {
    if (!n || blocking || !dirty || save.isPending) return;
    save.mutate({ noteId: n.id, targets: pickTargets(pick) }, {
      onSuccess: (r) => {
        const short = r.short.map((x) => `${x.number} took ${fmtSen(x.appliedSen)} of ${fmtSen(x.askedSen)}`).join(' · ');
        toast?.success(`${n.note_number} · knock-off saved${short ? ` · ${short}` : ''}`);
        onSaved();
        onClose();
      },
    });
  };

  if (!n) {
    return (
      <DocFormShell title="Knock off" backLabel={backLabel} onBack={onClose} bare>
        <div className={ui.hint} role={detailQ.isError ? 'alert' : undefined}>
          {detailQ.isError ? `The note did not load — ${errText(detailQ.error)}` : 'Loading the note…'}
        </div>
      </DocFormShell>
    );
  }

  return (
    <DocFormShell title={`Knock off ${n.note_number}`} backLabel={backLabel} onBack={onClose} bare>
      <div className={ui.formCol}>
        <div className={ui.formNote}><Info size={14} /><span>Only the knock-off changes. The note is posted, so its lines and amount stay as they are, and knocking off posts nothing.</span></div>
        <div className={ui.formGrid}>
          <div className={ui.formCol}>
            <div className={`${ui.formCard} ${ui.formFields}`} aria-label="The note">
              <ReadField label="Note date" value={fmtDate(n.note_date)} />
              <ReadField label="Sales order" value={n.so_doc_no ?? '—'} />
              <ReadField label="Customer" value={n.party_name ?? n.party_code ?? '—'} />
              <ReadField label="Reference" value={n.source_doc_no ?? '—'} />
              <ReadField label="Reason" value={n.reason ?? '—'} full />
            </div>

            <section className={ui.formCard} aria-label={named.table}>
              <div className={ui.formCardTitle}>{named.table}</div>
              {knockQ.isLoading ? <div className={ui.pickEmpty}>Loading the customer&apos;s invoices…</div>
                : knockQ.isError ? <div className={`${ui.pickEmpty} ${ui.formHintBad}`} role="alert">The invoices did not load — {errText(knockQ.error)}</div>
                  : knockQ.data?.refusal ? <div className={ui.pickEmpty}>{knockQ.data.refusal}</div>
                    : rows.length === 0 ? <div className={ui.pickEmpty}>{named.none}</div>
                      : (
                        <div className={ui.lineScroll}>
                          <div className={ui.pickHead}><span /><span>Invoice</span><span>Date</span><span>For</span><span className={ui.right}>Outstanding</span><span className={ui.right}>Knock off</span></div>
                          {rows.map((r) => {
                            const mine = pick[r.id]?.amountSen ?? 0;
                            /* Ticked: in full, as far as the credit left reaches. */
                            const reach = Math.max(0, Math.min(r.owedSen, total - (taken - mine)));
                            return (
                              <div key={r.id} className={ui.pickRow}>
                                <input type="checkbox" aria-label={`Knock off ${r.number}`} checked={mine > 0} disabled={save.isPending || (mine === 0 && reach === 0)}
                                  onChange={(e) => put(r, e.target.checked ? reach : 0)} style={{ width: 16, height: 16, accentColor: '#16695f' }} />
                                <span className={ui.pickNo}>{r.number}</span>
                                <span className={ui.muted}>{fmtDate(r.invoiceDate)}</span>
                                <span className={ui.pickFor} title={r.invoiceRef ?? undefined}>{r.invoiceRef ?? '—'} · total {fmtSen(r.totalSen)}</span>
                                <span className={`${ui.right} ${ui.strong}`}>{fmtSen(r.owedSen)}</span>
                                <MoneyInput bare valueSen={mine > 0 ? mine : null} allowBlank placeholder="0.00" selectOnFocus inputClassName={ui.formInput}
                                  disabled={save.isPending} aria-label={`Amount off ${r.number}`}
                                  onCommit={(sen) => put(r, Math.max(0, sen ?? 0))} />
                              </div>
                            );
                          })}
                        </div>
                      )}
            </section>
          </div>

          <aside className={ui.side} aria-label="Save">
            <div className={ui.sideTotal}><span className={ui.sideTotalLabel}>Total</span><span className={ui.sideTotalValue}>{fmtSen(total)}</span></div>
            <div className={ui.sideBooks}>{books}</div>
            {blocking && <div className={ui.sideWhy}>{blocking}</div>}
            {save.isError && <div className={`${ui.sideWhy} ${ui.formHintBad}`} role="alert">{errText(save.error)}</div>}
            <div className={ui.sideButtons}>
              <button type="button" className={ui.btn} onClick={onClose} disabled={save.isPending}>Cancel</button>
              <span className={ui.grow} />
              <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={submit} disabled={save.isPending || blocking != null || !dirty}>
                {save.isPending ? 'Saving…' : 'Save knock-off'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </DocFormShell>
  );
}
