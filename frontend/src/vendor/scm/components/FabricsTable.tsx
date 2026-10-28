// ----------------------------------------------------------------------------
// FabricsTable — shared 5-column fabrics editor.
//
// Used by:
//   1. /fabric-tracking standalone page
//   2. Products → Maintenance → Fabrics sub-tab
//
// Columns: Fabric Code · Description · Supplier Code (editable) · Sofa Tier
// (cycle PRICE_1/2/3 on click) · Bedframe Tier (cycle on click).
//
// DataGrid conversion (owner request 2026-06-12): the plain <table> is now
// the shared DataGrid (sort / per-column filter / column show-hide /
// reorder / persisted layout). The click-to-edit cells (Series /
// Description / Supplier Code), tier cycle buttons and per-row delete are
// self-contained components and ride inside the column accessors unchanged.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Check, X, Trash2 } from 'lucide-react';
import {
  useUpdateFabricTier,
  useUpdateFabricSupplierCode,
  useUpdateFabricDescription,
  useUpdateFabricSeries,
  useUpdateFabricActive,
  useDeleteFabric,
  type FabricTier,
  type FabricTierField,
  type FabricTrackingRow,
} from '../lib/fabric-queries';
import { DataGridCompat, type GridColumn } from '../../../components/DataGridCompat';
import { useConfirm } from './ConfirmDialog';
import styles from '../../../pages/scm-v2/FabricTracking.module.css';

/* Commander 2026-05-27 (Fix 6): only Price 1 and Price 2 in use today.
   Cycle collapses to a 2-state toggle; PRICE_3 in the schema stays so
   historical rows still render, but new clicks never produce a PRICE_3.
   When a legacy PRICE_3 row IS encountered we cycle it forward to PRICE_1
   on the next click so commander can clean those up by tapping through. */
const TIER_NEXT: Record<FabricTier, FabricTier> = {
  PRICE_1: 'PRICE_2',
  PRICE_2: 'PRICE_1',
  PRICE_3: 'PRICE_1',
};

const tierShort = (t: FabricTier | null): string =>
  t ? `Price ${t.replace('PRICE_', '')}` : '—';

/* Tier cycle button — hooks live in a real component (NOT a column accessor
   closure) so the rules of hooks hold inside the DataGrid render. */
const TierCell = ({ row, field, tier }: {
  row: FabricTrackingRow; field: FabricTierField; tier: FabricTier | null;
}) => {
  const updateTier = useUpdateFabricTier();
  const askConfirm = useConfirm();
  const next = TIER_NEXT[tier ?? 'PRICE_2'];
  const label = field === 'sofaPriceTier' ? 'Sofa' : 'Bedframe';
  return (
    <button
      type="button"
      className={styles.tierPicker}
      /* Commander 2026-06-15 — confirm before changing the tier (no 裸奔); the
         tier drives the fabric's price, so a stray click must not commit. */
      onClick={async () => {
        if (await askConfirm({
          title: 'Change tier?',
          body: `Set this fabric's ${label} tier to ${tierShort(next)}? This changes its price.`,
          confirmLabel: 'Change',
        })) {
          updateTier.mutate({ id: row.id, field, tier: next });
        }
      }}
      title="Change the price tier (asks to confirm)"
    >
      {tierShort(tier)}
    </button>
  );
};

/* Migration 0167 — ACTIVE toggle (owner spec 2026-06-12). Click-to-toggle.
   Inactive = hidden from NEW-entry fabric pickers (SO/CO variant selects,
   scan-SO catalog); existing documents keep displaying the code.
   Owner 2026-06-22 — render the normal green "Active" style the other lists
   use (Maintenance pools) instead of an orange Yes/No pill. */
const ActiveCell = ({ row }: { row: FabricTrackingRow }) => {
  const update = useUpdateFabricActive();
  const askConfirm = useConfirm();
  const isActive = row.is_active !== false;
  return (
    <button
      type="button"
      className={styles.activeToggle}
      /* Commander 2026-06-15 — confirm before toggling active (no 裸奔). */
      onClick={async () => {
        if (await askConfirm({
          title: isActive ? 'Deactivate fabric?' : 'Reactivate fabric?',
          body: isActive
            ? 'It will be hidden from fabric pickers for new entries. Existing documents keep showing it.'
            : 'It will appear in fabric pickers again.',
          confirmLabel: isActive ? 'Deactivate' : 'Reactivate',
          danger: isActive,
        })) {
          update.mutate({ id: row.id, isActive: !isActive });
        }
      }}
      disabled={update.isPending}
      title="Active fabrics show in pickers for new entries (asks to confirm)"
      style={{ color: isActive ? 'var(--c-green, #1a7a3a)' : 'var(--fg-muted)' }}
    >
      {isActive ? 'Active' : 'Inactive'}
    </button>
  );
};

