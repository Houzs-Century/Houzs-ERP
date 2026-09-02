// ----------------------------------------------------------------------------
// Fabric Converter — minimal master view (renamed from Fabric Tracking 2026-05-26).
//
// 5 columns: Fabric Code · Description (editable) · Supplier Code (editable) ·
// Sofa Tier · Bedframe Tier · (delete). Tiers cycle PRICE_1 → 2 → 3 on click.
//
// Commander 2026-05-26 history:
//   • Drop "All Categories" dropdown
//   • Rename from "Fabric Tracking" to "Fabric Converter"
//   • Description must be editable
//   • PR #43 — add "+ New Fabric" + per-row delete (was missing!)
//   • Export CSV / Import CSV (this PR) — round-trip catalog + metric cols via
//     Excel; bulk-upsert by fabric_code instead of one-by-one form entry.
//   • Drop Category select from New Fabric form (still NULL-able in DB).
//
// The table is shared with Products → Maintenance → Fabrics via
// components/FabricsTable.tsx — changes here reflect there automatically.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { Search, Plus, X, Download, Upload } from 'lucide-react';
import { Button, IconButton } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import {
  useFabricTrackings,
  useCreateFabric,
  useBulkUpsertFabrics,
  type FabricTier,
} from '../../vendor/scm/lib/fabric-queries';
import { FabricsTable } from '../../vendor/scm/components/FabricsTable';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { toCsv, parseImportFile, importErrorDetail, triggerDownload, type ParsedImport } from '../../vendor/scm/lib/fabric-csv';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Shared field chrome for the two dialogs — the design-system input slab.
   Was `styles.searchInput` from the bespoke module, whose colours only
   resolved through the deleted `.page` token-override cascade. */
const FIELD =
  'h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20';
const FIELD_LABEL = 'mb-1 block text-[11px] font-semibold uppercase tracking-wider text-ink-muted';

