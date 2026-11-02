// ----------------------------------------------------------------------------
// TaskDrawers — Add task, and one task with its remarks (the owner's Claude
// Design redesign, Finance-1a-To-do, batch 2). A task is for you or a teammate
// in Finance; it may repeat, be linked to a document or a page, and carry
// remarks — an edited remark keeps its earlier wording. Nothing here posts to
// the books.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Info, Paperclip, Plus, Search, X } from 'lucide-react';
import { ResizableDetailDrawer } from '../../../components/ResizableDetailDrawer';
import { DateField } from '../../../vendor/scm/components/DateField';
import { fmtDate, fmtDateTime } from '../../../vendor/shared/format';
import styles from './FinanceTasks.module.css';
import {
  useAddGroup, useAddRemark, useCreateTask, useEditRemark, useLinkSearch, useMarkTask, useTodoPeople, useTodoTask,
  type NewTask, type TaskLink, type TaskRemark, type TodoGroupDef, type TodoTask,
} from './finance-todo-queries';

export const BUILT_IN_GROUPS: TodoGroupDef[] = [
  { id: 'recon', label: 'Merchant reports & bank statements' },
  { id: 'pay', label: 'Payments' },
  { id: 'other', label: 'Receipts & books' },
  { id: 'misc', label: 'Others' },
];

/** Pages a task can point at, besides documents — the design's "any ERP page". */
const PAGES: Array<[string, string, string]> = [
  ['To do', '/scm/finance', 'Finance'],
  ['Daily Bank', '/scm/daily-bank', 'Finance › Bank & cards'],
  ['Merchant reports', '/scm/merchant-recon', 'Finance › Bank & cards'],
  ['Bank statements', '/scm/bank-recon', 'Finance › Bank & cards'],
  ['Unmatched payments', '/scm/unmatched-payments', 'Finance › Bank & cards'],
  ['Payment requests', '/scm/payment-requests', 'Finance › Money out'],
  ['Payment vouchers', '/scm/payment-vouchers', 'Finance › Money out'],
  ['AP invoices', '/scm/ap-invoices', 'Finance › Money out'],
  ['Official receipts', '/scm/official-receipts', 'Finance › Money in'],
  ['Receipts', '/scm/receipts', 'Finance › Money in'],
  ['Deposit invoices', '/scm/deposit-invoices', 'Finance › Money in'],
  ['Other debtors', '/scm/other-debtors', 'Finance › Money in'],
  ['Outstanding', '/scm/outstanding', 'Finance › Money in'],
  ['Journal entries', '/scm/accounting?tab=je', 'Finance › Books'],
  ['General ledger', '/scm/accounting?tab=gl', 'Finance › Books'],
  ['Trial balance', '/scm/accounting?tab=tb', 'Finance › Books'],
  ['Self-check', '/scm/accounting?tab=check', 'Finance › Books'],
  ['Month-end', '/scm/accounting?tab=close', 'Finance › Books'],
  ['AR aging', '/scm/accounting?tab=ar', 'Finance › Reports'],
  ['AP aging', '/scm/accounting?tab=ap', 'Finance › Reports'],
  ['Chart of accounts', '/scm/chart-of-accounts', 'Finance › Setup'],
  ['To do rules', '/scm/finance/rules', 'Finance › Setup'],
  ['Sales orders', '/scm/sales-orders', 'Workspace'],
  ['Sales invoices', '/scm/sales-invoices', 'Supply Chain'],
  ['Suppliers', '/scm/suppliers', 'Supply Chain'],
];

const WEEKDAYS: Array<[number, string]> = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));
const EVERY = [1, 2, 3, 6, 12];