const DeleteCell = ({ row }: { row: FabricTrackingRow }) => {
  const deleteFabric = useDeleteFabric();
  const askConfirm = useConfirm();
  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={async () => {
        if (await askConfirm({
          title: `Delete fabric ${row.fabric_code}?`,
          body: 'This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true,
        })) {
          deleteFabric.mutate(row.id);
        }
      }}
      title="Delete fabric"
      style={{ color: 'var(--c-festive-b, #B8331F)' }}
      disabled={deleteFabric.isPending}
    >
      <Trash2 size={14} strokeWidth={1.75} />
    </button>
  );
};

/* Column spec lives at module scope — accessors only render self-contained
   cell components, so the array is stable and the DataGrid memo hits. */
const sofaTier = (r: FabricTrackingRow): FabricTier | null => r.sofa_price_tier ?? r.price_tier;
const bedTier = (r: FabricTrackingRow): FabricTier | null => r.bedframe_price_tier ?? r.price_tier;

const FABRIC_COLUMNS: GridColumn<FabricTrackingRow>[] = [
  {
    key: 'code',
    label: 'Code',
    width: 150,
    accessor: (r) => <span className={styles.codeChip}>{r.fabric_code}</span>,
    // fabric_code is OUR internal code (e.g. BF-01); the supplier's EXTERNAL
    // code (e.g. PC151-01) has its own "Supplier Code" column below. Owner
    // 2026-07-24 restored that column once the two codes were confirmed to be
    // different things. Both stay searchable from here so a lookup by either
    // code resolves.
    searchValue: (r) => `${r.fabric_code} ${r.supplier_code ?? ''}`,
    filterValue: (r) => r.fabric_code,
    sortFn: (a, b) => (a.fabric_code ?? '').localeCompare(b.fabric_code ?? ''),
  },
  {
    key: 'series',
    label: 'Series',
    width: 180,
    accessor: (r) => <SeriesCell id={r.id} value={r.series ?? ''} />,
    searchValue: (r) => r.series ?? '',
    filterValue: (r) => r.series ?? '',
    sortFn: (a, b) => (a.series ?? '').localeCompare(b.series ?? ''),
  },
  {
    key: 'description',
    label: 'Description',
    width: 240,
    accessor: (r) => <DescriptionCell id={r.id} value={r.fabric_description ?? ''} />,
    searchValue: (r) => r.fabric_description ?? '',
    filterValue: (r) => r.fabric_description ?? '',
    sortFn: (a, b) => (a.fabric_description ?? '').localeCompare(b.fabric_description ?? ''),
  },
  {
    // Owner 2026-07-24 — restored. The supplier's own code for this fabric
    // (e.g. PC151-01), distinct from our internal fabric_code (BF-01). Shown so
    // POs tell the supplier which fabric we mean; editable inline.
    key: 'supplierCode',
    label: 'Supplier Code',
    width: 160,
    accessor: (r) => <SupplierCodeCell id={r.id} value={r.supplier_code ?? ''} />,
    searchValue: (r) => r.supplier_code ?? '',
    filterValue: (r) => r.supplier_code ?? '',
    sortFn: (a, b) => (a.supplier_code ?? '').localeCompare(b.supplier_code ?? ''),
  },
  {
    key: 'sofaTier',
    label: 'Sofa Tier',
    width: 110,
    accessor: (r) => <TierCell row={r} field="sofaPriceTier" tier={sofaTier(r)} />,
    searchValue: (r) => tierShort(sofaTier(r)),
    filterValue: (r) => tierShort(sofaTier(r)),
    sortFn: (a, b) => tierShort(sofaTier(a)).localeCompare(tierShort(sofaTier(b))),
  },
  {
    key: 'bedframeTier',
    label: 'Bedframe Tier',
    width: 110,
    accessor: (r) => <TierCell row={r} field="bedframePriceTier" tier={bedTier(r)} />,
    searchValue: (r) => tierShort(bedTier(r)),
    filterValue: (r) => tierShort(bedTier(r)),
    sortFn: (a, b) => tierShort(bedTier(a)).localeCompare(tierShort(bedTier(b))),
  },
  {
    key: 'active',
    label: 'Active',
    width: 80,
    accessor: (r) => <ActiveCell row={r} />,
    searchValue: (r) => (r.is_active !== false ? 'Yes' : 'No'),
    filterValue: (r) => (r.is_active !== false ? 'Yes' : 'No'),
    sortFn: (a, b) => Number(b.is_active !== false) - Number(a.is_active !== false),
  },
  {
    key: 'actions',
    label: '',
    width: 48,
    minWidth: 48,
    align: 'right',
    sortable: false,
    groupable: false,
    accessor: (r) => <DeleteCell row={r} />,
    searchValue: () => '',
  },
];

