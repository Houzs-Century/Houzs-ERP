// ----------------------------------------------------------------------------
// MoneyInDocPage — one page for every Money-in document (the owner's Claude
// Design, batch 5 §8; the design's vDoc). Back to where it was opened from
// (else its own list); the head — kind, number, status, Add task, Print and
// the document's own steps; the party and amount card with its facts and the
// Books line read from the journal; the sections; the trail on the right.
//
// The shell only lays out. Each document page brings its reads and its steps
// — the same hooks and endpoints the old pop-outs used — so nothing here
// posts, and a step the server refuses says so in the page's ask banner.
// ----------------------------------------------------------------------------

import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ListChecks, Printer } from 'lucide-react';
import { fmtDate, fmtDateTime } from '../../../vendor/shared/format';
import { returnToWorkspaceOpener, useWorkspaceOpener } from '../../../lib/useWorkspaceOpener';
import type { TaskLink } from '../finance/finance-todo-queries';
import { VoucherTaskDrawer } from '../PvDocParts';
import { StatusTag } from './MoneyInParts';
import type { Tag } from './moneyInStatus';
import { moneyInListOf, type MoneyInDocKind } from './moneyInDocs';
import { booksSentence, liveJournal, type DocJournals } from './moneyInDocQueries';
import ui from '../MoneyIn.module.css';
import s from './MoneyInDoc.module.css';

export type DocFact = {
  label: string;
  value: ReactNode;
  /** A fact that opens something (an order, a debtor, a note). */
  to?: string | null;
  /** Red for something wrong or late, brass for money still owed. */
  tone?: 'late' | 'brass' | null;
  title?: string;
};

export type DocAction = {
  label: string;
  onClick: () => void;
  /** Primary moves the document on (petrol); danger undoes it (red outline). */
  kind?: 'primary' | 'danger';
  /** The step is refused: greyed, and this says why. */
  refused?: string | null;
  busy?: boolean;
};

export type TrailStep = { key: string; act: string; who?: string | null; when?: string | null; note?: string | null; undo?: boolean };

/* Who did a step, when the row says so. Some Money-in tables stamp the SCM
   session's pinned system id instead of a person (scm/middleware/auth.ts) —
   a stamp like that names nobody, so the trail leaves the name out. */
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const personOf = (v: string | null | undefined): string | null => {
  const t = String(v ?? '').trim();
  return t && !ID_LIKE.test(t) ? t : null;
};

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/** Back to the page this document was opened from (its tab), else its list. */
export function DocBack({ kind, label }: { kind: MoneyInDocKind; label?: string }) {
  const navigate = useNavigate();
  const cameFrom = useWorkspaceOpener();
  const list = moneyInListOf(kind);
  return (
    <button type="button" className={s.back} onClick={() => {
      const href = cameFrom ? returnToWorkspaceOpener() : null;
      navigate(href ?? list.href);
    }}>
      <ArrowLeft size={14} /> Back to {label ?? cameFrom?.label ?? list.label}
    </button>
  );
}

/** Loading, refused or missing — the page says which, with its Back. */
export function DocState({ kind, loading, error }: { kind: MoneyInDocKind; loading: boolean; error: unknown }) {
  return (
    <div className={s.page}>
      <DocBack kind={kind} />
      {loading
        ? <div className={s.state}>Loading…</div>
        : <div role="alert" className={`${s.state} ${s.stateBad}`}>{error ? `This document did not load — ${errText(error)}` : 'This document is not in the company you are working in.'}</div>}
    </div>
  );
}

/** A section of the document: a title, its buttons, then a table or a sentence. */
export function DocSection({ title, buttons, children }: { title: string; buttons?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.section} aria-label={title}>
      <div className={s.sectionHead}><h2 className={s.sectionTitle}>{title}</h2>{buttons}</div>
      {children}
    </section>
  );
}

/** The trail steps the journal tells: each entry booked (an edit re-posts) and each contra. */
export function journalTrail(j: DocJournals | undefined): TrailStep[] {
  if (!j) return [];
  const booked = [...j.booked].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return [
    ...booked.map((e, i): TrailStep => ({ key: `je-${e.id}`, act: i === 0 ? 'Posted' : 'Re-posted', when: e.created_at, note: e.je_no })),
    ...j.contras.map((e): TrailStep => ({ key: `rev-${e.id}`, act: 'Journal reversed', when: e.created_at, note: e.je_no, undo: true })),
  ];
}

/** The Books line: the live entry's accounts, else what reversed it, else the rule's preview. */
export function DocBooks({ journals, loading, accountName, preview, prefix }: {
  journals: DocJournals | undefined;
  loading: boolean;
  accountName: (code: string) => string | null;
  /** What the rule would book while nothing is posted (`Not posted · …`, `Posts at approval · …`). */
  preview?: ReactNode;
  /** Words before a posted entry's accounts — default `Posted`. */
  prefix?: string;
}) {
  if (loading) return <>Reading the journal…</>;
  const live = liveJournal(journals);
  if (live) return <><b>{prefix ?? 'Posted'}</b> · {booksSentence(live, accountName)} · {live.je_no}</>;
  const reversed = journals?.booked[0];
  if (reversed) return <><b>Reversed</b> · {booksSentence(reversed, accountName)} · {reversed.je_no}</>;
  return <>{preview ?? 'Nothing posted'}</>;
}