const addDays = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.chip} ${on ? styles.chipOn : ''}`} aria-pressed={on} onClick={onClick}>{label}</button>
  );
}

function Field({ label, optional = false, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}{optional && <span className={styles.optional}> · optional</span>}</span>
      {children}
    </div>
  );
}

/* ── Add task ──────────────────────────────────────────────────────────── */

export function AddTaskDrawer({ open, onClose, today, groups }: { open: boolean; onClose: () => void; today: string; groups: TodoGroupDef[] }) {
  const people = useTodoPeople(open);
  const create = useCreateTask();
  const addGroup = useAddGroup();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState<number | null>(null);
  const [due, setDue] = useState(addDays(today, 1));
  const [repeat, setRepeat] = useState<NewTask['repeat']>('none');
  const [dayMode, setDayMode] = useState<'all' | 'wk' | 'ms'>('all');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [monthDay, setMonthDay] = useState<string>('');
  const [every, setEvery] = useState(1);
  const [group, setGroup] = useState('misc');
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const [link, setLink] = useState<TaskLink | null>(null);
  const [linkQ, setLinkQ] = useState('');
  const [remark, setRemark] = useState('');
  const docs = useLinkSearch(open ? linkQ : '');

  const me = people.data?.me ?? null;
  const allGroups = [...BUILT_IN_GROUPS, ...groups];
  const dueDay = Number(due.slice(8, 10));
  const pickRepeat = (r: NewTask['repeat']) => {
    setRepeat(r);
    /* The repeat starts from the due day: its weekday, its day of the month. */
    if (r === 'week' && weekdays.length === 0) setWeekdays([new Date(`${due}T00:00:00Z`).getUTCDay()]);
    if (r === 'month' && !monthDay) setMonthDay(String(dueDay));
  };

  const q = linkQ.trim().toLowerCase();
  const pageHits = q.length >= 2 && !q.startsWith('/')
    ? PAGES.filter(([name]) => name.toLowerCase().includes(q)).slice(0, 6).map(([name, to, where]) => ({ type: 'Page', no: name, name: where, to }))
    : [];
  const pasted = q.startsWith('/') && !q.startsWith('//') ? [{ type: 'Page', no: linkQ.trim(), name: 'This address', to: linkQ.trim() }] : [];
  const results: TaskLink[] = [...pasted, ...(docs.data?.results ?? []), ...pageHits];

  const reset = () => {
    setTitle(''); setAssignee(null); setDue(addDays(today, 1)); setRepeat('none'); setDayMode('all'); setWeekdays([]);
    setMonthDay(''); setEvery(1); setGroup('misc'); setLink(null); setLinkQ(''); setRemark(''); setNewGroupOpen(false); setNewGroup('');
  };
  const close = () => { reset(); onClose(); };
  const ready = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(due) && (repeat !== 'week' || weekdays.length > 0);
  const save = () => {
    if (!ready) return;
    create.mutate({
      title: title.trim(), assigneeId: assignee ?? me?.id ?? null, dueDate: due, groupKey: group, repeat,
      ...(repeat === 'day' ? { dayMode } : {}),
      ...(repeat === 'week' ? { weekdays } : {}),
      ...(repeat === 'month' ? { monthDay: monthDay || String(dueDay), everyMonths: every } : {}),
      link, remark: remark.trim(),
    }, { onSuccess: close });
  };

  return (
    <ResizableDetailDrawer open={open} onClose={close} ariaLabel="Add task">
      {open && (
        <div className={styles.drawer}>
          <div className={styles.head}>
            <div>
              <div className={styles.headTitle}>Add task</div>
              <div className={styles.headSub}>For you or a teammate. It shows in To do with its due date.</div>
            </div>
            <button type="button" className={styles.close} onClick={close} aria-label="Close"><X size={16} /></button>
          </div>
          <div className={styles.body}>
            <Field label="Task">
              <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
                placeholder="e.g. Call Kian Furniture about the October statement" aria-label="Task" />
            </Field>
            <Field label="Assign to">
              <div className={styles.chips}>
                {me && <Chip on={(assignee ?? me.id) === me.id} label="Me" onClick={() => setAssignee(me.id)} />}
                {(people.data?.people ?? []).filter((p) => p.id !== me?.id).map((p) => (
                  <Chip key={p.id} on={assignee === p.id} label={p.name} onClick={() => setAssignee(p.id)} />
                ))}
                {people.isError && <span className={styles.hint}>Teammates could not be read — the task can still be yours.</span>}
              </div>
            </Field>
            <Field label={repeat === 'none' ? 'Due' : 'Starts'}>
              <div className={styles.chips}>
                <DateField value={due} onChange={(v) => setDue(v)} aria-label="Due day" />
                <Chip on={due === today} label="Today" onClick={() => setDue(today)} />
                <Chip on={due === addDays(today, 1)} label="Tomorrow" onClick={() => setDue(addDays(today, 1))} />
                <Chip on={due === addDays(today, 7)} label="In a week" onClick={() => setDue(addDays(today, 7))} />
              </div>
            </Field>
            <Field label="Repeat">
              <div className={styles.chips}>
                {([['none', "Doesn't repeat"], ['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']] as const).map(([v, l]) => (
                  <Chip key={v} on={repeat === v} label={l} onClick={() => pickRepeat(v)} />
                ))}
              </div>
              {repeat === 'day' && (
                <div className={styles.subRow}><span className={styles.subLabel}>On</span>
                  {([['all', 'Every day'], ['wk', 'Mon to Fri'], ['ms', 'Mon to Sat']] as const).map(([v, l]) => (
                    <Chip key={v} on={dayMode === v} label={l} onClick={() => setDayMode(v)} />
                  ))}
                </div>
              )}
              {repeat === 'week' && (
                <div className={styles.subRow}><span className={styles.subLabel}>On</span>
                  {WEEKDAYS.map(([d, l]) => (
                    <Chip key={d} on={weekdays.includes(d)} label={l}
                      onClick={() => setWeekdays(weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d])} />
                  ))}
                </div>
              )}
              {repeat === 'month' && (
                <>
                  <div className={styles.subRow}><span className={styles.subLabel}>On day</span>
                    <div className={styles.dayGrid}>
                      {MONTH_DAYS.map((d) => <Chip key={d} on={(monthDay || String(dueDay)) === d} label={d} onClick={() => setMonthDay(d)} />)}
                      <Chip on={monthDay === 'last'} label="Last day" onClick={() => setMonthDay('last')} />
                    </div>
                  </div>
                  <div className={styles.subRow}><span className={styles.subLabel}>Every</span>
                    {EVERY.map((n) => <Chip key={n} on={every === n} label={n === 1 ? 'month' : `${n} months`} onClick={() => setEvery(n)} />)}
                  </div>
                </>
              )}
              {repeat !== 'none' && (
                <div className={styles.summary}>
                  {repeat === 'day' ? 'Shows in To do on the day.' : 'Shows in To do 3 days before.'} Each time is done on its own.
                </div>
              )}
            </Field>
            <Field label="Put it under">
              <div className={styles.chips}>
                {allGroups.map((g) => <Chip key={g.id} on={group === g.id} label={g.label} onClick={() => setGroup(g.id)} />)}
                <button type="button" className={styles.addChip} onClick={() => setNewGroupOpen(!newGroupOpen)}><Plus size={12} />New group</button>
              </div>
              {newGroupOpen && (
                <div className={styles.subRow}>
                  <input className={styles.input} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} maxLength={40}
                    placeholder="e.g. Tax & e-invoice" aria-label="New group" />
                  <button type="button" className={styles.btnSecondary} disabled={!newGroup.trim() || addGroup.isPending}
                    onClick={() => addGroup.mutate(newGroup.trim(), { onSuccess: (r) => { setGroup(r.group.id); setNewGroup(''); setNewGroupOpen(false); } })}>
                    Add group
                  </button>
                </div>
              )}
            </Field>
            <Field label="Link to" optional>
              {link ? (
                <div className={styles.linkCard}>
                  <Paperclip size={15} />
                  <div className={styles.linkText}>
                    <div><span className={styles.linkType}>{link.type}</span> <span className={styles.linkNo}>{link.no}</span></div>
                    {link.name && <div className={styles.linkName}>{link.name}</div>}
                  </div>
                  <button type="button" className={styles.close} onClick={() => setLink(null)} aria-label="Remove the link"><X size={13} /></button>
                </div>
              ) : (
                <>
                  <div className={styles.search}>
                    <Search size={14} />
                    <input value={linkQ} onChange={(e) => setLinkQ(e.target.value)} aria-label="Search a document or page"
                      placeholder="Search a document or any ERP page, or paste an address" />
                  </div>
                  {q.length >= 2 && (
                    <div className={styles.results}>
                      {results.map((r) => (
                        <button type="button" key={`${r.type}:${r.to}`} className={styles.result} onClick={() => { setLink(r); setLinkQ(''); }}>
                          <span className={styles.linkType}>{r.type}</span>
                          <span className={styles.linkNo}>{r.no}</span>
                          <span className={styles.linkName}>{r.name}</span>
                        </button>
                      ))}
                      {results.length === 0 && !docs.isFetching && (
                        <div className={styles.hint}>Nothing found. Try a number like HCPV-2610, a page name, or paste an address that starts with /</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </Field>
            <Field label="Remark" optional>
              <textarea className={styles.textarea} rows={3} value={remark} onChange={(e) => setRemark(e.target.value)}
                placeholder="Anything the person doing it should know" aria-label="Remark" />
            </Field>
          </div>
          <div className={styles.foot}>
            <div className={styles.note}><Info size={15} /><span>A task you add stays in To do until someone marks it done. It never posts anything to the books.</span></div>
            <div className={styles.footButtons}>
              <button type="button" className={styles.btnSecondary} onClick={close}>Cancel</button>
              <button type="button" className={styles.btnPrimary} disabled={!ready || create.isPending} onClick={save}>Add task</button>
            </div>
          </div>
        </div>
      )}
    </ResizableDetailDrawer>
  );
}

/* ── One task ──────────────────────────────────────────────────────────── */

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';

function RemarkItem({ r, taskId }: { r: TaskRemark; taskId: string }) {
  const edit = useEditRemark();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(r.body);
  const [histOpen, setHistOpen] = useState(false);
  const save = () => {
    const t = text.trim();
    if (!t || t === r.body) { setEditing(false); return; }
    edit.mutate({ taskId, remarkId: r.id, text: t }, { onSuccess: () => setEditing(false) });
  };
  return (
    <div className={styles.remark}>
      <span className={styles.avatar}>{initials(r.authorName)}</span>
      <div className={styles.remarkMain}>
        <div className={styles.remarkHead}>
          <span className={styles.remarkWho}>{r.authorName}</span>
          <span className={styles.remarkTime}>{fmtDateTime(r.createdAt)}</span>
          {r.tag && <span className={`${styles.remarkTag} ${r.tag === 'done' ? styles.remarkTagDone : ''}`}>{r.tag === 'done' ? 'Marked done' : 'Reopened'}</span>}
          {r.history.length > 0 && r.editedAt && (
            <button type="button" className={styles.edited} onClick={() => setHistOpen(!histOpen)} title="Show earlier versions">
              edited {fmtDateTime(r.editedAt).slice(11)}{histOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
          {r.mine && r.body && !editing && <button type="button" className={styles.editLink} onClick={() => { setText(r.body); setEditing(true); }}>Edit</button>}
        </div>
        {r.body && !editing && <div className={styles.remarkText}>{r.body}</div>}
        {editing && (
          <div className={styles.editBox}>
            <textarea className={styles.textarea} rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Edit remark" />
            <div className={styles.editFoot}>
              <span className={styles.hint}>The earlier wording stays in the history.</span>
              <button type="button" className={styles.btnSecondary} onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" className={styles.btnPrimary} disabled={!text.trim() || text.trim() === r.body || edit.isPending} onClick={save}>Save</button>
            </div>
          </div>
        )}
        {histOpen && (
          <div className={styles.history}>
            {[...r.history].reverse().map((h, i) => (
              <div key={`${h.at}:${i}`} className={styles.historyItem}>
                <div className={styles.historyLabel}>{i === r.history.length - 1 ? 'Original' : 'Earlier version'} · {fmtDateTime(h.at)}</div>
                <div>{h.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const repeatWords = (t: TodoTask): string => {
  if (t.repeat === 'none') return '';
  if (t.repeat === 'day') return t.dayMode === 'wk' ? 'every weekday, Mon to Fri' : t.dayMode === 'ms' ? 'every day, Mon to Sat' : 'every day';
  if (t.repeat === 'week') return `every ${WEEKDAYS.filter(([d]) => t.weekdays.includes(d)).map(([, l]) => l).join(', ') || 'week'}`;
  if (t.repeat === 'month') {
    const every = t.everyMonths > 1 ? `every ${t.everyMonths} months` : 'every month';
    return t.monthDay === 'last' ? `${every}, last day` : `${every} ${t.byDay ? 'by' : 'on'} day ${t.monthDay ?? t.dueDate.slice(8, 10)}`;
  }
  return `every year on ${t.dueDate.slice(5, 7)}/${t.dueDate.slice(8, 10)}`;
};

export function TaskDrawer({ open, onClose, target, groups }: {
  open: boolean;
  onClose: () => void;
  target: { id: string; occursOn: string; due: string } | null;
  groups: TodoGroupDef[];
}) {
  const q = useTodoTask(open && target ? target.id : null);
  const mark = useMarkTask();
  const addRemark = useAddRemark();
  const [draft, setDraft] = useState('');
  const d = q.data;
  const t = d?.task;
  const me = d?.me;
  const groupLabel = useMemo(() => [...BUILT_IN_GROUPS, ...groups].find((g) => g.id === t?.groupKey)?.label ?? '—', [groups, t?.groupKey]);
  const occ = target ? d?.occurrences.find((o) => o.occursOn === target.occursOn) : undefined;
  const done = !!occ?.doneAt;
  const mayMark = !!t && !!me && (t.kind === 'routine' || t.assigneeId === me.id || t.createdById === me.id);
  const close = () => { setDraft(''); onClose(); };
  const markDone = () => {
    if (!target || !t) return;
    mark.mutate({ id: t.id, kind: 'done', occursOn: target.occursOn, remark: draft.trim() }, { onSuccess: close });
  };
  const sub = t
    ? `${t.kind === 'routine' ? 'Finance routine' : t.assigneeId === me?.id ? 'Your task' : `Asked of ${t.assigneeName ?? '—'}`}${t.kind === 'task' && t.createdById !== me?.id ? ` · from ${t.createdByName ?? '—'}` : ''}${done ? ' · done' : ''}`
    : '';

  return (
    <ResizableDetailDrawer open={open} onClose={close} ariaLabel="Task details">
      {open && (
        <div className={styles.drawer}>
          <div className={styles.head}>
            <div>
              <div className={styles.headTitle}>{t?.title ?? 'Task'}</div>
              <div className={styles.headSub}>{sub}</div>
            </div>
            <button type="button" className={styles.close} onClick={close} aria-label="Close"><X size={16} /></button>
          </div>
          <div className={styles.body}>
            {q.isError && <div className={styles.problem}>The task could not be read — {q.error instanceof Error ? q.error.message : 'try again'}.</div>}
            {t && target && (
              <>
                <div className={styles.meta}>
                  <span className={styles.metaKey}>Due</span>
                  <span>{fmtDate(target.due)}{t.repeat !== 'none' ? ` · ${repeatWords(t)}` : ''}</span>
                  <span className={styles.metaKey}>Assigned to</span><span>{t.kind === 'routine' ? 'Finance' : t.assigneeName ?? '—'}</span>
                  <span className={styles.metaKey}>Group</span><span>{groupLabel}</span>
                  <span className={styles.metaKey}>Linked to</span>
                  <span>{t.link ? <Link to={t.link.to} className={styles.linkChip} title={`Open ${t.link.no}`}><Paperclip size={12} />{t.link.no}</Link> : '—'}</span>
                </div>
                <div className={styles.remarks}>
                  <div className={styles.remarksHead}><span>Remarks</span><span className={styles.count}>{d.remarks.filter((r) => r.body).length}</span></div>
                  {d.remarks.map((r) => <RemarkItem key={r.id} r={r} taskId={t.id} />)}
                  {d.remarks.length === 0 && <div className={styles.hint}>No remarks yet.</div>}
                  <textarea className={styles.textarea} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a remark…" aria-label="Add a remark" />
                  <div className={styles.rightRow}>
                    <button type="button" className={styles.btnSecondary} disabled={!draft.trim() || addRemark.isPending}
                      onClick={() => addRemark.mutate({ id: t.id, text: draft.trim() }, { onSuccess: () => setDraft('') })}>Add remark</button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={styles.foot}>
            <div className={styles.footButtons}>
              <button type="button" className={styles.btnSecondary} onClick={close}>Close</button>
              {t && target && mayMark && done && (
                <button type="button" className={styles.btnSecondary} disabled={mark.isPending}
                  onClick={() => mark.mutate({ id: t.id, kind: 'reopen', occursOn: target.occursOn }, { onSuccess: close })}>Reopen</button>
              )}
              {t && target && mayMark && !done && (
                <button type="button" className={styles.btnPrimary} disabled={mark.isPending} onClick={markDone}>
                  {draft.trim() ? 'Add remark & mark done' : 'Mark done'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </ResizableDetailDrawer>
  );
}