export const FabricsTable = ({
  rows,
  isLoading,
  error,
}: {
  rows: FabricTrackingRow[];
  isLoading: boolean;
  error: unknown;
  /** Legacy "N of N records" header toggle — the DataGrid's own status line
      now shows the row count, so this prop is accepted but unused. */
  showHeader?: boolean;
}) => (
  <>
    {error && !isLoading && (
      <div className={styles.bannerWarn}>
        <strong>Failed to load fabrics.</strong>{' '}
        {/* authedFetch already humanised `message`; fallback for a non-Error throw. */}
        {error instanceof Error ? error.message : 'Something went wrong.'}
      </div>
    )}

    <DataGridCompat
      rows={rows}
      columns={FABRIC_COLUMNS}
      storageKey="dg-fabrics-converter"
      exportName="Fabrics"
      rowKey={(r) => r.id}
      searchPlaceholder="Filter visible fabrics…"
      groupBanner={false}
      isLoading={isLoading}
      emptyMessage='No fabrics yet — click "+ New Fabric" to add one.'
    />
  </>
);

/* PR #38 — Click-to-edit Description cell. Same UX as the Series cell. */
const DescriptionCell = ({ id, value }: { id: string; value: string }) => {
  const update = useUpdateFabricDescription();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) {
      setEditing(false);
      return;
    }
    update.mutate(
      { id, description: trimmed.length ? trimmed : null },
      { onSettled: () => setEditing(false) },
    );
  };

  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <button
        type="button"
        className={value ? styles.supplierCodeChip : styles.supplierCodeEmpty}
        onClick={() => { setDraft(value); setEditing(true); }}
        title="Click to edit description"
        style={{ width: '100%', textAlign: 'left' }}
      >
        {value || '+ Add description'}
      </button>
    );
  }

  return (
    <span className={styles.supplierCodeEditor}>
      <input
        autoFocus
        className={styles.supplierCodeInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
        }}
        onBlur={cancel}
        style={{ minWidth: 220 }}
      />
      <button type="button" className={styles.iconBtn} onMouseDown={(e) => e.preventDefault()} onClick={commit} title="Save">
        <Check size={14} strokeWidth={1.75} />
      </button>
      <button type="button" className={styles.iconBtn} onMouseDown={(e) => e.preventDefault()} onClick={cancel} title="Cancel">
        <X size={14} strokeWidth={1.75} />
      </button>
    </span>
  );
};

/* Migration 0063 — Click-to-edit Series cell. Same UX as Description /
   Supplier Code. Click chip → input → Enter saves, Esc cancels, blur saves. */
const SeriesCell = ({ id, value }: { id: string; value: string }) => {
  const update = useUpdateFabricSeries();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) { setEditing(false); return; }
    update.mutate(
      { id, series: trimmed.length ? trimmed : null },
      { onSettled: () => setEditing(false) },
    );
  };

  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <button
        type="button"
        className={value ? styles.supplierCodeChip : styles.supplierCodeEmpty}
        onClick={() => { setDraft(value); setEditing(true); }}
        title="Click to edit series"
        style={{ width: '100%', textAlign: 'left' }}
      >
        {value || '+ Add series'}
      </button>
    );
  }

  return (
    <span className={styles.supplierCodeEditor}>
      <input
        autoFocus
        className={styles.supplierCodeInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
        }}
        onBlur={cancel}
        style={{ minWidth: 180 }}
      />
      <button type="button" className={styles.iconBtn} onMouseDown={(e) => e.preventDefault()} onClick={commit} title="Save">
        <Check size={14} strokeWidth={1.75} />
      </button>
      <button type="button" className={styles.iconBtn} onMouseDown={(e) => e.preventDefault()} onClick={cancel} title="Cancel">
        <X size={14} strokeWidth={1.75} />
      </button>
    </span>
  );
};

/* Owner 2026-07-24 — Click-to-edit Supplier Code cell, restored after the
   2026-06-22 removal. supplier_code is the supplier's OWN code for this fabric
   (e.g. PC151-01), distinct from our internal fabric_code (BF-01). Same UX as
   Description / Series: click chip → input → Enter saves, Esc cancels. */
const SupplierCodeCell = ({ id, value }: { id: string; value: string }) => {
  const update = useUpdateFabricSupplierCode();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) { setEditing(false); return; }
    update.mutate(
      { id, supplierCode: trimmed.length ? trimmed : null },
      { onSettled: () => setEditing(false) },
    );
  };

  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <button
        type="button"
        className={value ? styles.supplierCodeChip : styles.supplierCodeEmpty}
        onClick={() => { setDraft(value); setEditing(true); }}
        title="Click to edit the supplier's code for this fabric"
        style={{ width: '100%', textAlign: 'left' }}
      >
        {value || '+ Add supplier code'}
      </button>
    );
  }

  return (
    <span className={styles.supplierCodeEditor}>
      <input
        autoFocus
        className={styles.supplierCodeInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') cancel();
        }}
        onBlur={cancel}
        style={{ minWidth: 160 }}
      />
      <button type="button" className={styles.iconBtn} onMouseDown={(e) => e.preventDefault()} onClick={commit} title="Save">
        <Check size={14} strokeWidth={1.75} />
      </button>
      <button type="button" className={styles.iconBtn} onMouseDown={(e) => e.preventDefault()} onClick={cancel} title="Cancel">
        <X size={14} strokeWidth={1.75} />
      </button>
    </span>
  );
};
