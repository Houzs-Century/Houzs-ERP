// ----------------------------------------------------------------------------
// PurchaseReturnFromGrn — pick ONE posted Goods Received note, then tick only
// the lines going back to the supplier (HC-0135, Sim 2026-10-21: "open PR &
// click transfer from GRN & shown all item, we only tick the item need to
// return not full item from GRN").
//
// Two steps on one route, driven by the URL:
//   (no grnId)  search the posted notes and click one;
//   ?grnId=X    the note's lines, each with a tick and a qty capped at its
//               remaining (accepted - already returned). Nothing is ticked on
//               arrival: a return is usually a few lines of a note, not all.
//
// One note per return, because the return header carries a single source GRN.
// Continue stashes { grnId, picks } and opens the normal New Purchase Return
// form, which builds only the picked lines. No stock moves until Create.
//
// Routing: /scm/purchase-returns/from-grn. The GRN screens' "Transfer to
// Purchase Return" lands here scoped to their note (lib/convertScope grnToPr).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckSquare, Square, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { buildVariantSummary, fmtQty } from '@2990s/shared';
import { writeScmHandoff } from '../../lib/scmHandoffStorage';
import { readConvertScope, UnrecognisedScopeNotice } from '../../lib/convertScope';
import { useGrnDetail, useGrnsPaged } from '../../vendor/scm/lib/grn-queries';
import { useDebouncedValue } from '../../vendor/scm/lib/hooks';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { ItemGroupPill } from '../../vendor/scm/lib/category-badges';
import { VariantDescription } from '../../vendor/scm/components/VariantDescription';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { SearchInput } from '../../components/Button';
import { fmtDateOrDash, fmtMoneySen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export type PrFromGrnPicks = { grnId: string; picks: Array<{ grnItemId: string; qty: number }> };

type GrnHeaderRow = {
  id: string;
  grn_number: string;
  received_at?: string | null;
  delivery_note_ref?: string | null;
  fully_returned?: boolean;
  supplier?: { name?: string | null; code?: string | null } | null;
  purchase_order?: { po_number?: string | null } | null;
  total_sen?: number | null;
  currency?: string | null;
};

type GrnLine = {
  id: string;
  item_code: string;
  material_name: string | null;
  item_group: string | null;
  description: string | null;
  variants: Record<string, unknown> | null;
  qty_accepted: number | null;
  returned_qty: number | null;
  unit_price_sen: number | null;
};

const remainingOf = (l: GrnLine): number =>
  Math.max(0, Number(l.qty_accepted ?? 0) - Number(l.returned_qty ?? 0));

const QTY_INPUT = {
  height: 28, width: 84, textAlign: 'right' as const,
  border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '0 8px',
  fontSize: 'var(--fs-12)', background: 'var(--c-paper)', color: 'var(--c-ink)',
};

const GrnChooser = ({ onPick }: { onPick: (id: string) => void }) => {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const grnsQ = useGrnsPaged({ page: 0, pageSize: 50, status: 'posted', q: q || undefined });
  const rows = useMemo(
    () => ((grnsQ.data?.grns ?? []) as GrnHeaderRow[]).filter((g) => !g.fully_returned),
    [grnsQ.data],
  );

  const columns = useMemo<GridColumn<GrnHeaderRow>[]>(() => [
    { key: 'grn_number', label: 'GRN No', width: 160, accessor: (g) => <span className={styles.codeCell}>{g.grn_number}</span> },
    { key: 'received_at', label: 'Received', width: 110, accessor: (g) => fmtDateOrDash(g.received_at ?? null) },
    { key: 'supplier', label: 'Supplier', width: 260, accessor: (g) => g.supplier?.name ?? '—' },
    { key: 'po', label: 'PO', width: 150, accessor: (g) => g.purchase_order?.po_number ?? '—' },
    { key: 'dn', label: 'Supplier DO No', width: 140, accessor: (g) => g.delivery_note_ref ?? '—' },
    { key: 'total', label: 'Total', width: 120, align: 'right', accessor: (g) => fmtMoneySen(Number(g.total_sen ?? 0), g.currency ?? 'MYR'), exportValue: (g) => Number(g.total_sen ?? 0) / 100, exportFormat: 'money' },
  ], []);

  return (
    <>
      <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
        Step 1 of 2: choose the Goods Received note the goods came in on. Only posted notes are listed.
      </p>
      <SearchInput value={search} onChange={setSearch} placeholder="Search GRN no or supplier DO no…" aria-label="Search Goods Received" />
      <DataGridCompat<GrnHeaderRow>
        rows={rows}
        columns={columns}
        storageKey="pr-from-grn.chooser.layout.v1"
        rowKey={(g) => g.id}
        hideSearch
        onRowClick={(g) => onPick(g.id)}
        groupBanner={false}
        isLoading={grnsQ.isLoading}
        emptyMessage={grnsQ.isError
          ? "We couldn't load the Goods Received notes. Refresh and try again."
          : 'No posted Goods Received note matches this search. The search reads the GRN no and the supplier DO no in the company you are working in.'}
      />
    </>
  );
};

export const PurchaseReturnFromGrn = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const [params, setParams] = useSearchParams();
  const scope = readConvertScope('grnToPr', params, []);
  const grnId = [...scope.keys][0] ?? null;

  const detailQ = useGrnDetail(grnId);
  const grn = (detailQ.data?.grn ?? null) as GrnHeaderRow | null;
  const lines = useMemo(() => (detailQ.data?.items ?? []) as GrnLine[], [detailQ.data]);

  const [picks, setPicks] = useState<Record<string, number>>({});
  const picked = Object.entries(picks).filter(([, qty]) => qty > 0);

  const choose = (id: string | null) => {
    setPicks({});
    const next = new URLSearchParams();
    if (id) next.set('grnId', id);
    setParams(next);
  };

  const toggle = (l: GrnLine) => {
    const rem = remainingOf(l);
    if (rem <= 0) return;
    setPicks((s) => {
      const next = { ...s };
      if (next[l.id]) delete next[l.id]; else next[l.id] = rem;
      return next;
    });
  };
  const setQty = (l: GrnLine, qty: number) => {
    const rem = remainingOf(l);
    setPicks((s) => ({ ...s, [l.id]: Math.min(rem, Math.max(0, qty)) }));
  };
  const selectAll = () => setPicks(() => {
    const next: Record<string, number> = {};
    for (const l of lines) { const rem = remainingOf(l); if (rem > 0) next[l.id] = rem; }
    return next;
  });

  const columns = useMemo<GridColumn<GrnLine>[]>(() => [
    {
      key: 'pick', label: '', width: 40, sortable: false, groupable: false,
      accessor: (l) => (
        <input
          type="checkbox"
          checked={Boolean(picks[l.id])}
          disabled={remainingOf(l) <= 0}
          onChange={() => toggle(l)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Pick ${l.item_code}`}
        />
      ),
    },
    { key: 'itemGroup', label: 'Category', width: 110, accessor: (l) => <ItemGroupPill group={l.item_group} /> },
    { key: 'itemCode', label: 'Item Code', width: 160, accessor: (l) => <span style={{ fontWeight: 600 }}>{l.item_code}</span>, searchValue: (l) => l.item_code },
    {
      key: 'material', label: 'Description', width: 280,
      accessor: (l) => (
        <div>
          <div>{l.material_name || <span className={styles.muted}>—</span>}</div>
          <VariantDescription itemCode={l.item_code} itemGroup={l.item_group} variants={l.variants} description={l.description} mutedClassName={styles.muted} />
        </div>
      ),
      searchValue: (l) => `${l.material_name ?? ''} ${l.description ?? ''} ${buildVariantSummary(l.item_group, l.variants)}`.trim(),
    },
    { key: 'accepted', label: 'Received', width: 80, align: 'right', accessor: (l) => fmtQty(Number(l.qty_accepted ?? 0)) },
    { key: 'returned', label: 'Returned', width: 80, align: 'right', accessor: (l) => <span className={styles.muted}>{fmtQty(Number(l.returned_qty ?? 0))}</span> },
    { key: 'remaining', label: 'Can Return', width: 90, align: 'right', accessor: (l) => <span style={{ fontWeight: 700 }}>{fmtQty(remainingOf(l))}</span> },
    {
      key: 'qty', label: 'Qty to Return', width: 120, align: 'right', sortable: false, groupable: false,
      accessor: (l) => {
        const rem = remainingOf(l);
        const on = l.id in picks;
        return (
          <input
            type="number" min={0} max={rem}
            value={on ? picks[l.id] : ''}
            placeholder={rem > 0 ? String(rem) : '0'}
            disabled={rem <= 0}
            aria-label={`Qty to return for ${l.item_code}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setQty(l, Number(e.target.value) || 0)}
            style={QTY_INPUT}
          />
        );
      },
    },
    { key: 'price', label: 'Unit Price', width: 110, align: 'right', accessor: (l) => fmtMoneySen(Number(l.unit_price_sen ?? 0), grn?.currency ?? 'MYR'), exportValue: (l) => Number(l.unit_price_sen ?? 0) / 100, exportFormat: 'money' },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- accessors read the pick state already in deps
  ], [picks, grn?.currency]);

  const onContinue = () => {
    if (!grnId || picked.length === 0) { void notify({ title: 'Tick at least one line first.', tone: 'error' }); return; }
    const stash: PrFromGrnPicks = { grnId, picks: picked.map(([grnItemId, qty]) => ({ grnItemId, qty })) };
    if (!writeScmHandoff('prFromGrnPicks', stash)) {
      void notify({ title: 'Unable to continue', body: 'This browser could not safely store your picked lines. Your selection is still here; free some browser storage and try again.', tone: 'error' });
      return;
    }
    void navigate('/scm/purchase-returns/new?fromPicks=1');
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Procurement"
        title={grn ? `Return from ${grn.grn_number}` : 'Transfer from Goods Received'}
        actions={
          <div className={styles.actions}>
            {grnId && (
              <Button variant="ghost" size="md" onClick={() => choose(null)}>
                <ArrowLeft {...ICON} /> Choose another GRN
              </Button>
            )}
            <Button variant="ghost" size="md" onClick={() => void navigate('/scm/purchase-returns')}>
              <X {...ICON} /> Cancel
            </Button>
            {grnId && (
              <Button variant="primary" size="md" onClick={onContinue} disabled={picked.length === 0}>
                <ArrowRight {...ICON} />
                {picked.length === 0 ? 'Tick the lines to return' : `Continue with ${picked.length} line${picked.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
        }
      />
      <UnrecognisedScopeNotice unknown={scope.unknown} />

      {!grnId ? (
        <GrnChooser onPick={choose} />
      ) : (
        <>
          <p style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Step 2 of 2: tick only the lines going back to the supplier and set the quantity.
            {grn && <> {grn.supplier?.name ?? ''}{grn.purchase_order?.po_number ? ` · ${grn.purchase_order.po_number}` : ''} · received {fmtDateOrDash(grn.received_at ?? null)}.</>}
          </p>
          <DataGridCompat<GrnLine>
            rows={lines}
            columns={columns}
            storageKey="pr-from-grn.lines.layout.v1"
            rowKey={(l) => l.id}
            onRowClick={(l) => toggle(l)}
            rowStyle={(l) => remainingOf(l) <= 0 ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            toolbar={
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="ghost" size="sm" onClick={selectAll} disabled={lines.length === 0}><CheckSquare {...ICON} /> Select all</Button>
                <Button variant="ghost" size="sm" onClick={() => setPicks({})} disabled={picked.length === 0}><Square {...ICON} /> Clear all</Button>
              </div>
            }
            groupBanner={false}
            isLoading={detailQ.isLoading}
            emptyMessage={detailQ.isError
              ? "We couldn't load this Goods Received note. Refresh and try again."
              : 'This Goods Received note came back with no lines. Open the note to check it before raising a return.'}
          />
        </>
      )}
    </div>
  );
};

export default PurchaseReturnFromGrn;
