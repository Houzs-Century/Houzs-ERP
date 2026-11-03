// ----------------------------------------------------------------------------
// GeneralLedger — the General Ledger the AutoCount way (owner 2026-09-14, from
// his AutoCount screenshot: 点开看明细其实就是看 general ledger … gl 显示的资料也要
// 优化; docs/bugs/0924). One block per account: its code and name, a Balance
// b/f row, every line of the period with a running balance, the block's
// totals; the grand totals at the foot. The columns are his: Date · Entry ·
// Journal · Other side · Ref. 1 · Ref. 2 · Description · Debit · Credit ·
// Balance.
//
// In the owner's redesign (batch 6 §2): one toolbar row — the date range, an
// Accounts picker (tick accounts, or a From / To range), Show reversed,
// Collapse all — over resizable columns; a balance reads as an amount with its
// side (Dr / Cr); a long block shows 200 lines until asked for all; an entry's
// number (or a double-click on its line) opens the entry's card. A figure on a
// report opens its account here, and "← <report>" goes back to it.
//
// The filters live in the URL (/scm/accounting?tab=gl&accounts=…&from=…&to=…)
// so a figure on the P&L or the balance sheet opens this page on its account
// and period, and a ledger can be handed on as a link. A reversed entry and
// its contra are left out until "Show reversed" is on, and then they are
// listed and marked but move nothing (docs/bugs/0923).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronsUpDown, FileDown, FileSpreadsheet, MoreHorizontal, Printer, Search, X } from 'lucide-react';
import { DateRangeButton } from '../../components/DateRangeButton';
import { REPORT_RANGE_PRESETS, isIsoDay } from '../../lib/dateRangePresets';
import { useAccounts } from '../../vendor/scm/lib/accounting-queries';
import {
  counterLabel, downloadLedgerCsv, fmtLedger, fmtSide, journalLabel, useLedger,
  LEDGER_COLUMNS, type LedgerBlock, type LedgerLine, type LedgerParams,
} from '../../vendor/scm/lib/ledger-queries';
import { exportFileName } from '../../vendor/scm/lib/report-sheet';
import { fmtDate } from '../../vendor/shared/format';
import { AccountCell } from './JournalEntryCards';
import { useColumnWidths, type ColumnWidthSpec } from './finance/useColumnWidths';
import { AccountingHeader } from './books/AccountingHeader';
import { JournalDrawer, type JournalDrawerState } from './books/JournalDrawer';
import { balanceSide, ledgerSheet } from './books/ledger-sheet';
import { useBooksToast } from './books/BooksToast';
import tokens from './finance/finance-ui.module.css';
import s from './books/Books.module.css';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthStart = (): string => `${myt().slice(0, 7)}-01`;

