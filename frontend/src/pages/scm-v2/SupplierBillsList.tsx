// ----------------------------------------------------------------------------
// SupplierBillsList — Money out › Supplier bills in the owner's Claude Design
// (batch 4, step 5). The AP bills raised here, Procurement's purchase invoices
// and the suppliers' credit notes on ONE table: kind tabs with counts, the
// supplier filter (all trade creditors · 400, all other creditors · 405, or one
// supplier), the search, status chips with counts, a sand tint on whatever is
// still open, ticks with a running total, the row's next step as its button
// and everything else under ⋯ (or a right-click).
//
// The page (ApInvoices.tsx) owns the pop-outs, the forms and every post; this
// file only shows the rows and says which step was asked for. Printing posts
// nothing, so it lives here (step 8): the ticks print as one document in list
// order, With files puts each paper's stored files after it, and a row prints
// alone from its Print link or its ⋯ (useSupplierBillsPrint.ts).
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileDown, MoreHorizontal, Printer, Search, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataTable, type Column } from '../../components/DataTable';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useCreditNotes } from '../../vendor/scm/lib/credit-note-queries';
import type { ApListRow } from '../../vendor/scm/lib/ap-invoice-queries';
import { fmtDateOrDash, fmtSen, todayMY } from '../../vendor/shared/format';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import {
  billKindWord, billTag, chipLabel, chipsOf, controlWord, daysLate, fromApRow, fromNote, inChip, inKind, isOpen, kindTabLabel, lifeOf,
  matchesBill, ofSupplier, signedSen, sortBills, type BillChip, type BillKindTab, type BillRow, type BillTone,
} from './supplier-bills';
import { billPrintDocOf, useSupplierBillsPrint } from './useSupplierBillsPrint';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import mo from './MoneyOut.module.css';

/** What a row asks the page to do. */
export type BillAction = 'open' | 'post' | 'edit' | 'copy' | 'cancel' | 'makeVoucher' | 'plan';

type Props = {
  /** The AP bills and purchase invoices; null until the list has loaded. */
  apRows: ApListRow[] | null;
  apLoading: boolean;
  apError: string | null;
  can: { create: boolean; post: boolean; cancel: boolean };
  onAct: (action: BillAction, row: BillRow) => void;
  /** Print listing: exactly the rows on screen, with the filter in words. */
  onPrintListing: (rows: BillRow[], showing: string) => void;
};

const KIND_TABS: BillKindTab[] = ['ALL', 'API', 'PI', 'SCN'];
const TONE: Record<BillTone, string> = { calm: mo.toneCalm, warn: mo.toneWarn, info: mo.toneInfo, late: mo.toneLate };
/* The design's sand: a posted bill still owed, a credit note not used yet. */
const OPEN_BG = 'var(--hz-dk-warning-bg, #fcf7ec)';

type MenuItem = { label: string; onClick: () => void; danger?: boolean; divider?: boolean };

