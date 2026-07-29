// ----------------------------------------------------------------------------
// ProductModels — list page at /product-models (PR #49).
//
// "Group by Model" landing screen. Lists every product_models row grouped by
// category, with SKU count + active/inactive status. Click a Model → detail
// page where allowed-options + name + description are managed.
//
// Replaces the old SKU-only flat list when commander wants to manage at the
// Model layer. The plain SKU list lives on /products (SkuMasterTab).
// ----------------------------------------------------------------------------

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductModelDetail } from './ProductModelDetail';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { Search, Plus, Trash2, Truck, X, ImageOff, Upload, Edit3 } from 'lucide-react';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { maintActiveValues } from '@2990s/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  useProductModels, useCreateProductModel, useGenerateModelSkus, useDeleteProductModel,
  useUpdateProductModel, useUploadProductModelPhoto, useDeleteProductModelPhoto, useBrandingPool,
  type ProductModelRow, type AllowedOptions,
} from '../../vendor/scm/lib/product-models-queries';
import { useMaintenanceConfig, useMfgProducts, type MfgCategory, type MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import {
  useSuppliers, useCreateBindingsBatch,
  type Currency, type MaterialKind, type NewBinding, type SupplierRow,
} from '../../vendor/scm/lib/suppliers-queries';
import { resolveSizeInfo } from '../../vendor/scm/lib/size-info';
import { SkuPreviewStrip } from '../../vendor/scm/components/SkuPreviewStrip';
import { composeSupplierSku } from '../../vendor/scm/lib/supplier-sku-helpers';
import { MultiSupplierPicker } from '../../vendor/scm/components/MultiSupplierPicker';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { parseMoneyToSen } from '../../lib/money';
import styles from './ProductModels.module.css';

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* "Failed to load" / validation banner — err tokens. Replaces the bespoke
   .errorBanner, whose --c-festive-b + rgba fill only resolved via the
   removed .page cascade. Shared by the list and all three dialogs. */
const BANNER_ERR =
  'rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[13px] text-err';

const CATEGORIES: MfgCategory[] = ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE'];

/* DataGrid layout key for the Models list. The legacy page rendered one
   table per category — to keep that read on first visit we seed a default
   "group by Category" layout ONCE (only when no layout was ever stored).
   After that, whatever the operator does (remove the group chip, hide
   columns, …) persists and this seed never runs again. */
const PM_GRID_KEY = 'dg-product-models';
if (typeof window !== 'undefined' && window.localStorage.getItem(PM_GRID_KEY) == null) {
  try {
    window.localStorage.setItem(PM_GRID_KEY, JSON.stringify({ groupBy: ['category'] }));
  } catch { /* storage full / disabled — grid just starts flat */ }
}

export const ProductModels = () => {
  const [filter, setFilter] = useState<MfgCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  // PR #119 — Commander 2026-05-26: clicking a Model in Modular tab opens
  // a right-side drawer with the detail content (photo / allowed options /
  // SKU variants) instead of navigating away to /product-models/{id}. The
  // dedicated route still exists for deep-links; this is just the Modular
  // entrypoint.
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  // Owner request 2026-06-12 — quick per-model Edit dialog (name / branding /
  // description + allowed sizes & compartments) without opening the full
  // detail drawer. PATCH /product-models/:id; for SOFA the server auto-creates
  // SKUs for newly-activated compartments.
  const [editModel, setEditModel] = useState<ProductModelRow | null>(null);
  // PR #106 — Commander 2026-05-26: showed Modular list with rows he didn't
  // recognize ("这些都没在我的 SKU 里面啊"). Multi-select + bulk delete so he
  // can sweep orphan Models (test entries, migration-0062 backfill leftovers)
  // without clicking into each one.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting]       = useState(false);
  // PR — Commander 2026-05-27: tick N Models → "Assign to supplier · N
  // selected" CTA opens a Modular-tab parallel of SupplierDetail's
  // ModelSkuPickerDialog. Picks a supplier, types ONE supplier code +
  // description per Model, fans the binding out across every active SKU
  // under each Model in a single /bindings/batch POST.
  const [assigningSupplier, setAssigningSupplier] = useState(false);
  const deleteMut = useDeleteProductModel();
  const askConfirm = useConfirm();
  const notify = useNotify();

  const { data: models = [], isLoading, error } = useProductModels(
    filter === 'all' ? undefined : { category: filter },
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.model_code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [models, search]);

  /* ── DataGrid conversion (owner request 2026-06-12) ─────────────────
     The per-category <section> tables are replaced by ONE shared DataGrid
     (sort / per-column filter / column show-hide / reorder / persisted
     layout — same as the SKU Master conversion in Products.tsx). The old
     category section headers are preserved as a default group-by Category
     (seeded into localStorage on first visit only — see PM_GRID_KEY below);
     remove the chip to get a flat list, and the choice persists. Bulk
     select, the photo upload cell, code-chip click + row double-click →
     detail drawer all ride along unchanged. */
  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  // Select-all over the rows currently in view (replaces the old per-category
  // header checkbox — same pattern as the SKU Master grid toolbar).
  const allTicked = filtered.length > 0 && filtered.every((m) => selectedIds.has(m.id));
  const someTicked = !allTicked && filtered.some((m) => selectedIds.has(m.id));
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (allTicked) filtered.forEach((m) => n.delete(m.id));
      else filtered.forEach((m) => n.add(m.id));
      return n;
    });
  };

  const gridColumns = useMemo<DataGridColumn<ProductModelRow>[]>(() => {
    const stop = {
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    };
    return [
      {
        key: 'sel',
        label: '',
        width: 36,
        minWidth: 36,
        sortable: false,
        groupable: false,
        accessor: (m) => (
          <span {...stop} style={{ display: 'inline-flex' }}>
            <input
              type="checkbox"
              aria-label={`Select ${m.model_code}`}
              checked={selectedIds.has(m.id)}
              onChange={() => toggleOne(m.id)}
              style={{ cursor: 'pointer' }}
            />
          </span>
        ),
        searchValue: () => '',
      },
      {
        key: 'photo',
        label: 'Photo',
        width: 64,
        minWidth: 56,
        sortable: false,
        groupable: false,
        accessor: (m) => <ModelPhotoCell model={m} />,
        searchValue: () => '',
        filterValue: (m) => (m.photo_url ? 'Has photo' : 'No photo'),
      },
      {
        key: 'category',
        label: 'Category',
        width: 110,
        accessor: (m) => m.category,
        filterValue: (m) => m.category,
        groupValue: (m) => m.category,
      },
      {
        key: 'code',
        label: 'Code',
        width: 160,
        accessor: (m) => (
          <button
            type="button"
            className={styles.codeChipLink}
            onClick={(e) => { e.stopPropagation(); setOpenModelId(m.id); }}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            <code className={styles.codeChip}>{m.model_code}</code>
          </button>
        ),
        searchValue: (m) => m.model_code,
        filterValue: (m) => m.model_code,
        sortFn: (a, b) => (a.model_code ?? '').localeCompare(b.model_code ?? ''),
      },
      {
        key: 'name',
        label: 'Name',
        width: 240,
        accessor: (m) => <span className={styles.nameText}>{m.name}</span>,
        searchValue: (m) => m.name,
        filterValue: (m) => m.name,
        sortFn: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
      },
      {
        key: 'active',
        label: 'Active',
        width: 96,
        accessor: (m) => (
          <span className={`${styles.statusPill} ${m.active ? styles.active : styles.inactive}`}>
            {m.active ? 'ACTIVE' : 'INACTIVE'}
          </span>
        ),
        searchValue: (m) => (m.active ? 'ACTIVE' : 'INACTIVE'),
        filterValue: (m) => (m.active ? 'ACTIVE' : 'INACTIVE'),
        sortFn: (a, b) => Number(b.active) - Number(a.active),
      },
      {
        // PR — Wei Siang 2026-06-19: surface SKU count so a 0-SKU orphan Model
        // (all its SKUs deleted from SKU Master) is visibly flagged. Subtle for
        // count > 0 (plain muted number); amber "0 SKUs" badge when empty.
        key: 'sku_count',
        label: 'SKUs',
        width: 96,
        accessor: (m) => {
          const n = m.sku_count ?? 0;
          if (n === 0) {
            return (
              <span
                className={styles.statusPill}
                title="No SKUs under this Model — likely an orphan left behind after its SKUs were deleted from SKU Master."
                style={{
                  background: '#e1efed',
                  color: '#0c3f39',
                  borderColor: '#16695f',
                  fontWeight: 600,
                }}
              >
                0 SKUs
              </span>
            );
          }
          return <span style={{ color: '#767b6e' }}>{n}</span>;
        },
        searchValue: (m) => String(m.sku_count ?? 0),
        filterValue: (m) => ((m.sku_count ?? 0) === 0 ? '0 SKUs' : String(m.sku_count ?? 0)),
        sortFn: (a, b) => (a.sku_count ?? 0) - (b.sku_count ?? 0),
      },
      {
        key: 'description',
        label: 'Description',
        width: 240,
        accessor: (m) => (
          <span style={{ color: '#767b6e' }}>{m.description ?? '—'}</span>
        ),
        searchValue: (m) => m.description ?? '',
        filterValue: (m) => m.description ?? '—',
      },
      {
        // Owner request 2026-06-12 — per-model Edit action. Opens the quick
        // edit dialog (delete / add behaviours stay where they are).
        key: 'edit',
        label: '',
        width: 48,
        minWidth: 44,
        sortable: false,
        groupable: false,
        accessor: (m) => (
          <span {...stop} style={{ display: 'inline-flex' }}>
            <button
              type="button"
              aria-label={`Edit ${m.model_code}`}
              title="Edit name / branding / description / allowed options"
              onClick={() => setEditModel(m)}
              style={{
                background: 'transparent', border: 'none', padding: 4,
                cursor: 'pointer', color: '#767b6e',
                display: 'inline-flex', alignItems: 'center',
              }}
            >
              <Edit3 size={14} strokeWidth={1.75} />
            </button>
          </span>
        ),
        searchValue: () => '',
      },
    ];
  }, [selectedIds, toggleOne]);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Catalog"
        title="Product Models"
        description={
          /* The bespoke .count chip that sat next to the title — the live
             filtered tally keeps its wording verbatim, it just reads as the
             header's own description line now. */
          `${filtered.length} models`
        }
        actions={
          /* The search pill rides in the actions slot — the same seat it had
             inside the old bespoke .actions rail. */
          <div className={styles.searchBox}>
            <Search {...ICON} />
            <input
              type="search"
              placeholder="Model code / name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
        primaryAction={
          <Button variant="primary" icon={<Plus {...ICON} />} onClick={() => setCreating(true)}>
            New Model
          </Button>
        }
      />

      {/* Category filter chips */}
      <div className={styles.chipRow}>
        <FilterChip on={filter === 'all'} onClick={() => setFilter('all')}>All</FilterChip>
        {CATEGORIES.map((c) => (
          <FilterChip key={c} on={filter === c} onClick={() => setFilter(c)}>
            {c}
          </FilterChip>
        ))}
      </div>

      {error && (
        <div className={BANNER_ERR}>
          Failed to load: {error instanceof Error ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/* PR #106 — Bulk-select toolbar. Sticky-ish strip that surfaces only
          when at least one Model is ticked; mirrors the SKU Master pattern
          (PR #82). */}
      {selectedIds.size > 0 && (
        /* Petrol-soft selection slab — was a hardcoded rgba(232,107,58,.08)
           fill over a --c-orange hairline, i.e. the pre-Theme-C brand
           orange. Now primary tokens, so it matches the selected-row tint
           the rest of the app uses. */
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary-soft px-4 py-3">
          <span className="text-[13px] font-semibold text-primary-ink">
            {selectedIds.size} model{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <span className="inline-flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
            {/* PR — Commander 2026-05-27: primary CTA pivots the bulk-select
                toolbar from "manage Models" into the supplier-mapping flow.
                Promotes the "Assign to supplier" action over the destructive
                Delete (Delete is demoted to a ghost button on its right). */}
            <Button
              variant="primary"
              icon={<Truck {...ICON} />}
              onClick={() => setAssigningSupplier(true)}
            >
              Assign to supplier · {selectedIds.size} selected
            </Button>
            {/* disabled={deleting} keeps this inline as a <Button>: a
                secondaryActions MenuItem has no disabled field, so the
                in-flight lock would be silently dropped. */}
            <Button
              variant="ghost"
              icon={<Trash2 {...ICON} />}
              disabled={deleting}
              onClick={async () => {
                if (!(await askConfirm({
                  title: `Delete ${selectedIds.size} Model${selectedIds.size === 1 ? '' : 's'}?`,
                  body: 'Any SKUs underneath stay in mfg_products but lose their model_id link.',
                  confirmLabel: 'Delete',
                  danger: true,
                }))) return;
                setDeleting(true);
                const ids = Array.from(selectedIds);
                const results = await Promise.all(ids.map((id) =>
                  deleteMut.mutateAsync(id).then(() => ({ id, ok: true as const }))
                    .catch((e) => ({ id, ok: false as const, err: e instanceof Error ? e.message : 'Something went wrong.' })),
                ));
                setDeleting(false);
                setSelectedIds(new Set());
                const failed = results.filter((r) => !r.ok);
                if (failed.length > 0) {
                  const sample = failed.slice(0, 3).map((f) => `· ${'err' in f ? f.err.slice(0, 160) : ''}`).join('\n');
                  notify({
                    title: `Deleted ${results.length - failed.length} / ${results.length}`,
                    body: `${failed.length} failed:\n${sample}`,
                    tone: 'error',
                  });
                }
              }}
            >
              {deleting ? 'Deleting…' : `Delete ${selectedIds.size}`}
            </Button>
          </span>
        </div>
      )}

      {/* Shared DataGrid (owner request 2026-06-12) — replaces the per-
          category section tables. Grouped by Category by default (seeded
          once via PM_GRID_KEY); double-click a row — or click the code
          chip — opens the detail drawer (PR #137 double-click semantics
          preserved). The photo cell keeps its click-to-upload /
          right-click-to-remove behaviour. */}
      <DataGrid
        rows={filtered}
        columns={gridColumns}
        storageKey={PM_GRID_KEY}
        exportName="Product Models"
        rowKey={(m) => m.id}
        searchPlaceholder="Search code, name, category…"
        loadedSearchLimit={1000}
        onRowDoubleClick={(m) => setOpenModelId(m.id)}
        isLoading={isLoading}
        emptyMessage='No models match. Try clearing filters, or click "+ New Model" to create one.'
        toolbar={
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted">
            <input
              type="checkbox"
              aria-label="Select all visible models"
              checked={allTicked}
              ref={(el) => { if (el) el.indeterminate = someTicked; }}
              onChange={toggleAllVisible}
              style={{ cursor: 'pointer' }}
            />
            <span>Select all</span>
          </label>
        }
      />

      {creating && <NewModelDialog onClose={() => setCreating(false)} />}

      {/* Owner request 2026-06-12 — quick per-model Edit dialog. */}
      {editModel && (
        <EditModelDialog model={editModel} onClose={() => setEditModel(null)} />
      )}

      {/* PR — Commander 2026-05-27: bulk Assign-to-Supplier dialog. */}
      {assigningSupplier && (
        <ModularAssignSupplierDialog
          modelIds={Array.from(selectedIds)}
          onClose={() => setAssigningSupplier(false)}
          onSaved={() => {
            setAssigningSupplier(false);
            setSelectedIds(new Set());
          }}
        />
      )}

      {/* PR #119 — embedded Model detail drawer */}
      {openModelId && (
        <div
          onClick={() => setOpenModelId(null)}
          className="fixed inset-0 z-[90] flex justify-end bg-black/35"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="h-full w-[min(1100px,92vw)] overflow-y-auto bg-surface shadow-slab"
          >
            <ProductModelDetail modelId={openModelId} onClose={() => setOpenModelId(null)} />
          </div>
        </div>
      )}
    </div>
  );
};

function FilterChip({
  children, on, onClick,
}: { children: React.ReactNode; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${styles.filterChip} ${on ? styles.filterChipOn : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ────────────────────────── Model Photo cell ───────────────────────────── */
/* PR — Commander 2026-05-27: 48×48 thumb on each Product Model row in
   Modular tab. Click the empty slot or filled thumb to pick a new file
   (jpg/png/webp; big photos are auto-resized client-side to fit the 2 MB
   cap, so phone photos no longer get rejected). Hover the filled thumb to
   reveal an × button that removes the photo (R2 delete + nulls
   photo_url). Errors surface as a small red caption under the thumb so
   we don't block the table layout. */

const API_URL =
  ((import.meta.env.VITE_API_URL ||
    (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) as string) +
  '/api/scm';
const PHOTO_MAX_BYTES_CLIENT = 2 * 1024 * 1024;

/** Mirror of the POS catalog's resolvePhotoUrl(): photo_url is stored as
 *  a relative proxy path (`/product-models/.../photo/...`) — prefix with
 *  the API host so an <img src> works from the Backend portal origin. */
function resolveBackendPhotoUrl(raw: string | null): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!API_URL) return raw;
  return raw.startsWith('/') ? `${API_URL}${raw}` : `${API_URL}/${raw}`;
}

/* Downscale a picked image in the browser before upload so big phone photos
 * (commonly 3–8 MB) fit under PHOTO_MAX_BYTES_CLIENT instead of being
 * rejected. Caps the longest edge at SHRINK_MAX_EDGE and re-encodes as JPEG
 * — product photos don't need transparency, and smaller files keep the POS
 * catalog fast. A decode/encode failure falls back to the original file via
 * the caller's try/catch; the byte-cap check still guards the upload. */
const SHRINK_MAX_EDGE = 1600;
const SHRINK_JPEG_QUALITY = 0.85;

async function shrinkImageForUpload(file: File): Promise<File> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error('read_failed'));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('decode_failed'));
    im.src = dataUrl;
  });
  const longest = Math.max(img.width, img.height);
  const scale = longest > SHRINK_MAX_EDGE ? SHRINK_MAX_EDGE / longest : 1;
  // Already small on both axes AND under the byte cap → upload untouched.
  if (scale === 1 && file.size <= PHOTO_MAX_BYTES_CLIENT) return file;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', SHRINK_JPEG_QUALITY),
  );
  if (!blob) return file;
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
}