/** The ledger's filters as the URL carries them — one reader for the page and for a test. */
export const ledgerParamsFromSearch = (params: URLSearchParams): LedgerParams => {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return {
    from: isIsoDay(from) ? from : monthStart(),
    to: isIsoDay(to) ? to : myt(),
    accounts: (params.get('accounts') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    fromAccount: params.get('fromAccount') ?? '',
    toAccount: params.get('toAccount') ?? '',
    showReversed: ['1', 'true'].includes(params.get('showReversed') ?? ''),
  };
};

/** What the Accounts button says it is showing. */
export function accountsLabel(p: Pick<LedgerParams, 'accounts' | 'fromAccount' | 'toAccount'>): string {
  const picked = p.accounts ?? [];
  if (picked.length === 1) return picked[0]!;
  if (picked.length > 1) return `${picked.length} accounts`;
  if (p.fromAccount || p.toAccount) return `${p.fromAccount || '…'} – ${p.toAccount || '…'}`;
  return 'All';
}

/* The design's tracks (Finance-1a-Reports, CW.gl); dates, entries, journals and figures never narrower than they read. */
const WIDTHS: ColumnWidthSpec = {
  defaults: ['76px', '104px', '52px', 'minmax(96px,1fr)', '92px', '84px', 'minmax(120px,1.4fr)', '92px', '92px', '116px'],
  min: [60, 72, 40, 56, 48, 48, 64, 56, 56, 72],
  fit: [true, true, true, false, false, false, false, true, true, true],
  gap: 8,
};
const RIGHT = [false, false, false, false, false, false, false, true, true, true];
/** Lines a block shows before "Show all N lines". */
export const BLOCK_CUT = 200;

const Balance = ({ type, sen }: { type: string; sen: number }) => {
  const b = balanceSide(type, sen);
  return <>{fmtLedger(b.sen)}{b.side && <> <span className={s.side}>{b.side}</span></>}</>;
};

const LineRow = ({ l, type, template, onOpen }: { l: LedgerLine; type: string; template: string; onOpen: (() => void) | null }) => (
  <div data-cw-row="" data-reversal={l.reversal || undefined} className={`${s.row} ${s.gap8} ${s.glLine} ${l.reversal ? s.dim : ''}`}
    style={{ gridTemplateColumns: template }} onDoubleClick={onOpen ?? undefined}>
    <span className={s.muted}>{fmtDate(l.date)}</span>
    <span className={s.cell}>
      {onOpen ? <button type="button" className={s.entryNo} onClick={onOpen} title="Open the entry">{l.jeNo}</button> : l.jeNo}
    </span>
    <span className={s.muted}>{journalLabel(l.journal)}</span>
    <span className={s.cell} title={counterLabel(l.counter)}>
      {l.counter ? <><AccountCell code={l.counter.code} name={l.counter.name} />{l.counter.more > 0 && <span className={s.soft}> +{l.counter.more}</span>}</> : '—'}
    </span>
    <span className={s.cell} title={l.doc ?? undefined}>{l.doc ?? '—'}</span>
    <span className={`${s.cell} ${s.muted}`} title={l.doc2 ?? undefined}>{l.doc2 ?? '—'}</span>
    <span className={s.cell} title={l.description ?? undefined}>
      {l.description ?? '—'}
      {l.reversal && <> <span className={`${s.tag} ${l.reversal === 'reversed' ? s.toneLate : s.toneCalm}`}>{l.reversal}</span></>}
    </span>
    <span className={s.num}>{fmtSide(l.debitSen)}</span>
    <span className={s.num}>{fmtSide(l.creditSen)}</span>
    <span className={s.num}><Balance type={type} sen={l.balanceSen} /></span>
  </div>
);

const Block = ({ b, from, template, open, onToggle, full, onShowAll, onOpenEntry }: {
  b: LedgerBlock; from: string; template: string; open: boolean; onToggle: () => void; full: boolean; onShowAll: () => void;
  onOpenEntry: (l: LedgerLine) => (() => void) | null;
}) => {
  const lines = full ? b.lines : b.lines.slice(0, BLOCK_CUT);
  return (
    <div data-account={b.code} className={s.block}>
      <div data-cw-row="" className={`${s.row} ${s.gap8} ${s.blockHead}`} style={{ gridTemplateColumns: template }}
        onClick={onToggle} title={open ? 'Click to fold the account' : 'Click to show its lines'} aria-expanded={open}>
        <span className={s.blockTitle} style={{ gridColumn: 'span 7' }}>
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          <span className={s.blockCode}>{b.code}</span>
          <span className={s.blockName}>{b.name}</span>
          <span className={s.blockCount}>{b.lines.length} {b.lines.length === 1 ? 'line' : 'lines'}</span>
        </span>
        <span className={`${s.num} ${s.blockFig}`}>{fmtLedger(b.debitSen)}</span>
        <span className={`${s.num} ${s.blockFig}`}>{fmtLedger(b.creditSen)}</span>
        <span className={`${s.num} ${s.blockFig} ${s.strong}`}><Balance type={b.type} sen={b.closingSen} /></span>
      </div>
      {open && (
        <>
          <div data-cw-row="" className={`${s.row} ${s.gap8} ${s.bfRow}`} style={{ gridTemplateColumns: template }}>
            <span>{fmtDate(from)}</span>
            <span className={s.bfLabel} style={{ gridColumn: 'span 6' }}>Balance b/f</span>
            <span /><span />
            <span className={s.num}><Balance type={b.type} sen={b.openingSen} /></span>
          </div>
          {lines.map((l) => <LineRow key={l.lineId} l={l} type={b.type} template={template} onOpen={onOpenEntry(l)} />)}
          {b.lines.length > lines.length && (
            <div className={s.moreLines}>
              <button type="button" className={s.moreLink} onClick={onShowAll}>Show all {b.lines.length} lines</button>
            </div>
          )}
          <div data-cw-row="" className={`${s.row} ${s.gap8} ${s.totalRow}`} style={{ gridTemplateColumns: template }}>
            <span className={s.cell} style={{ gridColumn: 'span 7' }}>Total · {b.code} {b.name}</span>
            <span className={s.num}>{fmtLedger(b.debitSen)}</span>
            <span className={s.num}>{fmtLedger(b.creditSen)}</span>
            <span className={s.num}><Balance type={b.type} sen={b.closingSen} /></span>
          </div>
        </>
      )}
    </div>
  );
};

/** The Accounts button and its popover: tick accounts, or a From / To range. */
function AccountsPicker({ p, chart, onPick }: {
  p: LedgerParams;
  chart: Array<{ account_code: string; account_name: string }>;
  onPick: (patch: Partial<LedgerParams>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const picked = p.accounts ?? [];
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  /* Typed to: every word must match the code or the name. */
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = chart.filter((a) => words.every((w) => `${a.account_code} ${a.account_name}`.toLowerCase().includes(w)));
  const toggle = (code: string) =>
    onPick({ accounts: picked.includes(code) ? picked.filter((c) => c !== code) : [...picked, code], fromAccount: '', toAccount: '' });
  return (
    <div ref={ref} className={s.pickWrap}>
      <button type="button" className={`${s.pickBtn} ${open ? s.pickBtnOpen : ''}`} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}>
        <span className={s.soft}>Accounts</span><span className={s.pickValue}>{accountsLabel(p)}</span><ChevronDown size={12} aria-hidden className={s.soft} />
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label="Pick accounts">
          <div className={s.popSearch}>
            <label className={s.search} style={{ maxWidth: 'none', minWidth: 0 }}>
              <Search size={13} aria-hidden />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a code or a name" aria-label="Find an account" />
            </label>
          </div>
          <div className={s.popList}>
            {shown.map((a) => {
              const on = picked.includes(a.account_code);
              return (
                <button key={a.account_code} type="button" role="menuitemcheckbox" aria-checked={on} className={s.popItem} onClick={() => toggle(a.account_code)}>
                  <span className={`${s.tick} ${on ? s.tickOn : ''}`}>{on && <Check size={11} strokeWidth={3} aria-hidden />}</span>
                  <span className={s.popCode}>{a.account_code}</span>
                  <span className={s.popName}>{a.account_name}</span>
                </button>
              );
            })}
            {shown.length === 0 && <div className={s.popEmpty}>No account matches.</div>}
          </div>
          <div className={s.popRange}>
            <span className={s.toolLabel}>Or a range</span>
            {picked.length > 0 ? (
              <span className={s.hint}>Untick the accounts to use a range.</span>
            ) : (
              <div className={s.popRangeRow}>
                {(['fromAccount', 'toAccount'] as const).map((k) => (
                  <span key={k} className={s.selectWrap}>
                    <select className={s.select} value={p[k] ?? ''} aria-label={k === 'fromAccount' ? 'From account' : 'To account'}
                      onChange={(e) => onPick({ [k]: e.target.value })}>
                      <option value="">{k === 'fromAccount' ? 'From the first' : 'To the last'}</option>
                      {chart.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_code} {a.account_name}</option>)}
                    </select>
                    <ChevronDown size={12} className={s.selectChevron} aria-hidden />
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className={s.popFoot}>
            <button type="button" className={s.linkBtn} onClick={() => onPick({ accounts: [], fromAccount: '', toAccount: '' })}>All accounts</button>
            <span className={s.grow} />
            <button type="button" className={s.btnPrimary} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MoreMenu({ items }: { items: Array<{ label: string; onClick: () => void; disabled?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  return (
    <div ref={ref} className={s.menuWrap}>
      <button type="button" className={s.more} aria-label="More" title="More" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className={s.menu} role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={s.menuItem} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export const GeneralLedger = () => {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const p = useMemo(() => ledgerParamsFromSearch(params), [params]);
  const accounts = useAccounts();
  /* A figure on a report opened this ledger: the way back (batch 6 §1.2). */
  const back = (location.state as { back?: { to: string; label: string } } | null)?.back ?? null;

  /* Every filter change is written to the URL — the page keeps only what is folded open. */
  const update = (patch: Partial<LedgerParams>) => {
    const next = { ...p, ...patch };
    const q = new URLSearchParams(params);
    q.set('tab', 'gl');
    q.set('from', next.from);
    q.set('to', next.to);
    if (next.accounts && next.accounts.length > 0) q.set('accounts', next.accounts.join(',')); else q.delete('accounts');
    if (next.fromAccount) q.set('fromAccount', next.fromAccount); else q.delete('fromAccount');
    if (next.toAccount) q.set('toAccount', next.toAccount); else q.delete('toAccount');
    if (next.showReversed) q.set('showReversed', '1'); else q.delete('showReversed');
    setParams(q, { replace: true, state: location.state });
  };

  const chart = useMemo(() => [...(accounts.data?.accounts ?? [])].sort((a, b) => a.account_code.localeCompare(b.account_code)), [accounts.data]);
  const nameOf = (code: string) => chart.find((a) => a.account_code === code)?.account_name ?? '';
  const picked = p.accounts ?? [];

  const rangeOk = isIsoDay(p.from) && isIsoDay(p.to) && p.from <= p.to;
  const q = useLedger(p, rangeOk);
  const r = rangeOk ? q.data : undefined;

  const cw = useColumnWidths('gl', WIDTHS);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [full, setFull] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState<JournalDrawerState | null>(null);
  const toast = useBooksToast();
  const allOpen = closed.size === 0;
  const toggleBlock = (code: string) => setClosed((cur) => {
    const next = new Set(cur);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const excel = async () => {
    if (!r) return;
    const { downloadReportXlsx } = await import('../../vendor/scm/lib/report-sheet-xlsx');
    await downloadReportXlsx(ledgerSheet(r, accountsLabel(p) === 'All' ? 'Every account' : accountsLabel(p)), exportFileName('general-ledger', r.from, r.to, 'xlsx'));
  };
  const pdf = (action: 'preview' | 'print') => {
    if (r) void import('../../vendor/scm/lib/ledger-pdf').then((m) => m.generateLedgerPdf(r, { action }));
  };

  const actions = (
    <div className={s.headActions}>
      <button type="button" className={s.btn} disabled={!r} onClick={() => { void excel(); }}><FileSpreadsheet size={14} aria-hidden />Excel</button>
      <button type="button" className={s.btn} disabled={!r} onClick={() => pdf('preview')}><FileDown size={14} aria-hidden />PDF</button>
      <button type="button" className={s.btn} disabled={!r} onClick={() => pdf('print')}><Printer size={14} aria-hidden />Print</button>
      <MoreMenu items={[{ label: 'CSV', disabled: !r, onClick: () => { if (r) downloadLedgerCsv(r); } }]} />
    </div>
  );
  const n = r?.blocks.length ?? 0;
  const description = rangeOk
    ? `${p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)} – ${fmtDate(p.to)}`}${r ? ` · ${n} ${n === 1 ? 'account' : 'accounts'}` : ''}`
    : 'Check the dates';

  return (
    <div className={`${tokens.root} ${s.page}`}>
      {back && (
        <button type="button" className={s.backLink} onClick={() => navigate(back.to)}>
          <ArrowLeft size={13} aria-hidden />{back.label}
        </button>
      )}
      <AccountingHeader tab="gl" description={description} actions={actions} />

      <div className={s.tools}>
        <DateRangeButton from={p.from} to={p.to} presets={REPORT_RANGE_PRESETS} today={myt()} label="Ledger dates"
          onChange={(from, to) => update({ from, to })} />
        <AccountsPicker p={p} chart={chart} onPick={update} />
        {picked.length > 0 && (
          <span className={s.chips}>
            {picked.map((code) => (
              <span key={code} className={s.chip}>
                {code} {nameOf(code)}
                <button type="button" className={s.chipX} title="Remove" aria-label={`Remove ${code}`}
                  onClick={() => update({ accounts: picked.filter((c) => c !== code) })}><X size={11} aria-hidden /></button>
              </span>
            ))}
          </span>
        )}
        <span className={s.grow} />
        <button type="button" role="switch" aria-checked={Boolean(p.showReversed)} className={`${s.switch} ${p.showReversed ? s.switchOn : ''}`}
          onClick={() => update({ showReversed: !p.showReversed })}>
          <span className={s.switchTrack} aria-hidden><span className={s.switchKnob} /></span>Show reversed
        </button>
        <button type="button" className={s.linkBtn} disabled={n === 0}
          onClick={() => setClosed(allOpen ? new Set((r?.blocks ?? []).map((b) => b.code)) : new Set())}>
          <ChevronsUpDown size={13} aria-hidden />{allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <div className={s.toolNote}>
        {picked.length === 0 && !p.fromAccount && !p.toAccount && <span>Every account with a balance or a movement in the period.</span>}
        <span>
          {p.showReversed ? 'Reversed entries and their contras are listed and marked; they move no balance and no total.' : 'Reversed entries and their contras are left out — they undo each other.'}
        </span>
      </div>

      {!rangeOk && <div className={s.problem}>From is later than To — adjust the dates.</div>}
      {rangeOk && q.isError && <div className={s.problem}>The ledger did not load — adjust the filters to retry.</div>}

      {rangeOk && !q.isError && (
        <div className={s.card}>
          <div className={s.scroll}>
            <div data-cw-root="gl" style={{ minWidth: cw.minWidth }}>
              <div data-cw-row="" className={`${s.row} ${s.gap8} ${s.gridHead}`} style={{ gridTemplateColumns: cw.template }}>
                {LEDGER_COLUMNS.map((label, i) => (
                  <span key={label} data-cw-cell={i} className={`${s.headCell} ${RIGHT[i] ? s.right : ''}`}>
                    <span data-cw-lbl="">{label}</span>
                    <span className={s.resize} {...cw.handle(i)}><span className={s.resizeLine} /></span>
                  </span>
                ))}
              </div>
              {q.isLoading && (
                <div className={s.skeleton} aria-label="Working the ledger out">
                  {[0, 1, 2, 3, 4].map((i) => <div key={i} className={s.skeletonBar} style={{ width: `${92 - i * 9}%` }} />)}
                </div>
              )}
              {r?.blocks.map((b) => (
                <Block key={b.code} b={b} from={r.from} template={cw.template} open={!closed.has(b.code)} onToggle={() => toggleBlock(b.code)}
                  full={full.has(b.code)} onShowAll={() => setFull((cur) => new Set(cur).add(b.code))}
                  onOpenEntry={(l) => (l.jeId ? () => setDrawer({ mode: 'card', id: l.jeId as string, refs: { journal: journalLabel(l.journal), doc: l.doc, doc2: l.doc2, who: l.who } }) : null)} />
              ))}
              {r && r.blocks.length === 0 && <div className={s.empty}>Nothing moved on these accounts in the period, and nothing was brought forward.</div>}
              {r && r.blocks.length > 0 && (
                <div data-cw-row="" className={`${s.row} ${s.gap8} ${s.grandRow}`} style={{ gridTemplateColumns: cw.template }}>
                  <span style={{ gridColumn: 'span 7' }}>Grand total · {n} {n === 1 ? 'account' : 'accounts'}</span>
                  <span className={s.num}>{fmtLedger(r.totals.debitSen)}</span>
                  <span className={s.num}>{fmtLedger(r.totals.creditSen)}</span>
                  <span />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {cw.custom && (
        <div className={s.resetRow}><button type="button" className={s.resetLink} onClick={cw.reset}>Reset column widths</button></div>
      )}

      <JournalDrawer state={drawer} onChange={setDrawer} onClose={() => setDrawer(null)} onToast={toast.say}
        backLabel="General ledger" range={rangeOk ? { from: p.from, to: p.to } : null} />
      {toast.node}
    </div>
  );
};