/** The document as it prints, drawn from the same generator Print uses. */
export function PaperPreview({ title, draw }: { title: string; draw: (() => Promise<Blob>) | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!draw) return undefined;
    let live = true;
    let made: string | null = null;
    setFailed(null);
    draw()
      .then((blob) => { if (!live) return; made = URL.createObjectURL(blob); setUrl(made); })
      .catch((e: unknown) => { if (live) setFailed(errText(e)); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [draw]);
  if (failed) return <div role="alert" className={`${s.empty} ${s.toneLate}`}>The page could not be drawn — {failed}</div>;
  if (!url) return <div className={s.empty}>Drawing the page…</div>;
  return <iframe title={title} src={url} className={s.paper} />;
}

const whenOf = (v: string | null | undefined): string => (v ? (v.length > 10 ? fmtDateTime(v) : fmtDate(v)) : '');

export function MoneyInDocPage({
  kind, kindLabel, number, tag, sub, taskLink, onPrint, printing = false, actions = [], ask, notice,
  party, amount, facts, books, trail, children,
}: {
  kind: MoneyInDocKind;
  kindLabel: string;
  number: string;
  tag?: Tag | null;
  sub?: ReactNode;
  taskLink: TaskLink;
  onPrint?: (() => void) | null;
  printing?: boolean;
  actions?: DocAction[];
  /** The ask banner, when a step is being asked about. */
  ask?: ReactNode;
  /** A line under the head — what a step just did, or why it failed. */
  notice?: ReactNode;
  party: { label: string; name: ReactNode; lines?: ReactNode[] };
  amount: { label: string; value: string; sub?: ReactNode };
  facts: DocFact[];
  books?: ReactNode;
  trail: TrailStep[];
  children?: ReactNode;
}) {
  const [addingTask, setAddingTask] = useState(false);
  return (
    <div className={s.page}>
      <DocBack kind={kind} />
      <header className={s.head}>
        <div className={s.headMain}>
          <div className={s.kind}><span className={s.kindRule} /><span className={s.kindText}>{kindLabel}</span></div>
          <div className={s.titleRow}>
            <h1 className={s.number}>{number}</h1>
            {tag && <StatusTag tag={tag} />}
            {sub && <span className={s.sub}>{sub}</span>}
          </div>
        </div>
        <div className={s.headActions}>
          <button type="button" className={ui.btn} onClick={() => setAddingTask(true)}><ListChecks size={14} /> Add task</button>
          {onPrint && (
            <button type="button" className={ui.btn} onClick={onPrint} disabled={printing}><Printer size={14} /> {printing ? 'Preparing…' : 'Print'}</button>
          )}
          {actions.map((a) => (
            <button key={a.label} type="button" title={a.refused ?? undefined} disabled={Boolean(a.refused) || a.busy}
              className={`${ui.btn} ${a.kind === 'primary' ? ui.btnPrimary : a.kind === 'danger' ? ui.btnDanger : ''}`}
              onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </header>
      {ask}
      {notice}
      <div className={s.body}>
        <div className={s.main}>
          <div className={s.card}>
            <div className={s.partyRow}>
              <div className={s.party}>
                <div className={s.label}>{party.label}</div>
                <div className={s.partyName}>{party.name}</div>
                {(party.lines ?? []).filter((l) => l != null && l !== '').map((l, i) => <div key={i} className={s.partyLine}>{l}</div>)}
              </div>
              <div className={s.amountBox}>
                <div className={s.label}>{amount.label}</div>
                <div className={s.amount}>{amount.value}</div>
                {amount.sub && <div className={s.amountSub}>{amount.sub}</div>}
              </div>
            </div>
            <dl className={s.facts}>
              {facts.map((f) => (
                <div key={f.label} className={s.fact}>
                  <dt className={s.factLabel}>{f.label}</dt>
                  <dd style={{ margin: 0 }}>
                    {f.to
                      ? <Link to={f.to} className={s.factLink} title={f.title}>{f.value}</Link>
                      : <div className={`${s.factValue} ${f.tone === 'late' ? s.toneLate : f.tone === 'brass' ? s.toneBrass : ''}`} title={f.title ?? (typeof f.value === 'string' ? f.value : undefined)}>{f.value}</div>}
                  </dd>
                </div>
              ))}
            </dl>
            {books != null && (
              <div className={s.books}><span className={s.booksLabel}>Books</span><span className={s.booksText}>{books}</span></div>
            )}
          </div>
          {children}
        </div>
        <aside className={s.trail} aria-label="Trail">
          <h2 className={s.trailTitle}>Trail</h2>
          {trail.length === 0 && <div className={s.empty}>No step recorded yet.</div>}
          {trail.map((t) => (
            <div key={t.key} className={s.step}>
              <span className={`${s.dot} ${t.undo ? s.dotUndo : ''}`} />
              <div style={{ minWidth: 0 }}>
                <div className={`${s.act} ${t.undo ? s.actUndo : ''}`}>{t.act}</div>
                {(t.who || t.when) && <div className={s.who}>{[t.who, whenOf(t.when)].filter(Boolean).join(' · ')}</div>}
                {t.note && <div className={s.stepNote}>{t.note}</div>}
              </div>
            </div>
          ))}
        </aside>
      </div>
      {addingTask && <VoucherTaskDrawer link={taskLink} onClose={() => setAddingTask(false)} />}
    </div>
  );
}

/** A document's form in place of the document (`?form=…`), with Back to it. */
export function DocFormShell({ title, backLabel, onBack, children }: { title: string; backLabel: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className={s.page}>
      <button type="button" className={s.back} onClick={onBack}><ArrowLeft size={14} /> Back to {backLabel}</button>
      <div className={s.formHead}><h1 className={s.formTitle}>{title}</h1></div>
      <div className={s.formBody}>{children}</div>
    </div>
  );
}

/** Sort a trail oldest first; steps without a time keep their place at the end. */
export const byTime = (steps: TrailStep[]): TrailStep[] =>
  [...steps].sort((a, b) => (a.when && b.when ? a.when.localeCompare(b.when) : a.when ? -1 : b.when ? 1 : 0));