function ModelPhotoCell({ model }: { model: ProductModelRow }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const upload = useUploadProductModelPhoto();
  const remove = useDeleteProductModelPhoto();
  const askConfirm = useConfirm();

  const busy = upload.isPending || remove.isPending;
  const src = resolveBackendPhotoUrl(model.photo_url);

  const pick = () => {
    if (busy) return;
    setErr(null);
    inputRef.current?.click();
  };

  const onPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!picked) return;
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(picked.type)) {
      setErr('Use JPG / PNG / WEBP');
      return;
    }
    setErr(null);
    // Shrink big photos to fit the 2 MB cap instead of rejecting them. On any
    // failure we fall back to the original; the byte-cap check below still guards.
    let file = picked;
    try {
      file = await shrinkImageForUpload(picked);
    } catch {
      file = picked;
    }
    if (file.size > PHOTO_MAX_BYTES_CLIENT) {
      setErr(`Still too large after resize (${(file.size / 1024 / 1024).toFixed(1)} MB · max 2 MB)`);
      return;
    }
    try {
      await upload.mutateAsync({ id: model.id, file });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message.slice(0, 120) : 'Upload failed');
    }
  };

  const onRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    if (!(await askConfirm({
      title: `Remove photo for ${model.model_code}?`,
      confirmLabel: 'Remove',
      danger: true,
    }))) return;
    setErr(null);
    try {
      await remove.mutateAsync(model.id);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message.slice(0, 120) : 'Remove failed');
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (!src) return;
    e.preventDefault();
    void onRemove(e);
  };

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <button
        type="button"
        onClick={pick}
        onContextMenu={onContextMenu}
        disabled={busy}
        title={src ? 'Click to replace · right-click to remove' : 'Click to upload photo (JPG/PNG/WEBP, ≤2MB)'}
        style={{
          position: 'relative',
          width: 48,
          height: 48,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid #d6d9d2',
          background: src ? `#f4f6f3 center/cover no-repeat url(${src})` : '#f4f6f3',
          padding: 0,
          cursor: busy ? 'wait' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#767b6e',
          overflow: 'hidden',
        }}
      >
        {!src && (busy
          ? <Upload size={14} strokeWidth={1.75} />
          : <ImageOff size={14} strokeWidth={1.75} />)}
        {src && !busy && (
          <span
            aria-label="Remove photo"
            onClick={onRemove}
            style={{
              position: 'absolute',
              top: -6, right: -6,
              width: 16, height: 16,
              borderRadius: '50%',
              background: '#11140f',
              /* fg-on-ink — #fff, not the surface-2 hex --c-cream mapped to
                 elsewhere: here it painted text on an ink fill, not a bg. */
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            }}
          >
            <X size={10} strokeWidth={2} />
          </span>
        )}
      </button>
      {err && (
        /* --c-danger was never defined anywhere, so this always painted its
           #c0392b fallback. Pinned to the err token. */
        <span style={{ fontSize: 10, color: '#b23a3a', maxWidth: 96, lineHeight: 1.2 }}>
          {err}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={onPicked}
      />
    </div>
  );
}