export const FabricTracking = () => {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [importPreview, setImportPreview] = useState<ParsedImport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* Retired rows are hidden by DEFAULT and one click away, not gone. The
     2026-06-12 spec says inactive fabrics stay on the converter, and they do —
     but after the 2026-08-11 merge pass, 88 of ~830 rows are supersede
     tombstones ("AVANI-01 [merged into AVANI-01 on 2026-08-11]"), which made
     the master list read as if every code were duplicated. Both views come from
     ONE cached fetch (see useFabricTrackings' select), so the count costs
     nothing. */
  const [showRetired, setShowRetired] = useState(false);

  const { data: fabrics, isLoading, error } = useFabricTrackings({
    search: search.trim() || undefined,
    includeRetired: showRetired,
  });
  const allRowsForCount = useFabricTrackings({ search: search.trim() || undefined }).data;

  const rows = useMemo(() => fabrics ?? [], [fabrics]);
  const retiredCount = (allRowsForCount ?? []).filter((f) => f.is_active === false).length;

  // Export: pull the FULL list (ignoring any active search filter — the user
  // would not expect a search-filtered export to round-trip safely on import).
  // Re-fetch unfiltered if a search is active; otherwise reuse `rows`.
  const exportFetch = useFabricTrackings({}).data;
  const onExport = () => {
    const all = (search.trim() ? exportFetch : rows) ?? rows;
    if (all.length === 0) { notify({ title: 'No fabrics to export.', tone: 'error' }); return; }
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    triggerDownload(`fabric-converter-${stamp}.csv`, toCsv(all));
  };

  const onPickFile = () => fileInputRef.current?.click();
  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';  // reset so picking same file again re-fires onChange
    if (!file) return;
    // Excel (.xlsx/.xls) or CSV — parseImportFile dispatches on extension and
    // both formats land as the same row shape (owner: any file should import).
    setImportPreview(await parseImportFile(file));
  };

  return (
    <div>
      {/* ── Header — shared PageHeader (full-bleed, design-system) ─── */}
      <PageHeader
        eyebrow="Reference data"
        title="Fabric Converter"
        primaryAction={
          <div className="flex items-stretch gap-2">
            <Button variant="secondary" icon={<Download {...ICON} />} onClick={onExport}>
              Export CSV
            </Button>
            <Button variant="secondary" icon={<Upload {...ICON} />} onClick={onPickFile}>
              Import
            </Button>
            <Button variant="primary" icon={<Plus {...ICON} />} onClick={() => setCreating(true)}>
              New Fabric
            </Button>
          </div>
        }
      />

      {/* ── Filter row — search only; the CTAs moved into the header ── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[320px] flex-1">
          <Search
            size={16}
            strokeWidth={1.75}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <input
            type="search"
            className="h-9 w-full rounded-md border border-border bg-surface pl-9 pr-3.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
            placeholder="Search by code or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {retiredCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-muted">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
            />
            <span>
              {showRetired
                ? `Showing ${retiredCount} retired`
                : `${retiredCount} retired hidden`}
            </span>
          </label>
        )}
        <input ref={fileInputRef} type="file"
          accept=".xlsx,.xls,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ display: 'none' }} onChange={onFileChosen} />
      </div>

      <FabricsTable rows={rows} isLoading={isLoading} error={error} />

      {creating && <NewFabricDialog onClose={() => setCreating(false)} />}
      {importPreview && (
        <ImportPreviewDialog
          preview={importPreview}
          onClose={() => setImportPreview(null)}
        />
      )}
    </div>
  );
};

const NewFabricDialog = ({ onClose }: { onClose: () => void }) => {
  const create = useCreateFabric();
  const notify = useNotify();
  const [form, setForm] = useState({
    fabricCode: '',
    supplierCode: '',
    fabricDescription: '',
    series: '',
    colours: '',
    sofaPriceTier: 'PRICE_2' as FabricTier,
    bedframePriceTier: 'PRICE_2' as FabricTier,
  });

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const submit = () => {
    if (!form.fabricCode.trim()) {
      notify({ title: 'Fabric Code is required.', tone: 'error' });
      return;
    }
    const colourList = form.colours.split(',').map((s) => s.trim()).filter(Boolean).map((label) => ({ label }));
    create.mutate({
      fabricCode: form.fabricCode.trim(),
      fabricDescription: form.fabricDescription.trim() || undefined,
      // Owner 2026-07-24 — supplier code is the supplier's OWN code (e.g.
      // PC151-01), a separate field from our fabric_code (BF-01). Left blank
      // when not entered — no longer defaulted to the fabric code (that made
      // every fabric look like its supplier code == our code).
      supplierCode: form.supplierCode.trim() || undefined,
      series: form.series.trim() || undefined,
      sofaPriceTier: form.sofaPriceTier,
      bedframePriceTier: form.bedframePriceTier,
      // Migration 0124/0125 — also create the POS-pickable fabric_library entry + colours.
      label: form.fabricDescription.trim() || form.fabricCode.trim(),
      colours: colourList,
    }, {
      onSuccess: async (res) => {
        if (res.libraryWarning) {
          await notify({ title: 'Fabric saved, but the customer-pickable entry had an issue:', body: `${res.libraryWarning}` });
        }
        onClose();
      },
      onError: (e) => notify({ title: 'Create failed', body: `${e instanceof Error ? e.message : 'Something went wrong.'}`, tone: 'error' }),
    });
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
      <div onClick={(e) => e.stopPropagation()}
        className="w-[520px] max-w-[95vw] animate-modal-in rounded-lg border border-border bg-surface p-5 shadow-slab">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink">New Fabric</h2>
          <IconButton icon={<X {...ICON} />} variant="ghost" size="sm" onClick={onClose} aria-label="Close" />
        </div>

        <div className="mt-4">
          <label className="mb-3 block">
            <div className={FIELD_LABEL}>Fabric Code *</div>
            <input className={FIELD}
              value={form.fabricCode} placeholder="AVANI 09 / AH-2 / NEW-FABRIC-001"
              autoFocus
              onChange={(e) => set('fabricCode', e.target.value)} />
          </label>

          <label className="mb-3 block">
            <div className={FIELD_LABEL}>Description</div>
            <input className={FIELD}
              value={form.fabricDescription} placeholder="e.g. IVORY / FABRIC"
              onChange={(e) => set('fabricDescription', e.target.value)} />
          </label>

          <label className="mb-3 block">
            <div className={FIELD_LABEL}>Supplier Code (the supplier's own code, e.g. PC151-01)</div>
            <input className={FIELD}
              value={form.supplierCode} placeholder="e.g. PC151-01"
              onChange={(e) => set('supplierCode', e.target.value)} />
          </label>

          <label className="mb-3 block">
            <div className={FIELD_LABEL}>Series (collection name)</div>
            <input className={FIELD}
              value={form.series} placeholder="e.g. KOONA VELVET H2O"
              onChange={(e) => set('series', e.target.value)} />
          </label>

          <label className="mb-3 block">
            <div className={FIELD_LABEL}>Colours (comma-separated — makes the fabric pickable on POS)</div>
            <input className={FIELD}
              value={form.colours} placeholder="e.g. Sand, Charcoal, Ivory"
              onChange={(e) => set('colours', e.target.value)} />
          </label>

          {/* Commander 2026-05-27 (Fix 6): only Price 1 and Price 2 are in
              commercial use today. PRICE_3 dropped from the dropdown but
              retained in the enum so historical rows still render their
              tier; click-cycle on the table collapses to a 2-state toggle. */}
          <div className="grid grid-cols-2 gap-3">
            <label>
              <div className={FIELD_LABEL}>Sofa Tier</div>
              <select className={FIELD}
                value={form.sofaPriceTier}
                onChange={(e) => set('sofaPriceTier', e.target.value as FabricTier)}>
                <option value="PRICE_1">Price 1</option>
                <option value="PRICE_2">Price 2</option>
              </select>
            </label>
            <label>
              <div className={FIELD_LABEL}>Bedframe Tier</div>
              <select className={FIELD}
                value={form.bedframePriceTier}
                onChange={(e) => set('bedframePriceTier', e.target.value as FabricTier)}>
                <option value="PRICE_1">Price 1</option>
                <option value="PRICE_2">Price 2</option>
              </select>
            </label>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Create Fabric'}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Import-preview modal: shows row count + any parse warnings/errors before
// the user commits to writing to the DB. Upsert semantics — fabric_code is
// the match key. Existing rows missing from the CSV are NOT deleted.
const ImportPreviewDialog = ({
  preview,
  onClose,
}: {
  preview: ParsedImport;
  onClose: () => void;
}) => {
  const upsert = useBulkUpsertFabrics();
  const notify = useNotify();
  const { rows, errors, warnings } = preview;
  const canCommit = rows.length > 0;

  const commit = () => {
    upsert.mutate(rows, {
      // Some rows saved, some the server refused (200 OK, per-row `errors`). Show
      // WHICH rows and WHY, not just a count — the owner needs the real reason.
      onSuccess: async (res) => {
        if (res.errors.length > 0) {
          const shown = res.errors.slice(0, 30)
            .map((e) => `Row ${e.index + 2}: ${e.reason}`);  // +2: 1-based, past the header
          const more = res.errors.length > 30 ? `\n…and ${res.errors.length - 30} more.` : '';
          await notify({
            title: `Imported ${res.upserted} fabric${res.upserted === 1 ? '' : 's'}, ${res.errors.length} rejected.`,
            body: <div style={{ whiteSpace: 'pre-wrap' }}>{`These rows were not saved:\n\n${shown.join('\n')}${more}`}</div>,
            tone: res.upserted === 0 ? 'error' : 'info',
          });
        } else {
          await notify({ title: `Imported ${res.upserted} fabric${res.upserted === 1 ? '' : 's'}.` });
        }
        onClose();
      },
      // Whole request refused (e.g. a 409). Surface the server's specific reason
      // and any conflicting codes it named, not the generic "clashes with
      // something" line — importErrorDetail reads them off the raw error body.
      onError: (e) => {
        const base = e instanceof Error ? e.message : 'Something went wrong.';
        const detail = importErrorDetail(e);
        void notify({
          title: 'Import failed',
          body: <div style={{ whiteSpace: 'pre-wrap' }}>{detail ? `${base}\n\n${detail}` : base}</div>,
          tone: 'error',
        });
      },
    });
  };

  return (
    <div onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
      <div onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[95vw] animate-modal-in rounded-lg border border-border bg-surface p-5 shadow-slab">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[19px] font-extrabold leading-tight tracking-tight text-ink">Import</h2>
          <IconButton icon={<X {...ICON} />} variant="ghost" size="sm" onClick={onClose} aria-label="Close" />
        </div>

        <div className="mb-3 mt-4 rounded-lg border border-border-subtle bg-surface-2 p-3">
          <div className="text-[13px] text-ink">
            <strong className="font-semibold">{rows.length}</strong> row{rows.length === 1 ? '' : 's'} ready to upsert.
          </div>
          {warnings.length > 0 && (
            <div className="mt-2 text-[12px] text-ink-muted">
              {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          {errors.length > 0 && (
            <div className="mt-2 max-h-[200px] overflow-y-auto text-[12px] text-err">
              {errors.slice(0, 30).map((e, i) => <div key={i}>✗ {e}</div>)}
              {errors.length > 30 && <div>…and {errors.length - 30} more.</div>}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={commit} disabled={!canCommit || upsert.isPending}>
            {upsert.isPending ? 'Importing…' : `Upsert ${rows.length} row${rows.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