export function SupplierBillsList({ apRows, apLoading, apError, can, onAct, onPrintListing }: Props) {
  const today = todayMY();
  const [tab, setTab] = useState<BillKindTab>('ALL');
  const [chip, setChip] = useState<BillChip>('all');
  const [pick, setPick] = useState('all');
  const [q, setQ] = useState('');
  /* The books' opening credits (AutoCount's supplier payments not knocked off
     at 31/08) on their own chip under Credit notes, as on the CN / DN page. */
  const [openingOnly, setOpeningOnly] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<BillRow[] | null>(null);
  const [menu, setMenu] = useState<{ row: BillRow; x: number; y: number } | null>(null);
  /* Files or not is the operator's call per batch — on by default, as on Payment vouchers. */
  const [withFiles, setWithFiles] = useState(true);
  const prints = useSupplierBillsPrint();
  const printRows = (rows: BillRow[], files: boolean, action: PdfAction = 'print') => { void prints.print(rows.map(billPrintDocOf), files, action); };

  const notesQ = useCreditNotes('AP', 'SCN', 'ALL', openingOnly ? 'only' : 'exclude');
  const notesError = notesQ.isError ? (notesQ.error instanceof Error ? notesQ.error.message : 'something went wrong') : null;

  const noteRows = notesQ.data?.rows;
  const allRows = useMemo<BillRow[]>(() => [
    ...(openingOnly ? [] : (apRows ?? []).map(fromApRow)),
    ...(noteRows ?? []).map(fromNote),
  ], [apRows, noteRows, openingOnly]);

  /* The supplier filter: everyone, a control, or one supplier on the list. */
  const supplierOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of allRows) if (r.supplierId && r.supplierName) seen.set(r.supplierId, `${r.supplierCode ? `${r.supplierCode} · ` : ''}${r.supplierName}`);
    const named = [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    return [
      { value: '', label: 'All suppliers' },
      { value: 'trade', label: 'All trade creditors · 400' },
      { value: 'other', label: 'All other creditors · 405' },
      ...named,
    ];
  }, [allRows]);

  const base = useMemo(() => allRows.filter((r) => ofSupplier(r, pick) && matchesBill(r, q)), [allRows, pick, q]);
  const visible = useMemo(() => sortBills(base.filter((r) => inKind(r, tab) && inChip(r, chip, today)), chip), [base, tab, chip, today]);
  const tabCount = (t: BillKindTab) => base.filter((r) => inKind(r, t) && inChip(r, chip, today)).length;
  const chipCount = (c: BillChip) => base.filter((r) => inKind(r, tab) && inChip(r, c, today)).length;

  const pickTab = (t: BillKindTab) => {
    setTab(t);
    if (t === 'SCN' && chip === 'overdue') setChip('all');
    if (t !== 'SCN') setOpeningOnly(false);
    setTicked(new Set());
  };

  const tickedRows = allRows.filter((r) => ticked.has(r.key));
  /* The rows on screen after the table's own filters, in the order shown: the
     ticked ones among them are what Print and Save as PDF send. */
  const onScreen = shown ?? visible;
  const printTargets = onScreen.filter((r) => ticked.has(r.key));
  const onScreenKeys = new Set(onScreen.map((r) => r.key));
  const hiddenTicked = tickedRows.filter((r) => !onScreenKeys.has(r.key)).length;

  const showing = [
    kindTabLabel(tab) === 'All' ? 'All kinds' : kindTabLabel(tab),
    supplierOptions.find((o) => o.value === (pick === 'all' ? '' : pick))?.label ?? 'All suppliers',
    chip === 'all' ? 'Any status' : chipLabel(chip, tab),
    openingOnly ? 'Opening 31/08' : '',
    q.trim() ? `search “${q.trim()}”` : '',
  ].filter(Boolean).join(' · ');

  /* ⋯ and right-click: the design's menu, with what this ERP can do today. */
  const menuOf = (r: BillRow): MenuItem[] => {
    const life = lifeOf(r.status);
    const items: MenuItem[] = [{ label: 'Open', onClick: () => onAct('open', r) }];
    if (can.create && r.kind !== 'PI' && life !== 'cancelled' && (r.kind === 'API' || life === 'draft')) items.push({ label: 'Edit', onClick: () => onAct('edit', r) });
    if (can.post && life === 'draft') items.push({ label: r.kind === 'SCN' ? 'Post to ledger' : 'Post', onClick: () => onAct('post', r) });
    /* When we plan to pay it (step 7): a posted bill still owed. */
    if (can.create && r.kind !== 'SCN' && life === 'posted' && isOpen(r)) items.push({ label: 'Plan date', onClick: () => onAct('plan', r) });
    /* Printed in place (step 8): the paper alone, or with its stored files — a purchase invoice keeps none here. */
    items.push({ label: '', onClick: () => undefined, divider: true }, { label: 'Print', onClick: () => printRows([r], false) });
    if (r.kind !== 'PI') items.push({ label: 'Print + files', onClick: () => printRows([r], true) });
    if (can.create && r.kind === 'API') items.push({ label: 'Copy as new', onClick: () => onAct('copy', r) });
    if (can.cancel && r.kind !== 'PI' && life !== 'cancelled' && r.paidSen === 0 && !(r.kind === 'SCN' && openingOnly)) {
      items.push({ label: '', onClick: () => undefined, divider: true }, { label: r.kind === 'SCN' ? 'Cancel note…' : r.debitNote ? 'Cancel debit note…' : 'Cancel bill…', onClick: () => onAct('cancel', r), danger: true });
    }
    return items;
  };

  /* The row's next step (the design's rowAct), ⋯ last. */
  const rowButtons = (r: BillRow) => {
    const life = lifeOf(r.status);
    let primary: ReactNode = null;
    if (life === 'draft') {
      if (can.post) primary = <button type="button" className={mo.act} onClick={() => onAct('post', r)}>{r.kind === 'SCN' ? 'Post to ledger' : 'Post'}</button>;
    } else if (life === 'posted' && isOpen(r)) {
      primary = r.kind === 'SCN'
        /* Its credit is knocked off on the note itself (#4415) — the pop-out opens on it. */
        ? <button type="button" className={mo.act} onClick={() => onAct('open', r)} title="Tick the supplier's bills this credit takes off">Knock off</button>
        : can.create && (
          <button type="button" className={mo.act} disabled={r.held} onClick={() => onAct('makeVoucher', r)}
            title={r.held ? `On hold · ${r.holdReason ?? 'held in Procurement'} — take it off hold there first` : 'Draft an AP payment for this bill'}>
            Make voucher
          </button>
        );
    } else {
      /* Paid, used or cancelled — the design's Print link (step 8); its files ride ⋯ Print + files. */
      primary = (
        <button type="button" className={mo.actLink} disabled={prints.printing}
          onClick={(e) => { e.stopPropagation(); printRows([r], false); }}>Print</button>
      );
    }
    return (
      <span className={mo.acts}>
        {primary}
        <button type="button" className={mo.more} aria-label={`${r.number} menu`} title="View, edit, copy, cancel"
          onClick={(e) => { e.stopPropagation(); setMenu({ row: r, x: e.clientX, y: e.clientY }); }}>
          <MoreHorizontal size={14} />
        </button>
      </span>
    );
  };

  const columns: Column<BillRow>[] = [
    { key: 'kind', label: 'Kind', defaultHidden: true, render: (r) => billKindWord(r), getValue: (r) => billKindWord(r) },
    {
      key: 'number', label: 'No.',
      render: (r) => (
        <span className={mo.tags}>
          {r.kind === 'PI'
            ? <Link to={`/scm/purchase-invoices/${r.id}`} className={`${mo.docLink} ${cancelledDocNoClass(r.status)}`}>{r.number}</Link>
            : <button type="button" className={`${mo.docLink} ${cancelledDocNoClass(r.status)}`} onClick={() => onAct('open', r)}>{r.number}</button>}
          {r.debitNote && <span className={`${mo.tag} ${mo.toneWarn}`}>Debit note</span>}
        </span>
      ),
      getValue: (r) => r.number,
    },
    {
      key: 'supplier', label: 'Supplier',
      render: (r) => <>{r.supplierName ?? '—'}{r.supplierCode ? <span className={mo.hint}> · {r.supplierCode}</span> : null}</>,
      getValue: (r) => r.supplierName ?? '',
    },
    {
      key: 'control', label: 'Control',
      render: (r) => (r.controlRole ? <span className={`${mo.tag} ${r.controlRole === 'AP_OTHER' ? mo.toneWarn : mo.toneCalm}`}>{controlWord(r)}</span> : '—'),
      getValue: (r) => controlWord(r),
    },
    { key: 'ref', label: 'Ref', render: (r) => r.ref ?? '—', getValue: (r) => r.ref ?? '' },
    { key: 'description', label: 'Description', width: '240px', render: (r) => <span className={mo.hint}>{r.description ?? ''}</span>, getValue: (r) => r.description ?? '' },
    { key: 'date', label: 'Date', defaultHidden: true, render: (r) => fmtDateOrDash(r.date), getValue: (r) => r.date, exportFormat: 'date' },
    {
      key: 'due', label: 'Due',
      render: (r) => (r.kind === 'SCN' || !r.due ? '—'
        : <span className={lifeOf(r.status) === 'posted' && isOpen(r) && daysLate(r.due, today) > 0 ? mo.dueLate : undefined}>{fmtDateOrDash(r.due)}</span>),
      getValue: (r) => r.due, exportFormat: 'date',
    },
    /* When we plan to pay it (step 7) — shown on what is still owed. */
    { key: 'planned', label: 'Planned', render: (r) => (r.planned ? fmtDateOrDash(r.planned) : '—'), getValue: (r) => r.planned, exportFormat: 'date' },
    {
      key: 'total', label: 'Total', align: 'right', defaultHidden: true, render: (r) => <span className={mo.money}>{fmtSen(r.totalSen)}</span>,
      getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money',
    },
    {
      key: 'outstanding', label: 'Outstanding', align: 'right',
      render: (r) => (r.outstandingSen == null ? '' : <span className={mo.money}>{fmtSen(r.outstandingSen)}</span>),
      getValue: (r) => r.outstandingSen, exportValue: (r) => (r.outstandingSen == null ? null : r.outstandingSen / 100), exportFormat: 'money',
    },
    {
      key: 'status', label: 'Status',
      render: (r) => { const t = billTag(r, today); return <span className={`${mo.tag} ${TONE[t.tone]}`}>{t.text}</span>; },
      getValue: (r) => billTag(r, today).text,
    },
    { key: 'actions', label: '', align: 'right', width: '170px', disableSort: true, disableFilter: true, render: (r) => rowButtons(r) },
  ];

  const tickedSum = tickedRows.reduce((s, r) => s + signedSen(r), 0);

  return (
    <div className={mo.top}>
      <div className={mo.row}>
        <div className={mo.seg} role="tablist" aria-label="Kind of paper">
          {KIND_TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`${mo.segBtn} ${tab === t ? mo.segOn : ''}`} onClick={() => pickTab(t)}>
              {kindTabLabel(t)} <span className={mo.segCount}>{tabCount(t)}</span>
            </button>
          ))}
        </div>
        <span className={mo.grow} />
        <div className={mo.supplierPick}>
          <SearchCombo options={supplierOptions} value={pick === 'all' ? '' : pick} onChange={(v) => setPick(v || 'all')}
            className={mo.pickInput} aria-label="Filter by supplier" placeholder="All suppliers" />
        </div>
        <label className={mo.search}>
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a bill · no., supplier, ref, amount" aria-label="Find a bill" />
          {q && <button type="button" className={mo.clear} onClick={() => setQ('')} aria-label="Clear the search"><X size={12} /></button>}
        </label>
        <Button variant="secondary" size="sm" onClick={() => onPrintListing(shown ?? visible, showing)} disabled={(shown ?? visible).length === 0}>
          <Printer size={14} /> Print listing
        </Button>
      </div>

      <div className={mo.row} role="group" aria-label="Status">
        {chipsOf(tab).map((c) => (
          <button key={c} type="button" className={`${mo.month} ${chip === c ? mo.monthOn : ''}`} aria-pressed={chip === c} onClick={() => setChip(c)}>
            {chipLabel(c, tab)} <span className={mo.monthCount}>{chipCount(c)}</span>
          </button>
        ))}
        {tab === 'SCN' && (
          <button type="button" className={`${mo.month} ${openingOnly ? mo.monthOn : ''}`} aria-pressed={openingOnly}
            onClick={() => { setOpeningOnly((v) => !v); setTicked(new Set()); }} title="AutoCount's supplier payments not knocked off at 31/08">
            Opening 31/08
          </button>
        )}
      </div>

      {notesError && <div className={mo.hint} role="alert">The credit notes did not load — {notesError}</div>}

      {ticked.size > 0 && (
        <div className={mo.tickBar} aria-label="Ticked bills">
          <b>{ticked.size} ticked</b>
          <span className={mo.money}>· {tickedSum < 0 ? '−' : ''}{fmtSen(Math.abs(tickedSum))}</span>
          {hiddenTicked > 0 && <span className={mo.hint}>· {hiddenTicked} hidden by a filter, left out</span>}
          <span className={mo.grow} />
          {/* The ticked papers as ONE document, in list order (step 8); With
              files puts each one's stored files right after it. */}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)}
              aria-label="Include each document's attached files" style={{ width: 14, height: 14, accentColor: '#16695f' }} />
            With files
          </label>
          <Button variant="secondary" size="sm" onClick={() => printRows(printTargets, withFiles)} disabled={prints.printing || printTargets.length === 0}>
            <Printer size={14} /> {prints.printing ? 'Preparing…' : `Print ${printTargets.length}${withFiles ? ' + files' : ''}`}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => printRows(printTargets, withFiles, 'save')} disabled={prints.printing || printTargets.length === 0}>
            <FileDown size={14} /> Save as PDF
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setTicked(new Set())}>Clear</Button>
        </div>
      )}

      <DataTable<BillRow>
        tableId="ap-invoices"
        exportName="supplier-bills"
        exportXlsx
        columns={columns}
        rows={apRows || notesQ.data ? visible : null}
        loading={apLoading || notesQ.isLoading}
        error={apError}
        emptyLabel={q.trim()
          ? `No bill matches “${q.trim()}”.`
          : allRows.length === 0
            ? 'No supplier bill yet — New AP bill raises one.'
            : 'No bill in this view — pick another kind, status or supplier.'}
        getRowKey={(r) => r.key}
        getRowClassName={(r) => cancelledRowClass(r.status)}
        getRowStyle={(r) => (lifeOf(r.status) === 'cancelled' ? { opacity: 0.55 } : lifeOf(r.status) === 'posted' && isOpen(r) ? { backgroundColor: OPEN_BG } : undefined)}
        onRowDoubleClick={(r) => onAct('open', r)}
        contextMenu={(r) => menuOf(r)}
        onFilteredRowsChange={setShown}
        selection={{
          selectedIds: ticked,
          onToggle: (k) => setTicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
          onToggleAll: (keys, all) => setTicked((p) => { const n = new Set(p); for (const k of keys) { if (all) n.delete(k); else n.add(k); } return n; }),
          rowLabel: (r) => `Tick ${r.number}`,
        }}
      />

      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onClick={() => setMenu(null)} aria-hidden />
          <div className={mo.menu} role="menu" aria-label={`${menu.row.number} menu`}
            style={{ top: Math.max(8, Math.min(menu.y + 6, window.innerHeight - 320)), left: Math.max(8, menu.x - 180) }}>
            {menuOf(menu.row).map((m, i) => (m.divider
              ? <div key={`d${i}`} className={mo.menuRule} />
              : (
                <button key={m.label} type="button" role="menuitem" className={`${mo.menuItem} ${m.danger ? mo.menuDanger : ''}`}
                  onClick={() => { setMenu(null); m.onClick(); }}>{m.label}</button>
              )))}
          </div>
        </>
      )}
    </div>
  );
}