/* ────────────────────────── + New Model dialog ─────────────────────────── */

// Exported so SKU Master's "+ New SKU" button can drive the same dialog.
// `initialCategory` pre-selects the dropdown — used when the SKU Master is
// already filtered to a category, so the user doesn't have to pick again.
// `onCreated` fires after the Model row is saved — used by SKU Master to
// trigger the auto-generate flow without showing the Model Detail page.
// PR #78b — Bulk row shape. Each Model in the batch has its own branding /
// code / name / thickness / description; sizes (or compartments for SOFA)
// are shared below all rows and apply to every Model in the batch.
type ModelRow = {
  // Stable React key — not sent to the API.
  rid:         string;
  branding:    string;
  modelCode:   string;
  name:        string;
  thicknessCm: string;  // MATTRESS only; ignored for other categories
  description: string;
  // Per-model suppliers (optional). Each row carries its own supplier LIST so
  // a bulk batch can map each Model to multiple suppliers (an SKU can have
  // 2-3 suppliers, each with their own supplier code) in one pass.
  suppliers: SupplierEntry[];
};

// One supplier binding config per model row — a model can carry several.
type SupplierEntry = {
  supplierId:   string;
  supplierCode: string;
  unitPrice:    string;
  leadDays:     string;
  moq:          string;
  isMain:       boolean;
};

const emptySupplierEntry = (): SupplierEntry => ({
  supplierId:   '',
  supplierCode: '',
  unitPrice:    '',
  leadDays:     '7',
  moq:          '1',
  isMain:       false,
});

const emptyRow = (): ModelRow => ({
  rid:         `r${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  branding:    '',
  modelCode:   '',
  name:        '',
  thicknessCm: '',
  description: '',
  suppliers:   [emptySupplierEntry()],
});

export function NewModelDialog({
  onClose, initialCategory, onCreated,
}: {
  onClose: () => void;
  initialCategory?: MfgCategory;
  /** Only fires in single-row mode (rows.length === 1). Used by SKU Master's
      "+ New SKU" entry-point to chain into the existing auto-generate flow. */
  onCreated?: (modelId: string, category: MfgCategory) => void;
}) {
  const [category, setCategory]   = useState<MfgCategory>(initialCategory ?? 'SOFA');
  const [rows, setRows]           = useState<ModelRow[]>(() => [emptyRow()]);
  const [pickedSizes, setPickedSizes] = useState<Set<string>>(new Set());
  const [pickedComps, setPickedComps] = useState<Set<string>>(new Set());
  const [batchError, setBatchError]   = useState<string | null>(null);
  const [submitting,  setSubmitting]  = useState(false);

  const maintenance = useMaintenanceConfig('master');
  // Branding datalist — maintenance Brandings pool first, DISTINCT fallback
  // across products + models. Datalist keeps free text possible.
  const brandingPool = useBrandingPool();
  const createMut   = useCreateProductModel();
  const generateMut = useGenerateModelSkus();
  // (B) Wei Siang 2026-06-08 — used to ROLL BACK a just-created model when its
  // SKU generation produced zero rows, so we never leave an empty phantom model.
  const deleteMut   = useDeleteProductModel();
  const askConfirm  = useConfirm();
  const notify      = useNotify();

  // (A) Wei Siang 2026-06-09 — optional one-step supplier assignment is now
  // PER MODEL: each row carries its own supplier + code, and every SKU that
  // row generates is bound to that row's supplier in one batch, so the
  // operator doesn't have to re-open "Supplier codes by Model".
  const suppliersQ      = useSuppliers({ status: 'ACTIVE' });
  const bindingsBatchMut = useCreateBindingsBatch();

  // PR #87 — Commander 2026-05-26: bulk pickers should default to all-on so a
  // new Model is born offering every variant from the global pool; commander
  // toggles off what doesn't apply. Re-runs on pool change so a Maintenance
  // edit (e.g. adding SP to bedframe sizes) doesn't leave the dialog stale.
  const _sizesPool = maintActiveValues((category === 'MATTRESS'
    ? maintenance.data?.data?.mattressSizes
    : maintenance.data?.data?.bedframeSizes) ?? []);
  const _compsPool = maintActiveValues(maintenance.data?.data?.sofaCompartments);
  useEffect(() => {
    if ((category === 'MATTRESS' || category === 'BEDFRAME') && _sizesPool.length > 0) {
      setPickedSizes(new Set(_sizesPool));
    } else {
      setPickedSizes(new Set());
    }
    if (category === 'SOFA' && _compsPool.length > 0) {
      setPickedComps(new Set(_compsPool));
    } else {
      setPickedComps(new Set());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, _sizesPool.length, _compsPool.length]);

  // ACCESSORY / SERVICE have no size/compartment axis — each Model is exactly one
  // SKU (code = model code). They still auto-generate that single SKU so it lands
  // in the SKU Master (Wei Siang 2026-06-09).
  const isSingleSkuCat = category === 'ACCESSORY' || category === 'SERVICE';
  const sharedCount = (category === 'SOFA') ? pickedComps.size : pickedSizes.size;
  const totalSkus   = isSingleSkuCat ? rows.length : rows.length * sharedCount;

  const updateRow = (rid: string, patch: Partial<ModelRow>) => {
    setRows((prev) => prev.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));
  };
  const addRow    = () => setRows((prev) => [...prev, emptyRow()]);
  const removeRow = (rid: string) =>
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.rid !== rid) : prev));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBatchError(null);

    // Validate every row up front so a half-batch failure isn't possible.
    for (const r of rows) {
      if (!r.modelCode.trim() || !r.name.trim()) {
        setBatchError(`Every row needs a model code + name. Row ${rows.indexOf(r) + 1} is incomplete.`);
        return;
      }
      if (category === 'MATTRESS') {
        const t = parseInt(r.thicknessCm.trim(), 10);
        if (!Number.isFinite(t) || t <= 0) {
          setBatchError(`Mattress thickness required. Row ${rows.indexOf(r) + 1} is missing it.`);
          return;
        }
      }
    }
    // (B) Wei Siang 2026-06-08 — a Model must be born with at least one SKU.
    // For the sized/compartmented categories that auto-generate, block here if
    // nothing is picked, so we never create a 0-SKU phantom that then blocks
    // re-tries with a duplicate-code error. (ACCESSORY/SERVICE don't auto-gen
    // and are intentionally created without size variants — left untouched.)
    if (category === 'SOFA' && pickedComps.size === 0) {
      setBatchError('Pick at least one compartment — a model with no SKUs can’t be created.');
      return;
    }
    if ((category === 'MATTRESS' || category === 'BEDFRAME') && pickedSizes.size === 0) {
      setBatchError('Pick at least one size — a model with no SKUs can’t be created.');
      return;
    }

    /* Supplier unit prices are checked HERE, before a single model is created,
       not at the binding loop far below. The binding loop runs after the models
       and their SKUs already exist, so a refusal down there would leave a
       half-made batch behind. What it replaced was `parseFloat(x) || 0`, which
       bound every SKU to the supplier at RM 0.00 — a purchase price of nothing,
       written silently, that only surfaces when someone raises a PO against it. */
    for (const [i, r] of rows.entries()) {
      for (const sup of r.suppliers) {
        if (!sup.supplierId || !sup.supplierCode.trim()) continue;
        const price = parseMoneyToSen(sup.unitPrice, `Supplier price on row ${i + 1}`);
        if (!price.ok) { setBatchError(price.message); return; }
      }
    }

    // Duplicate-code check inside the batch (server would reject the second
    // one, leaving a confusing half-success — easier to catch here first).
    const codes = rows.map((r) => r.modelCode.trim());
    const dup   = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) {
      setBatchError(`Model code "${dup}" appears more than once in this batch.`);
      return;
    }

    /* In-app confirm before creating codes (Commander 2026-06-16 — "开 code
       需要提示词", creation can't be 裸奔). Count the SKUs the same way the
       footer button does: one per size/compartment per row, else one per row. */
    const sizeCount = category === 'SOFA' ? pickedComps.size
      : (category === 'MATTRESS' || category === 'BEDFRAME') ? pickedSizes.size
      : 0;
    const skuTotal = sizeCount > 0 ? rows.length * sizeCount : rows.length;
    const codeList = rows.map((r) => r.modelCode.trim()).filter(Boolean).join(', ');
    if (!(await askConfirm({
      title: `Create ${skuTotal} SKU${skuTotal === 1 ? '' : 's'}?`,
      body: `New ${category} model${rows.length === 1 ? '' : 's'}: ${codeList}`
        + (sizeCount > 0 ? ` × ${sizeCount} size${sizeCount === 1 ? '' : 's'}` : '')
        + `. This creates ${skuTotal} SKU${skuTotal === 1 ? '' : 's'}.`,
      confirmLabel: `Create ${skuTotal} SKU${skuTotal === 1 ? '' : 's'}`,
    }))) return;

    setSubmitting(true);
    try {
      // Build allowedOptions shared across the batch (sizes or compartments
      // — same selection applies to every row). Each row layers its own
      // thickness onto the shared blob for MATTRESS.
      const sharedSizes = (category === 'MATTRESS' || category === 'BEDFRAME') && pickedSizes.size > 0
        ? Array.from(pickedSizes) : null;
      const sharedComps = category === 'SOFA' && pickedComps.size > 0
        ? Array.from(pickedComps) : null;

      // Create Models in parallel — server protects against duplicate codes
      // across batches via the existing 23505 path.
      const createdModels = await Promise.all(rows.map(async (r) => {
        const allowedOptions: Record<string, unknown> = {};
        if (sharedSizes) allowedOptions.sizes = sharedSizes;
        if (sharedComps) allowedOptions.compartments = sharedComps;
        if (category === 'MATTRESS') {
          const t = parseInt(r.thicknessCm.trim(), 10);
          if (Number.isFinite(t) && t > 0) allowedOptions.mattress_thickness_cm = t;
        }
        const res = await createMut.mutateAsync({
          branding:    r.branding.trim() || null,
          modelCode:   r.modelCode.trim(),
          name:        r.name.trim(),
          category,
          description: r.description.trim() || null,
          ...(Object.keys(allowedOptions).length > 0 ? { allowedOptions } : {}),
        });
        return res.model;
      }));

      // Auto-generate SKU variants for every Model whose batch had sizes /
      // compartments selected. Models with neither selected get created but
      // skip generation (matches the existing "empty allowed_options = no
      // restriction" semantics — commander can pick later from detail page).
      let totalGenerated = 0;
      let boundInserted  = 0;
      if (sharedSizes || sharedComps || isSingleSkuCat) {
        const results = await Promise.all(createdModels.map(async (m) => {
          try {
            const r = await generateMut.mutateAsync({ id: m.id });
            return { model: m, generated: r.generated ?? 0, skipped: r.skipped ?? 0, codes: r.codes ?? [], error: null as string | null, reason: r.reason ?? null };
          } catch (err) {
            return { model: m, generated: 0, skipped: 0, codes: [] as string[], error: err instanceof Error ? err.message : 'Something went wrong.', reason: null as string | null };
          }
        }));
        totalGenerated = results.reduce((sum, r) => sum + r.generated, 0);

        // (B) No phantoms — ALL-OR-NOTHING. Any model that ended up with zero
        // SKUs (generation errored, or produced nothing) is deleted so it can't
        // linger as an empty shell that blocks the next attempt with a
        // duplicate-code 409. The failure is surfaced, never swallowed.
        // A model is a REAL failure only if generation errored, or it produced
        // no SKU at all (none generated AND none pre-existing). "Skipped because
        // the SKU code already exists" (skipped > 0) is NOT a failure — the SKU
        // is already in the catalog, so keep the model and still bind its
        // suppliers to it (Commander 2026-06-19: an ACCESSORY whose code already
        // existed was stuck in an un-saveable loop because generated:0 was
        // treated as fatal, and the real reason was hidden).
        const failed = results.filter((r) => r.error != null || (r.generated === 0 && r.skipped === 0));
        if (failed.length > 0) {
          await Promise.all(failed.map((r) => deleteMut.mutateAsync(r.model.id).catch(() => {})));
          const codesFailed = failed.map((r) => r.model.model_code).join(', ');
          const why = failed.map((r) => r.reason || r.error).filter(Boolean).join(' ');
          throw new Error(
            `Couldn't create the SKUs for ${codesFailed}. ${why ? `${why} ` : ''}` +
            `The empty model${failed.length === 1 ? ' was' : 's were'} removed so nothing was left behind.`,
          );
        }

        // (A) Optional PER-MODEL supplier bindings — each row carries its own
        // supplier LIST (an SKU can have 2-3 suppliers, each with their own
        // code). `results` and `rows` share the same order/length, so
        // results[i] pairs with rows[i] (the source row holding the supplier
        // configs). materialCode is the AUTHORITATIVE server-returned code; the
        // per-SKU supplier code reuses the proven composeSupplierSku (size-aware)
        // so we never write the bare model code to every SKU (the
        // duplicate-supplier-code bug from PR #206/#209). Best-effort: the SKUs
        // are valid even if a binding call fails. One bindingsBatchMut per
        // (model, supplier) pair. Runs AFTER the phantom-cleanup throw, so it
        // only executes when every model kept its SKUs.
        for (let i = 0; i < results.length; i++) {
          const r      = results[i];
          const srcRow = rows[i];
          if (!r || !srcRow) continue;
          for (const sup of srcRow.suppliers) {
            if (!sup.supplierId || !sup.supplierCode.trim()) continue;
            const baseCode   = sup.supplierCode.trim();
            /* Already validated in submit()'s preflight, which returns before
               anything is created — so a refusal here is unreachable. Kept
               total rather than asserted because this loop is best-effort and
               must not throw past a batch that already created its models. */
            const parsedPrice = parseMoneyToSen(sup.unitPrice, 'Supplier price');
            const priceCenti = parsedPrice.ok ? parsedPrice.sen : 0;
            const lead       = parseInt(sup.leadDays, 10);
            const moqN       = parseInt(sup.moq, 10);
            const bindings: NewBinding[] = r.codes.map((code) => {
              const sizeCode = (category === 'MATTRESS' || category === 'BEDFRAME')
                ? (code.match(/\(([^)]+)\)\s*$/)?.[1] ?? null) : null;
              const skuObj: Pick<MfgProductRow, 'code' | 'category' | 'size_code'> = { code, category, size_code: sizeCode };
              return {
                materialKind:   'mfg_product' as MaterialKind,
                materialCode:   code,
                materialName:   code,
                supplierSku:    composeSupplierSku(baseCode, skuObj),
                unitPriceCenti: priceCenti,
                currency:       'MYR' as Currency,
                leadTimeDays:   Number.isFinite(lead) ? lead : 7,
                moq:            Number.isFinite(moqN) && moqN > 0 ? moqN : 1,
                isMainSupplier: sup.isMain,
              };
            });
            if (bindings.length === 0) continue;
            try {
              const res = await bindingsBatchMut.mutateAsync({ supplierId: sup.supplierId, bindings });
              boundInserted += res.inserted;
            } catch {
              notify({
                title: `The SKUs for ${r.model.model_code} were created, but linking them to one of the suppliers didn't go through.`,
                body: 'You can link them later from “Supplier codes by Model”.',
                tone: 'error',
              });
            }
          }
        }
      }

      // Single-row + onCreated → chain into the caller's auto-generate flow
      // (preserved for SKU Master "+ New SKU" entry).
      if (rows.length === 1 && createdModels[0] && onCreated) {
        onCreated(createdModels[0].id, category);
      } else {
        await notify({
          title: `Created ${createdModels.length} Model${createdModels.length === 1 ? '' : 's'}` +
            (totalGenerated > 0 ? ` · auto-generated ${totalGenerated} SKU${totalGenerated === 1 ? '' : 's'}` : '') +
            (boundInserted > 0 ? ` · bound ${boundInserted} to supplier` : '') + '.',
        });
        onClose();
      }
    } catch (e2) {
      setBatchError(e2 instanceof Error ? e2.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  // Aliased to the same pools the auto-fill effect already computed so the
  // InlineAllowedOptions below + the All / None buttons inside it work off a
  // single source.
  const sizesPool = _sizesPool;
  const compsPool = _compsPool;

  // (D) Live preview (Wei Siang 2026-06-08) — show what the FIRST row will
  // actually generate, so the operator types the SHORT name and SEES the
  // system auto-build the full SKU code (branding + MATT/dash + size). Mirrors
  // the server's code template + uppercase rule (product-models.ts generate-skus).
  const up = (s: string) => s.toUpperCase();
  const previewRow = rows[0];
  const previewTotal = category === 'SOFA'
    ? pickedComps.size
    : (category === 'MATTRESS' || category === 'BEDFRAME') ? pickedSizes.size : 0;
  const previewCodes: string[] = (() => {
    const code = previewRow?.modelCode.trim() ?? '';
    const brand = previewRow?.branding.trim() ?? '';
    if (!code) return [];
    if (category === 'MATTRESS') {
      return Array.from(pickedSizes).slice(0, 2).map((sz) => up(`${brand ? brand + ' ' : ''}${code} MATT (${sz})`));
    }
    if (category === 'BEDFRAME') {
      return Array.from(pickedSizes).slice(0, 2).map((sz) => up(`${code}-(${sz})`));
    }
    if (category === 'SOFA') {
      return Array.from(pickedComps).slice(0, 2).map((cmp) => up(`${code}-${cmp}`));
    }
    return [];
  })();

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <form
        className={`${styles.modal} ${styles.modalCompact}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        // noValidate: let THIS dialog's own validation (submit() → setBatchError)
        // surface a clear in-dialog message. Without it, native `required` made the
        // browser silently refuse to submit (no event, no error) when Model Code /
        // Name were left blank — the operator saw the placeholder "5530" and thought
        // the field was filled, clicked Create, and nothing happened (Wei Siang 2026-06-09).
        noValidate
        style={{ maxHeight: '90vh', overflowY: 'auto' }}
      >
        {/* Shared datalist for every row card's Branding input. */}
        <datalist id="branding-pool-model-rows">
          {sortByText(brandingPool.pool).map((b) => <option key={b} value={b} />)}
        </datalist>
        {/* PR — Commander 2026-05-26: "做成长方形、大一点". Title + category
            side-by-side so the header doesn't burn three rows before the
            first Model card. Sub line is shrunk into a single sentence. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <h2 className={styles.modalTitle}>New Models (bulk)</h2>
            <p className={styles.modalSub} style={{ margin: 0 }}>
              One row per Model. Pick sizes / compartments below — applied to every row.
            </p>
          </div>
          <label className={styles.compactField} style={{ width: 200 }}>
            <span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as MfgCategory)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>

        {rows.map((row, i) => (
          <ModelRowCard
            key={row.rid}
            row={row}
            index={i}
            category={category}
            canRemove={rows.length > 1}
            suppliers={suppliersQ.data ?? []}
            onChange={(patch) => updateRow(row.rid, patch)}
            onRemove={() => removeRow(row.rid)}
          />
        ))}

        {/* PR #91 — Commander 2026-05-26: "为什么我不能添加 Line 2、Line 3
            这样子的？" The Add-row button existed but was an unstyled ghost
            tucked under the last card. Promoted to a dashed full-width tile
            so it reads as "add another row" the way a spreadsheet does.
            Reskin 2026-07-16 — the hover tint below was a hardcoded
            rgba(213,90,40,.06), a pre-Theme-C orange that never tracked
            --c-orange. Now primary-soft. */}
        <button
          type="button"
          onClick={addRow}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            width: '100%',
            padding: '10px 12px',
            marginTop: 4,
            border: '1px dashed #16695f',
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            color: '#16695f',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-13)',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 120ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#e1efed'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <Plus {...ICON} />
          <span>Add Model {rows.length + 1}</span>
        </button>

        {/* Shared sizes / compartments — applied to every row in the batch. */}
        {(category === 'MATTRESS' || category === 'BEDFRAME') && (
          <InlineAllowedOptions
            label={`Sizes (apply to all ${rows.length} row${rows.length === 1 ? '' : 's'})`}
            hint="Defaults to every size — untick what this batch doesn't sell · pool from Maintenance"
            options={sizesPool}
            picked={pickedSizes}
            onToggle={(v) => setPickedSizes((prev) => {
              const n = new Set(prev);
              if (n.has(v)) n.delete(v); else n.add(v);
              return n;
            })}
            onSetAll={(vs) => setPickedSizes(new Set(vs))}
            formatChip={(code) => {
              // PR #92 — consult Maintenance override so commander relabel
              // (K → "Super K") rides through the chip preview live.
              const info = resolveSizeInfo(code, maintenance.data?.data);
              return info.label && info.label !== code ? `${code} · ${info.label}` : code;
            }}
          />
        )}
        {category === 'SOFA' && (
          <InlineAllowedOptions
            label={`Compartments (apply to all ${rows.length} row${rows.length === 1 ? '' : 's'})`}
            hint="Defaults to every compartment — untick what this batch doesn't offer · pool from Maintenance"
            options={compsPool}
            picked={pickedComps}
            onToggle={(v) => setPickedComps((prev) => {
              const n = new Set(prev);
              if (n.has(v)) n.delete(v); else n.add(v);
              return n;
            })}
            onSetAll={(vs) => setPickedComps(new Set(vs))}
          />
        )}

        {/* (D) Live preview — what the system will actually create. */}
        {previewCodes.length > 0 && (
          <div style={{
            fontSize: 'var(--fs-11)', color: '#767b6e',
            padding: '6px 2px', lineHeight: 1.5,
          }}>
            <span style={{
              fontFamily: 'var(--font-button)', fontSize: 'var(--fs-10)',
              letterSpacing: '0.06em', textTransform: 'uppercase', color: '#0c3f39',
            }}>Will create → </span>
            {previewCodes.map((c, i) => (
              <span key={i}>
                <code style={{ fontWeight: 700, color: '#11140f' }}>{c}</code>
                {i < previewCodes.length - 1 ? ', ' : ''}
              </span>
            ))}
            {previewTotal > previewCodes.length && (
              <span> … +{previewTotal - previewCodes.length} more</span>
            )}
            {previewTotal > 0 && <span> ({previewTotal} SKU{previewTotal === 1 ? '' : 's'} total)</span>}
          </div>
        )}

        {batchError && (
          <div className={BANNER_ERR}>{batchError}</div>
        )}

        <footer className={styles.modalFooter}>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting
              ? 'Creating…'
              : isSingleSkuCat
                ? `Create ${rows.length} SKU${rows.length === 1 ? '' : 's'}`
                : sharedCount > 0
                  ? `Create ${rows.length} × ${sharedCount} = ${totalSkus} SKUs`
                  : `Create ${rows.length} Model${rows.length === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </form>
    </div>
  );
}

/* ─────────── Per-row card (bulk mode) ────────────────────────────────────
   Branding / Model code / Name / (Mattress thickness) / Description plus a
   little × in the corner so commander can prune the row. Inline preview at
   the bottom of the card shows the SKU shape this row + the shared sizes
   below will materialise. */
function ModelRowCard({
  row, index, category, canRemove, suppliers, onChange, onRemove,
}: {
  row:       ModelRow;
  index:     number;
  category:  MfgCategory;
  canRemove: boolean;
  suppliers: SupplierRow[];
  onChange:  (patch: Partial<ModelRow>) => void;
  onRemove:  () => void;
}) {
  // PR — Commander 2026-05-26: "才两个就占满屏幕了". Switched the per-row
  // card from stacked grid (3 visual rows: Branding+Code, Name, Description)
  // to a single landscape line — # · Branding · Model code · Name · [Thickness]
  // · Description · ×. At 1200px modal width this fits comfortably, and the
  // grid-template-columns shifts only to add Thickness for Mattress.
  // Each row card now collapses from ~180px tall to ~50px tall, so 6+ rows
  // fit on screen instead of 2.
  const gridCols =
    category === 'MATTRESS'
      ? '28px 110px 150px minmax(160px, 1.4fr) 80px minmax(160px, 1.4fr) 24px'
      : '28px 110px 150px minmax(160px, 1.4fr) minmax(160px, 1.4fr) 24px';

  return (
    <div className={styles.compactRowCard}>
      <div className={styles.compactRowFields} style={{ gridTemplateColumns: gridCols }}>
        <div className={styles.compactRowBadge}>#{index + 1}</div>

        <label className={styles.compactField}>
          <span>Branding</span>
          <input type="text" value={row.branding} onChange={(e) => onChange({ branding: e.target.value })}
            list="branding-pool-model-rows"
            placeholder={category === 'MATTRESS' ? '2990' : ''} />
        </label>

        <label className={styles.compactField}>
          <span>Model code *</span>
          <input type="text" value={row.modelCode} onChange={(e) => onChange({ modelCode: e.target.value })}
            placeholder={
              category === 'SOFA'     ? 'e.g. 5530' :
              category === 'BEDFRAME' ? 'e.g. 1003' :
              'e.g. AKKA-FIRM'
            }
            required />
        </label>

        <label className={styles.compactField}>
          <span>Name *</span>
          <input type="text" value={row.name} onChange={(e) => onChange({ name: e.target.value })}
            placeholder={
              category === 'SOFA'     ? 'e.g. 5530' :
              category === 'BEDFRAME' ? 'e.g. HILTON' :
              'e.g. AKKA-FIRM'
            }
            required />
        </label>

        {category === 'MATTRESS' && (
          <label className={styles.compactField}>
            <span>Thick (cm) *</span>
            <input type="number" inputMode="numeric" min={1} step={1}
              value={row.thicknessCm} onChange={(e) => onChange({ thicknessCm: e.target.value })}
              placeholder="31" required />
          </label>
        )}

        <label className={styles.compactField}>
          <span>Description</span>
          <input type="text" value={row.description} onChange={(e) => onChange({ description: e.target.value })}
            placeholder="optional" />
        </label>

        {canRemove ? (
          <button type="button" onClick={onRemove} title="Remove this row" className={styles.compactRowClose}>
            ✕
          </button>
        ) : (
          <span />
        )}
      </div>

      {/* (A) Per-model suppliers (optional) — each row maps to its own list of
          suppliers (an SKU can have 2-3, each with their own supplier code);
          every SKU this row generates is bound to each filled entry with a
          code auto-suffixed per size/variant. Only one entry can be Main.
          Shown for every category (None = no binding). */}
      <div style={{ borderTop: '1px solid #d6d9d2', marginTop: 8, paddingTop: 8 }}>
        {row.suppliers.map((sup, si) => {
          const patchSup = (patch: Partial<SupplierEntry>) => {
            onChange({
              suppliers: row.suppliers.map((s, j) => {
                if (j === si) return { ...s, ...patch };
                // Only one Main per model — ticking this entry unticks the rest.
                return patch.isMain ? { ...s, isMain: false } : s;
              }),
            });
          };
          return (
            <div key={si} style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: si > 0 ? 6 : 0 }}>
              <label className={styles.compactField} style={{ minWidth: 220 }}>
                <span>{si === 0 ? 'Supplier (optional)' : `Supplier ${si + 1}`}</span>
                <select value={sup.supplierId} onChange={(e) => patchSup({ supplierId: e.target.value })}>
                  <option value="">— None —</option>
                  {sortByText(suppliers).map((s) => (
                    <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                  ))}
                </select>
              </label>
              {sup.supplierId && (
                <>
                  <label className={styles.compactField} style={{ minWidth: 150 }}>
                    <span>Supplier code</span>
                    <input type="text" value={sup.supplierCode} onChange={(e) => patchSup({ supplierCode: e.target.value })} placeholder="e.g. 9055" />
                  </label>
                  <label className={styles.compactField} style={{ width: 120 }}>
                    <span>Unit price (RM)</span>
                    <input type="number" inputMode="decimal" min={0} step="0.01" value={sup.unitPrice} onChange={(e) => patchSup({ unitPrice: e.target.value })} placeholder="0.00" />
                  </label>
                  <label className={styles.compactField} style={{ width: 90 }}>
                    <span>Lead (days)</span>
                    <input type="number" inputMode="numeric" min={0} value={sup.leadDays} onChange={(e) => patchSup({ leadDays: e.target.value })} placeholder="7" />
                  </label>
                  <label className={styles.compactField} style={{ width: 80 }}>
                    <span>MOQ</span>
                    <input type="number" inputMode="numeric" min={1} value={sup.moq} onChange={(e) => patchSup({ moq: e.target.value })} placeholder="1" />
                  </label>
                  <label className={styles.compactField} style={{ width: 70 }}>
                    <span>Main</span>
                    <input type="checkbox" checked={sup.isMain} onChange={(e) => patchSup({ isMain: e.target.checked })} style={{ width: 16, height: 16 }} />
                  </label>
                </>
              )}
              {row.suppliers.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange({ suppliers: row.suppliers.filter((_, j) => j !== si) })}
                  title="Remove this supplier"
                  className={styles.compactRowClose}
                  style={{ alignSelf: 'center' }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => onChange({ suppliers: [...row.suppliers, emptySupplierEntry()] })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            marginTop: 6, padding: 0, border: 'none', background: 'transparent',
            color: '#16695f', fontFamily: 'var(--font-sans)',
            fontSize: 'var(--fs-12)', fontWeight: 600, cursor: 'pointer',
          }}
        >
          + Add supplier
        </button>
        {row.suppliers.some((s) => s.supplierId && s.supplierCode.trim()) && (
          <div style={{ fontSize: 'var(--fs-10)', color: '#767b6e', marginTop: 4 }}>
            Every generated SKU for this model will be bound to {
              row.suppliers.filter((s) => s.supplierId && s.supplierCode.trim()).length === 1
                ? `this supplier with code “${row.suppliers.find((s) => s.supplierId && s.supplierCode.trim())!.supplierCode.trim()}”`
                : `each filled supplier with its own code (${row.suppliers.filter((s) => s.supplierId && s.supplierCode.trim()).map((s) => `“${s.supplierCode.trim()}”`).join(', ')})`
            } (auto-suffixed per size/variant).
          </div>
        )}
      </div>
    </div>
  );
}

// PR #78b — TemplatePreview removed (was single-row, lived above the Cancel /
// Create buttons). Bulk mode shows the SKU shape implicitly via the row
// inputs + the shared sizes/compartments picker — repeating the preview N
// times for N rows would be noisy. The hardcoded API templates in
// apps/api/src/routes/product-models.ts still produce the same shapes.

/* ─────────── Inline allowed-options chip toggle ──────────────────────────
   Used in NewModelDialog so commander can pick sizes/compartments without
   navigating to the Model detail page after create. PR #87 — Defaults to
   all-on (the parent useEffect pre-fills picked with the full pool); All /
   None mini-buttons live inline with the label so commander can flip every
   chip in one tap. Untick = excluded from the batch's auto-generated SKUs. */
function InlineAllowedOptions({
  label, hint, options, picked, onToggle, onSetAll, formatChip,
}: {
  label:       string;
  hint:        string;
  options:     string[];
  picked:      Set<string>;
  onToggle:    (value: string) => void;
  /** PR #87 — Bulk setter. Receives the full pool (for All) or [] (for None). */
  onSetAll?:   (values: string[]) => void;
  /** Optional pretty-formatter (e.g. SIZE_INFO enrichment). Defaults to raw. */
  formatChip?: (value: string) => string;
}) {
  if (options.length === 0) {
    return (
      <div className={styles.field}>
        <span className="t-eyebrow">{label}</span>
        <p style={{ fontSize: 'var(--fs-12)', color: '#767b6e', margin: 0 }}>
          Maintenance pool is empty — add entries in Maintenance first.
        </p>
      </div>
    );
  }
  const allOn  = picked.size === options.length;
  const allOff = picked.size === 0;
  // PR #91 — Commander 2026-05-26: "Size apply to all 那个地方可以做小一
  // 点啊". Collapsed label + hint + All/None onto a single line so the
  // "Sizes (apply to all 1 row)" header doesn't eat three rows of vertical
  // space above the chip pills.
  return (
    <div className={styles.field} style={{ gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="t-eyebrow" style={{ marginRight: 4 }}>{label}</span>
        <span style={{ fontSize: 'var(--fs-11)', color: '#767b6e' }}>· {hint}</span>
        {onSetAll && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
            <button
              type="button"
              onClick={() => onSetAll(options)}
              disabled={allOn}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-11)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '1px 7px',
                borderRadius: 999,
                border: '1px solid #d6d9d2',
                background: '#fff',
                color: allOn ? '#767b6e' : '#11140f',
                cursor: allOn ? 'default' : 'pointer',
                opacity: allOn ? 0.5 : 1,
              }}
              title="Tick every option"
            >
              All
            </button>
            <button
              type="button"
              onClick={() => onSetAll([])}
              disabled={allOff}
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--fs-11)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '1px 7px',
                borderRadius: 999,
                border: '1px solid #d6d9d2',
                background: '#fff',
                color: allOff ? '#767b6e' : '#11140f',
                cursor: allOff ? 'default' : 'pointer',
                opacity: allOff ? 0.5 : 1,
              }}
              title="Untick every option"
            >
              None
            </button>
          </span>
        )}
      </div>
      {/* PR #91 — Reverted to compact pills (Commander 2026-05-26: "为什么会
          变成正方形？这是什么鬼"). 22 sofa compartments × 92px tiles wrapped
          to 6 rows on a 720px modal; pills wrap to 2-3 rows with the same
          info. formatChip splits "K · 6FT" onto an inline secondary span so
          the label still rides alongside the code without forcing a tile. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {options.map((opt) => {
          const isOn = picked.has(opt);
          const display = formatChip ? formatChip(opt) : opt;
          const parts = display.split(' · ');
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                borderRadius: 999,
                border: '1px solid ' + (isOn ? '#16695f' : '#c2c6bd'),
                background: isOn ? '#16695f' : '#fff',
                /* isOn = petrol fill, so --c-cream here was fg-on-petrol → #fff. */
                color: isOn ? '#fff' : '#11140f',
                cursor: 'pointer',
                transition: 'all 120ms ease-out',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-12)',
                lineHeight: 1.4,
              }}
              title={display}
            >
              <span style={{ fontWeight: 700 }}>{parts[0]}</span>
              {parts[1] && (
                <span style={{ opacity: isOn ? 0.85 : 0.55, fontWeight: 500 }}>
                  · {parts.slice(1).join(' · ')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   EditModelDialog — quick per-model Edit (owner request 2026-06-12).

   The Modular tab's hierarchy rows had Add (+ New Model) and Delete but no
   Edit. This dialog edits name / branding / description plus the allowed
   sizes & compartments, reusing the same chip picker (InlineAllowedOptions)
   the NewModelDialog uses and the same PATCH /product-models/:id the detail
   drawer saves through — which, for SOFA, auto-creates SKUs for any
   newly-activated compartments server-side. Other allowed_options keys
   (leg_heights / divan_heights / gaps / specials / fabrics / thickness)
   are preserved untouched via a merge on save.
   ════════════════════════════════════════════════════════════════════════ */

function EditModelDialog({
  model, onClose,
}: { model: ProductModelRow; onClose: () => void }) {
  const updateMut   = useUpdateProductModel();
  const maintenance = useMaintenanceConfig('master');
  const brandingPool = useBrandingPool();
  const qc = useQueryClient();
  const notify = useNotify();

  const cfg = maintenance.data?.data;
  const isSofa      = model.category === 'SOFA';
  const hasSizeAxis = isSofa || model.category === 'BEDFRAME' || model.category === 'MATTRESS';

  /* Pools: Maintenance master pool ∪ the model's saved picks, so a saved
     value that fell out of the pool still renders as a togglable chip
     instead of silently disappearing (same posture as the SO line editor's
     "(current)" fallback). Fallback literals mirror ProductModelDetail. */
  const sizesPool = useMemo(() => {
    const base = maintActiveValues(isSofa
      ? cfg?.sofaSizes ?? ['24', '26', '28', '30', '32', '35']
      : model.category === 'MATTRESS'
        ? cfg?.mattressSizes ?? ['K', 'Q', 'S', 'SS']
        : cfg?.bedframeSizes ?? ['K', 'Q', 'S', 'SS', 'SK', 'SP']);
    return Array.from(new Set([...base, ...(model.allowed_options?.sizes ?? [])]));
  }, [cfg, isSofa, model]);
  const compsPool = useMemo(() => {
    const base = maintActiveValues(cfg?.sofaCompartments);
    return Array.from(new Set([...base, ...(model.allowed_options?.compartments ?? [])]));
  }, [cfg, model]);

  const [branding,    setBranding]    = useState(model.branding ?? '');
  const [name,        setName]        = useState(model.name);
  const [description, setDescription] = useState(model.description ?? '');
  // Saved picks win; an EMPTY saved list means "no restriction" downstream, so
  // it seeds as all-on — same mental model as ProductModelDetail (PR #87).
  const [pickedSizes, setPickedSizes] = useState<Set<string>>(
    () => new Set((model.allowed_options?.sizes?.length ? model.allowed_options.sizes : sizesPool)),
  );
  const [pickedComps, setPickedComps] = useState<Set<string>>(
    () => new Set((model.allowed_options?.compartments?.length ? model.allowed_options.compartments : compsPool)),
  );
  const [error, setError] = useState<string | null>(null);

  /* When the model saved NO picks (= no restriction) the all-on seed above may
     have run before the Maintenance config arrived (fallback pool). Re-seed
     once the real pool lands so the chips reflect it — mirrors the fillIfEmpty
     re-run in ProductModelDetail. Models WITH saved picks are never reseeded. */
  useEffect(() => {
    if (!cfg) return;
    if (hasSizeAxis && !(model.allowed_options?.sizes?.length)) setPickedSizes(new Set(sizesPool));
    if (isSofa && !(model.allowed_options?.compartments?.length)) setPickedComps(new Set(compsPool));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(cfg)]);

  const onSave = () => {
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    if (isSofa && pickedComps.size === 0) {
      setError('Pick at least one compartment — a sofa model must offer at least one module.');
      return;
    }
    if (hasSizeAxis && pickedSizes.size === 0) {
      setError('Pick at least one size.');
      return;
    }
    // Merge: only the keys this dialog edits change; everything else the
    // detail drawer manages (leg heights, specials, fabrics, …) rides along.
    const ao: AllowedOptions = { ...(model.allowed_options ?? {}) };
    if (hasSizeAxis) ao.sizes = Array.from(pickedSizes);
    if (isSofa)      ao.compartments = Array.from(pickedComps);
    updateMut.mutate(
      {
        id:          model.id,
        branding:    branding.trim() || null,
        name:        name.trim(),
        description: description.trim() || null,
        ...(hasSizeAxis ? { allowedOptions: ao } : {}),
      },
      {
        onSuccess: async (res) => {
          // The SOFA PATCH may have auto-created SKUs for newly-activated
          // compartments — refresh the SKU Master too.
          qc.invalidateQueries({ queryKey: ['mfg-products'] });
          const created = (res as { autoCreatedSkus?: string[] }).autoCreatedSkus ?? [];
          if (created.length > 0) {
            await notify({
              title: 'Saved',
              body: `${created.length} new SKU${created.length === 1 ? '' : 's'} auto-created: ${created.join(', ')}`,
            });
          }
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Something went wrong.'),
      },
    );
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <form
        className={`${styles.modal} ${styles.modalCompact}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSave(); }}
        noValidate
        style={{ maxHeight: '90vh', overflowY: 'auto' }}
      >
        <datalist id="branding-pool-edit-model">
          {sortByText(brandingPool.pool).map((b) => <option key={b} value={b} />)}
        </datalist>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <h2 className={styles.modalTitle}>
              Edit <code className={styles.codeChip}>{model.model_code}</code> · {model.category}
            </h2>
            <p className={styles.modalSub} style={{ margin: 0 }}>
              Name, branding, description and allowed options. Model code stays
              editable from the detail drawer.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#767b6e', cursor: 'pointer', padding: 4, lineHeight: 0 }}
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(160px, 1fr) minmax(160px, 1.4fr)', gap: 'var(--space-3)' }}>
          <label className={styles.compactField}>
            <span>Branding</span>
            <input
              type="text"
              list="branding-pool-edit-model"
              value={branding}
              onChange={(e) => setBranding(e.target.value)}
              placeholder="optional"
            />
          </label>
          <label className={styles.compactField}>
            <span>Name *</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className={styles.compactField}>
            <span>Description</span>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </label>
        </div>

        {hasSizeAxis && (
          <InlineAllowedOptions
            label={isSofa ? 'Seat sizes (inches)' : 'Sizes'}
            hint="Untick what this Model doesn't sell · pool from Maintenance"
            options={sizesPool}
            picked={pickedSizes}
            onToggle={(v) => setPickedSizes((prev) => {
              const n = new Set(prev);
              if (n.has(v)) n.delete(v); else n.add(v);
              return n;
            })}
            onSetAll={(vs) => setPickedSizes(new Set(vs))}
            formatChip={isSofa ? undefined : (code) => {
              const info = resolveSizeInfo(code, maintenance.data?.data);
              return info.label && info.label !== code ? `${code} · ${info.label}` : code;
            }}
          />
        )}
        {isSofa && (
          <InlineAllowedOptions
            label="Compartments"
            hint="Newly-ticked compartments auto-create their SKU in SKU Master on save"
            options={compsPool}
            picked={pickedComps}
            onToggle={(v) => setPickedComps((prev) => {
              const n = new Set(prev);
              if (n.has(v)) n.delete(v); else n.add(v);
              return n;
            })}
            onSetAll={(vs) => setPickedComps(new Set(vs))}
          />
        )}

        {error && <div className={BANNER_ERR}>{error}</div>}

        <footer className={styles.modalFooter}>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={updateMut.isPending}>
            {updateMut.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </footer>
      </form>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ModularAssignSupplierDialog — Modular-tab parallel of SupplierDetail's
   ModelSkuPickerDialog (PR #206 / PR #209). Reached from the multi-select
   toolbar: tick N Models → "Assign to supplier · N selected" CTA → this
   dialog.

   PR — Commander 2026-05-27 (multi-supplier):
     > supplier 为什么不可以 multiselect 然后让我填写他们分别的 code

   Flow:
     1. Pick MULTIPLE suppliers via the chip-row MultiSupplierPicker.
     2. Table renders one row per (Model × Supplier) pair grouped under a
        per-Model sub-header — commander types a distinct supplier_code +
        description + price + lead + MOQ + main toggle for each pair.
     3. Each (Model × Supplier) row has a "▸ N SKUs" expander showing the
        per-SKU `supplier_sku` previewed via composeSupplierSku() against
        THAT row's typed base code.
     4. Save → for each row with a non-empty supplier_code, expand the
        Model's ACTIVE SKUs and add one binding per SKU. Bindings are then
        bucketed BY supplier and dispatched as one /bindings/batch POST per
        supplier (the API endpoint is per-supplier — see
        `apps/api/src/routes/suppliers.ts` POST /:supplierId/bindings/batch).
        Server de-dupes against existing rows.

   Reuses SkuPreviewStrip from SupplierDetail so the chip-strip stays in
   sync across both entry points.
   ════════════════════════════════════════════════════════════════════════ */

type AssignDraft = {
  /** Composite key: `${modelId}::${supplierId}` — used as the React key
      and Map key for the per-(Model × Supplier) row. */
  key:            string;
  modelId:        string;
  modelCode:      string;
  modelName:      string;
  supplierId:     string;
  supplierCode_s: string; // supplier.code (display)
  supplierName:   string; // supplier.name (display)
  /** Full SKU rows so the preview / save path can derive a per-SKU
      supplier_sku suffix (compartment for sofa, size_code for bedframe /
      mattress) via composeSupplierSku(). PR — Commander 2026-05-27. */
  skus:           MfgProductRow[];
  supplierCode:   string; // commander-typed code for this (Model × Supplier)
  description:    string;
  unitPriceCenti: number;
  leadTimeDays:   number;
  moq:            number;
  isMainSupplier: boolean;
};

export function ModularAssignSupplierDialog({
  modelIds, onClose, onSaved,
}: {
  modelIds: string[];
  onClose:  () => void;
  onSaved:  () => void;
}) {
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });
  const modelsQ    = useProductModels();
  // PR — pull every active SKU once and group by model_id client-side; same
  // pattern as ModelSkuPickerDialog. 2990s' catalogue is small enough that
  // the alternative (one query per Model) is wasteful.
  const productsQ  = useMfgProducts();
  const batchMut   = useCreateBindingsBatch();
  const notify     = useNotify();

  // PR — Commander 2026-05-27: multi-select suppliers. Each row in the table
  // below is one (Model × Supplier) pair. We key drafts by `modelId::supplierId`.
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [drafts,      setDrafts]      = useState<Record<string, AssignDraft>>({});
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [error,       setError]       = useState<string | null>(null);
  // Bind-in-flight indicator while we fan out per-supplier batch calls.
  const [saving, setSaving] = useState(false);

  const toggleExpanded = (id: string) => setExpanded((s) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });

  // Seed one draft per (Model × Supplier) pair. SKU list comes from the
  // ACTIVE SKUs under that model_id; price defaults to the average
  // base_price of those SKUs. Existing drafts are preserved across
  // supplier add/remove — re-add a supplier and you'll get back to a fresh
  // row only if it wasn't already present.
  useEffect(() => {
    if (!modelsQ.data || !productsQ.data || !suppliersQ.data) return;
    const skusByModel = new Map<string, MfgProductRow[]>();
    for (const p of productsQ.data) {
      if (!p.model_id) continue;
      const arr = skusByModel.get(p.model_id) ?? [];
      arr.push(p);
      skusByModel.set(p.model_id, arr);
    }
    const supplierById = new Map(suppliersQ.data.map((s) => [s.id, s]));
    setDrafts((prev) => {
      const seeded: Record<string, AssignDraft> = {};
      for (const modelId of modelIds) {
        const model = modelsQ.data!.find((m) => m.id === modelId);
        if (!model) continue;
        const skus = skusByModel.get(modelId) ?? [];
        const prices = skus.map((s) => s.base_price_sen ?? 0).filter((v) => v > 0);
        const avg = prices.length
          ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
          : 0;
        for (const supplierId of supplierIds) {
          const supplier = supplierById.get(supplierId);
          if (!supplier) continue;
          const key = `${modelId}::${supplierId}`;
          const existing = prev[key];
          if (existing) {
            // Preserve any typed values + refresh SKU references in case
            // upstream catalogue refetched.
            seeded[key] = { ...existing, skus };
            continue;
          }
          seeded[key] = {
            key,
            modelId,
            modelCode:      model.model_code,
            modelName:      model.name,
            supplierId,
            supplierCode_s: supplier.code,
            supplierName:   supplier.name,
            skus,
            supplierCode:   '',
            description:    '',
            unitPriceCenti: avg,
            leadTimeDays:   7,
            moq:            1,
            isMainSupplier: false,
          };
        }
      }
      return seeded;
    });
  // Re-seed when input Models, picked suppliers, or upstream data change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIds.join('|'), supplierIds.join('|'), modelsQ.data?.length, productsQ.data?.length, suppliersQ.data?.length]);

  const setDraft = (key: string, patch: Partial<AssignDraft>) => {
    setDrafts((s) => ({ ...s, [key]: { ...s[key]!, ...patch } }));
  };

  const loading = suppliersQ.isLoading || modelsQ.isLoading || productsQ.isLoading;

  const submit = () => {
    setError(null);
    if (supplierIds.length === 0) { setError('Pick at least one supplier first.'); return; }
    // Bucket bindings BY supplier — the API's /bindings/batch endpoint is
    // scoped to one supplier per call (see apps/api/src/routes/suppliers.ts
    // line 268). We fan out N parallel batch POSTs.
    const bySupplier = new Map<string, NewBinding[]>();
    for (const d of Object.values(drafts)) {
      const code = d.supplierCode.trim();
      // Skip (Model × Supplier) rows with no supplier code typed —
      // commander left this pair empty on purpose.
      if (!code) continue;
      const bucket = bySupplier.get(d.supplierId) ?? [];
      for (const sku of d.skus) {
        // PR — Commander 2026-05-27: per-SKU supplier_sku auto-suffix.
        // composeSupplierSku("5539", sofaSku) → "5539-1A(LHF)" etc.
        const supplierSku = composeSupplierSku(code, sku);
        bucket.push({
          materialKind:   'mfg_product' as MaterialKind,
          materialCode:   sku.code,
          materialName:   sku.name ?? sku.code,
          supplierSku,
          unitPriceCenti: d.unitPriceCenti,
          currency:       'MYR' as Currency,
          leadTimeDays:   d.leadTimeDays,
          moq:            d.moq,
          isMainSupplier: d.isMainSupplier,
          notes:          d.description.trim() || undefined,
        });
      }
      bySupplier.set(d.supplierId, bucket);
    }
    const totalPlanned = Array.from(bySupplier.values()).reduce((a, b) => a + b.length, 0);
    if (totalPlanned === 0) {
      setError('Type at least one supplier code so we know which (Model × Supplier) to map.');
      return;
    }

    // Fan out one POST per supplier. We use the same mutation but call it
    // imperatively so we can await + aggregate results. Errors short-circuit
    // and surface in the error banner — partial successes are still kept
    // in the database (the server inserts atomically per call).
    setSaving(true);
    let totalInserted = 0;
    let totalSkipped  = 0;
    const calls = Array.from(bySupplier.entries()).map(([supplierId, bindings]) =>
      batchMut.mutateAsync({ supplierId, bindings }),
    );
    Promise.all(calls)
      .then(async (results) => {
        for (const res of results) {
          totalInserted += res.inserted;
          totalSkipped  += res.skipped;
        }
        if (totalSkipped > 0) {
          await notify({
            title:
              `Inserted ${totalInserted} SKU mapping${totalInserted === 1 ? '' : 's'} across ` +
              `${bySupplier.size} supplier${bySupplier.size === 1 ? '' : 's'}; ` +
              `skipped ${totalSkipped} already bound.`,
          });
        }
        onSaved();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong.'))
      .finally(() => setSaving(false));
  };

  const supplierOptions = suppliersQ.data ?? [];
  const draftRows       = Object.values(drafts);
  // For the footer + Save button: total bindings that WILL be POSTed.
  const totalSkus       = draftRows.reduce(
    (sum, d) => sum + (d.supplierCode.trim() ? d.skus.length : 0), 0,
  );
  // For the per-Model sub-header: how many supplier rows are under each Model.
  const suppliersPerModel = new Map<string, number>();
  for (const d of draftRows) {
    suppliersPerModel.set(d.modelId, (suppliersPerModel.get(d.modelId) ?? 0) + 1);
  }
  // Stable ordering — group by Model in the order they were picked,
  // suppliers in the order they were added.
  const modelOrder = modelIds.filter((id) => suppliersPerModel.has(id));

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <form
        className={`${styles.modal} ${styles.modalCompact}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        style={{ maxHeight: '90vh', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <h2 className={styles.modalTitle}>
              Assign {modelIds.length} Model{modelIds.length === 1 ? '' : 's'} to suppliers
            </h2>
            <p className={styles.modalSub} style={{ margin: 0 }}>
              Pick one or more suppliers, then type each supplier's code + description per Model.
              Save fans bindings out across every active SKU under each Model.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#767b6e',
              cursor: 'pointer',
              padding: 4,
              lineHeight: 0,
            }}
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        <MultiSupplierPicker
          suppliers={supplierOptions}
          selectedIds={supplierIds}
          onChange={setSupplierIds}
          loading={loading}
          disabled={saving || batchMut.isPending}
        />

        <div style={{
          border: '1px solid #d6d9d2',
          borderRadius: 'var(--radius-md)',
          background: '#fff',
          // The table area takes the remaining modal height and scrolls on its
          // own, so the header + supplier picker + footer (Save) stay put no
          // matter how many (Model × Supplier) rows there are.
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)' }}>
            <thead>
              <tr style={{ background: '#e3e6e0', borderBottom: '2px solid #d6d9d2' }}>
                <th style={thStyle}>Model · Supplier</th>
                <th style={thStyle}>Supplier Code</th>
                <th style={thStyle}>Description</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Unit Price (RM)</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Lead (d)</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>MOQ</th>
                <th style={thStyle}>Main</th>
              </tr>
            </thead>
            <tbody>
              {draftRows.length === 0 && (
                <tr><td colSpan={7} style={{ ...tdStyle, color: '#767b6e', textAlign: 'center' }}>
                  {loading
                    ? 'Loading…'
                    : supplierIds.length === 0
                      ? 'Pick at least one supplier above to see the (Model × Supplier) rows.'
                      : 'No Models in the selection have any SKUs to map.'}
                </td></tr>
              )}
              {modelOrder.map((modelId) => {
                // PR — Commander 2026-05-27: render a small per-Model
                // sub-header so the (Model × Supplier) rows underneath are
                // visually grouped — "Pantti — 3 suppliers".
                const rowsForModel = draftRows.filter((d) => d.modelId === modelId);
                if (rowsForModel.length === 0) return null;
                const head = rowsForModel[0]!;
                return (
                  <Fragment key={modelId}>
                    <tr style={{ background: '#e3e6e0', borderBottom: '2px solid #d6d9d2' }}>
                      <td colSpan={7} style={{
                        padding: '6px 12px',
                        fontSize: 'var(--fs-12)',
                        color: '#767b6e',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}>
                        <span style={{ fontFamily: 'var(--font-mono)', color: '#11140f', fontWeight: 600 }}>
                          {head.modelCode}
                        </span>
                        {' · '}
                        <span style={{ color: '#11140f' }}>{head.modelName}</span>
                        {' — '}
                        {rowsForModel.length} supplier{rowsForModel.length === 1 ? '' : 's'}
                        {' · '}
                        {head.skus.length} SKU{head.skus.length === 1 ? '' : 's'} each
                      </td>
                    </tr>
                    {rowsForModel.map((d) => {
                      const isOpen = expanded.has(d.key);
                      return (
                        <Fragment key={d.key}>
                          <tr style={{ borderBottom: '1px solid #d6d9d2' }}>
                            <td style={tdStyle}>
                              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{d.supplierCode_s}</div>
                              <div style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>{d.supplierName}</div>
                              <button
                                type="button"
                                onClick={() => toggleExpanded(d.key)}
                                disabled={d.skus.length === 0}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  marginTop: 2,
                                  fontSize: 'var(--fs-12)',
                                  cursor: d.skus.length === 0 ? 'default' : 'pointer',
                                  color: isOpen ? '#0c3f39' : '#767b6e',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: 2,
                                }}
                                title={isOpen ? 'Hide SKU list' : 'Show SKU list'}
                              >
                                {isOpen ? '▾' : '▸'} {d.skus.length} SKU{d.skus.length === 1 ? '' : 's'} will be mapped
                              </button>
                            </td>
                            <td style={tdStyle}>
                              <input
                                value={d.supplierCode}
                                onChange={(e) => setDraft(d.key, { supplierCode: e.target.value })}
                                placeholder="Their code for this Model"
                                style={inputStyle}
                              />
                            </td>
                            <td style={tdStyle}>
                              <input
                                value={d.description}
                                onChange={(e) => setDraft(d.key, { description: e.target.value })}
                                placeholder='e.g. "Foam B grade, 6-week lead"'
                                style={{ ...inputStyle, minWidth: 180 }}
                              />
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              <MoneyInput
                                bare
                                valueSen={d.unitPriceCenti}
                                onCommit={(sen) => setDraft(d.key, { unitPriceCenti: sen ?? 0 })}
                                style={{ ...inputStyle, width: 100, textAlign: 'right' }}
                              />
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              <input
                                type="number"
                                value={d.leadTimeDays}
                                onChange={(e) => setDraft(d.key, { leadTimeDays: Number(e.target.value) || 0 })}
                                style={{ ...inputStyle, width: 60, textAlign: 'right' }}
                              />
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                              <input
                                type="number"
                                value={d.moq}
                                onChange={(e) => setDraft(d.key, { moq: Number(e.target.value) || 0 })}
                                style={{ ...inputStyle, width: 60, textAlign: 'right' }}
                              />
                            </td>
                            <td style={tdStyle}>
                              <input
                                type="checkbox"
                                checked={d.isMainSupplier}
                                onChange={(e) => setDraft(d.key, { isMainSupplier: e.target.checked })}
                              />
                            </td>
                          </tr>
                          {isOpen && d.skus.length > 0 && (
                            <tr style={{ background: '#f4f6f3' }}>
                              <td colSpan={7} style={{
                                padding: 'var(--space-2) var(--space-3)',
                                borderBottom: '1px solid #d6d9d2',
                                borderTop: '1px dashed #d6d9d2',
                              }}>
                                {/* PR — preview uses THIS row's typed base code +
                                    composeSupplierSku() so commander sees the
                                    "BOOQIT-1A(LHF) → 5539-1A(LHF)" before Save,
                                    distinct per (Model × Supplier) row. */}
                                <SkuPreviewStrip
                                  toMap={d.skus.map((s) => s.code)}
                                  alreadyBound={[]}
                                  previewMap={
                                    d.supplierCode.trim()
                                      ? Object.fromEntries(
                                          d.skus.map((s) => [s.code, composeSupplierSku(d.supplierCode, s)]),
                                        )
                                      : undefined
                                  }
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && (
          <div className={BANNER_ERR}>{error}</div>
        )}

        <footer className={styles.modalFooter} style={{ justifyContent: 'space-between' }}>
          <span style={{ color: '#767b6e', fontSize: 'var(--fs-12)' }}>
            {totalSkus > 0
              ? `Will POST ${totalSkus} binding${totalSkus === 1 ? '' : 's'} across ` +
                `${new Set(draftRows.filter((d) => d.supplierCode.trim()).map((d) => d.supplierId)).size} supplier${
                  new Set(draftRows.filter((d) => d.supplierCode.trim()).map((d) => d.supplierId)).size === 1 ? '' : 's'} ` +
                `(server skips already-bound rows).`
              : 'Type a supplier code on at least one (Model × Supplier) row to enable Save.'}
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={saving || batchMut.isPending || totalSkus === 0 || supplierIds.length === 0}
            >
              {(saving || batchMut.isPending) ? 'Saving…' : `Save ${totalSkus} binding${totalSkus === 1 ? '' : 's'}`}
            </Button>
          </span>
        </footer>
      </form>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  // Batch 3 theme skin — the SO-sample DataTable header spec (sans 10px/700,
  // tracking-brand 0.18em, surface-dim #e3e6e0, ink).
  fontFamily: 'var(--font-sans)',
  fontSize: 10,
  fontWeight: 700,
  textAlign: 'left',
  padding: '8px 12px',
  color: 'var(--c-ink, #11140f)',
  textTransform: 'uppercase',
  letterSpacing: '0.18em',
  // Keep the column headers visible while the (Model × Supplier) rows scroll.
  position: 'sticky',
  top: 0,
  background: '#e3e6e0',
  zIndex: 1,
};
const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 'var(--fs-13)',
  verticalAlign: 'top',
};
const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  background: '#f4f6f3',
  border: '1px solid #d6d9d2',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};
