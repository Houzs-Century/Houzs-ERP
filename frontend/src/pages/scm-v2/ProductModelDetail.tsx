// ----------------------------------------------------------------------------
// ProductModelDetail — full-page route at /product-models/:id (PR #49).
//
// Second-layer template entity. Each Model groups many SKU rows on
// mfg_products (folded under base_model + the new model_id FK). Stock,
// cost, pricing all stay per-SKU — Model only owns the allowed-options
// pool + photo + name template.
//
// Sections:
//   1. Header — back link, Layers icon, model code · name · category pill ·
//      active toggle, action buttons (Save / Deactivate / Delete)
//   2. Model info card — editable name + description (model_code + category
//      read-only after creation)
//   3. Allowed options panel — per-category chip toggles persisted as JSONB
//   4. SKU variants list — read-only, links to per-SKU page for pricing edits
//
// PR #50 will add the "Generate SKU variants" button that uses
// allowed_options to bulk-INSERT mfg_products rows.
// ----------------------------------------------------------------------------

import { lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Link } from 'react-router-dom';
import { ArrowLeft, ImagePlus, Save, Store, Trash2, Wand2, X, Power, PowerOff } from 'lucide-react';
import { LazySlot } from '../../components/LazySlot';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/Layout';
import { maintActiveValues } from '@2990s/shared';
import {
  useProductModel, useUpdateProductModel, useDeleteProductModel, useGenerateModelSkus,
  useActivateOneShot, useBrandingPool, useUploadProductModelPhoto,
  type AllowedOptions, type AllowedOptions as AOpts,
} from '../../vendor/scm/lib/product-models-queries';
import { useMaintenanceConfig, useUpdateMfgProductStatus, useSpecialAddons } from '../../vendor/scm/lib/mfg-products-queries';
import { useFabricLibrary } from '../../vendor/scm/lib/queries';
import { useAuth } from '../../auth/AuthContext';
import { prepareImageForUpload } from '../../lib/imagePipeline';
import { canViewProductCost } from '../../auth/salesAccess';
import { resolveSizeInfo } from '../../vendor/scm/lib/size-info';
import styles from './ProductModelDetail.module.css';
import { SkeletonDetailPage } from '../../vendor/scm/components/Skeleton';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { PhotoGallery as ProductModelPhotoGallery } from '../../components/scm-v2/PhotoGallery';

// Staff #5 — reuse the proven multi-supplier assign dialog from the Models list,
// scoped to this single model, so an operator can bind suppliers to an EXISTING
// model's SKUs from the edit page. Lazy-imported to break the ProductModels ⇄
// ProductModelDetail circular import (ProductModels renders this page as a drawer).
const AssignSupplierDialog = lazy(() =>
  import('./ProductModels').then((m) => ({ default: m.ModularAssignSupplierDialog })));

const ICON = { size: 14, strokeWidth: 1.75 } as const;

/* Section card — replaces the bespoke .card, whose white/hairline/shadow
   only resolved through the removed .page token cascade. Same slab the
   Inventory / WarehouseRacks reskin uses. */
const CARD = 'flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-stone';

/* Error banners — err tokens (were the bespoke .errorBanner / .photoError,
   which painted --c-festive-b on a raw rgba tint). */
const BANNER_ERR =
  'rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-[14px] text-err';
const BANNER_ERR_SM =
  'rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err';

/* Back link / Close — the detail page's escape hatch. Same compact
   secondary-button recipe PageHeader gives its own secondaryActions (and
   the shape WarehouseRacks' "← Warehouses" link uses), so the link reads as
   part of the action rail instead of floating above the title. */
const BACK_LINK =
  'inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary';

/* Resolve a Model photo URL for <img src>. Two upload paths coexist:
   · bulk / API upload (POST /product-models/:id/photo) → R2 proxy path,
     stored as a RELATIVE url "/product-models/{id}/photo/{key}" → must be
     prefixed with VITE_API_URL to hit the Worker, not the backend origin.
   · legacy Supabase-Storage upload → a full https:// public URL → use as-is.
   (Commander 2026-05-28: Model photo rendered as a broken image because the
   relative R2 path resolved against the backend origin → 404.) */
const API_URL =
  ((import.meta.env.VITE_API_URL ||
    (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) as string) +
  '/api/scm';
const resolveModelPhotoUrl = (u: string | null | undefined): string | undefined => {
  if (!u) return undefined;
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  return API_URL ? `${API_URL}${u.startsWith('/') ? '' : '/'}${u}` : u;
};

// Fallback pools used only when the global Maintenance config doesn't have the
// pool keys yet (older deployments). Commander manages the real lists from
// the Maintenance page → Bedframe Sizes / Sofa Compartments / Mattress Sizes
// sub-tabs (PR #50). These constants exist so the UI never renders blank.
// Canonical parens form — byte-identical to the codes the Maintenance master
// pool stores (2026-06-04 unification: ONE compartment vocabulary everywhere).
const FALLBACK_SOFA_COMPARTMENTS = [
  '1A(LHF)', '1A(RHF)', '1B(LHF)', '1B(RHF)', '1NA', '1S',
  '2A(LHF)', '2A(RHF)', '2B(LHF)', '2B(RHF)', '2NA', '2S',
  '3S', 'CNR', 'L(LHF)', 'L(RHF)', 'STOOL', 'Console',
];

const FALLBACK_BEDFRAME_SIZES = ['K', 'Q', 'S', 'SS', 'SK', 'SP'];
const FALLBACK_MATTRESS_SIZES = ['K', 'Q', 'S', 'SS'];

// PR #119 — Commander 2026-05-26: "Model detail 页面（DASDA 那个）不该
// 跳出去独立 URL，应该在 Modular tab 内嵌入". Same component now powers
// two surfaces:
//   1. /product-models/:id route (direct deep-link, full-page chrome)
//   2. <Drawer> overlay on the Modular tab (no route change)
// `modelId` prop wins over the URL param; `onClose` swaps the header's
// back-link for an ✕ button and re-routes the delete-success callback
// to the parent state instead of navigate('/products').
export const ProductModelDetail = ({
  modelId,
  onClose,
}: {
  modelId?: string;
  onClose?: () => void;
} = {}) => {
  const { id: paramId } = useParams<{ id: string }>();
  const id = modelId ?? paramId;
  const embedded = Boolean(modelId);
  /* Owner 2026-07-17 — cost price is director-only; see canViewProductCost.
     Until now this page carried NO auth of any kind (no useAuth, no pageAccess,
     no costing gate): every SKU's cost_price_sen printed to anyone who could
     reach the route. Same column exists on mobile (MobileModuleList products
     browse) and is gated by the same helper there, so the two platforms answer
     identically — the ruling's other half. */
  const { user: costUser } = useAuth();
  const showCost = canViewProductCost(costUser);
  const navigate = useNavigate();
  const { data, isPending, error } = useProductModel(id);
  const updateMut = useUpdateProductModel();
  const deleteMut = useDeleteProductModel();
  const generateMut = useGenerateModelSkus();
  const statusMut = useUpdateMfgProductStatus();
  const activateOneShotMut = useActivateOneShot();
  // HOUZS VENDOR — the source uploaded the model photo client-side via
  // supabase.storage; here it routes through the Worker R2 path instead.
  const uploadPhotoMut = useUploadProductModelPhoto();
  const maintenance = useMaintenanceConfig('master');
  const askConfirm = useConfirm();
  const notify = useNotify();
  // Staff #5 — supplier-assign dialog (reuses ModularAssignSupplierDialog).
  const [assigning, setAssigning] = useState(false);
  // Branding datalist — maintenance Brandings pool first, DISTINCT fallback.
  const brandingPool = useBrandingPool();
  // Fabric library — pool of active fabric slugs displayed in the FABRICS
  // option group for SOFA Models.
  const fabricLibQ = useFabricLibrary();

  // Specials pool now comes from the Special Add-ons table (special_addons),
  // not the legacy maintenance_config specials/sofaSpecials (Loo 2026-06-08 —
  // Backend↔POS parity). The add-on `code` shares the same string namespace
  // as the old maintenance values, so a Model's saved allowed_options.specials
  // keep matching with no data migration. Filter by the Model's category +
  // active, ordered like the Special Add-ons tab.
  const specialAddonsQ = useSpecialAddons();
  const specialsByCategory = useMemo(() => {
    const rows = (specialAddonsQ.data ?? [])
      .filter((r) => r.active)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.code ?? '').localeCompare(b.code ?? ''));
    const pick = (cat: string) => rows.filter((r) => r.categories.includes(cat)).map((r) => r.code);
    return { bedframe: pick('BEDFRAME'), sofa: pick('SOFA') };
  }, [specialAddonsQ.data]);

  const [branding, setBranding] = useState('');
  const [modelCode, setModelCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [allowed, setAllowed] = useState<AllowedOptions>({});
  const [addCodesOpen, setAddCodesOpen] = useState(false);

  // PR #97 — Commander 2026-05-26: "可以放照片的啊，为什么不能放呢". Photo
  // upload lives next to Model info, drives `product_models.photo_url` via
  // the existing PATCH /product-models/:id route. Storage: Supabase Storage
  // 'model-photos' bucket (migration 0066, public read / staff write).
  // Auto-save on upload so commander doesn't have to also hit "Save changes".
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError,     setPhotoError]     = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  // PR #87 — Commander 2026-05-26: "正常 Allow Option 都是全开的，只有关起来
  // 的" (= "Allow Options should default to all-on; only what you turn off is
  // excluded"). Mental model flipped: instead of "tick the ones you offer",
  // every relevant pool key gets pre-filled with the full Maintenance pool
  // on first load. Toggle-off = exclusion. Empty list still means "no
  // restriction" downstream — the auto-fill is a UX layer only.
  const cfg = maintenance.data?.data;
  useEffect(() => {
    if (!data?.model) return;
    setBranding(data.model.branding ?? '');
    setModelCode(data.model.model_code);
    setName(data.model.name);
    setDescription(data.model.description ?? '');

    const saved = data.model.allowed_options ?? {};
    const next: AllowedOptions = { ...saved };
    const fillIfEmpty = (key: keyof AllowedOptions, pool: string[]) => {
      const cur = (next as Record<string, unknown>)[key];
      if (pool.length > 0 && (!Array.isArray(cur) || cur.length === 0)) {
        (next as Record<string, unknown>)[key] = [...pool];
      }
    };
    // Pull global pools the same way the panels do below so the auto-fill
    // matches what commander sees.
    const sofaComps = maintActiveValues(cfg?.sofaCompartments ?? FALLBACK_SOFA_COMPARTMENTS);
    const sofaSizes = maintActiveValues(cfg?.sofaSizes ?? ['24', '26', '28', '30', '32', '35']);
    const sofaLegs  = (cfg?.sofaLegHeights ?? []).map((o) => o.value);
    const sofaSpec  = specialsByCategory.sofa;
    const bfSizes   = maintActiveValues(cfg?.bedframeSizes ?? FALLBACK_BEDFRAME_SIZES);
    const divan     = (cfg?.divanHeights ?? []).map((o) => o.value);
    const totalH    = (cfg?.totalHeights ?? []).map((o) => o.value);
    const gaps      = maintActiveValues(cfg?.gaps);
    const legs      = (cfg?.legHeights ?? []).map((o) => o.value);
    const specials  = specialsByCategory.bedframe;
    const matSizes  = maintActiveValues(cfg?.mattressSizes ?? FALLBACK_MATTRESS_SIZES);

    if (data.model.category === 'SOFA') {
      fillIfEmpty('compartments', sofaComps);
      fillIfEmpty('sizes',        sofaSizes);
      fillIfEmpty('leg_heights',  sofaLegs);
      fillIfEmpty('specials',     sofaSpec);
    } else if (data.model.category === 'BEDFRAME') {
      fillIfEmpty('sizes',         bfSizes);
      fillIfEmpty('divan_heights', divan);
      fillIfEmpty('total_heights', totalH);
      fillIfEmpty('gaps',          gaps);
      fillIfEmpty('leg_heights',   legs);
      fillIfEmpty('specials',      specials);
    } else if (data.model.category === 'MATTRESS') {
      fillIfEmpty('sizes', matSizes);
    }
    setAllowed(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.model?.id, data?.model?.updated_at, cfg, specialsByCategory]);

  /* isPending, NOT isLoading (BUG-HISTORY 2026-07-16, "打開會 error 先然後再
     loading 出來"). isLoading is (isPending && isFetching), so a pending-but-not-
     fetching query (disabled, or paused offline) fell through to the bare
     `!data?.model` guard below and painted "Model not found." before the fetch
     had run. isPending covers all three states. */
  if (isPending) return <SkeletonDetailPage />;
  if (error) {
    return (
      <div className={BANNER_ERR}>
        {/* authedFetch already ran this through humanApiError, so `message` is a
            plain sentence. String(error) is the non-Error fallback only. */}
        Failed to load model. {error instanceof Error ? error.message : 'Something went wrong.'}
      </div>
    );
  }
  /* Reached only once the query has SETTLED and did not error, so this now means
     "the server answered and there is no such model" — never "we haven't asked
     yet". */
  if (!data?.model) return <div className="p-6 text-[14px] text-ink-secondary">Model not found.</div>;

  const model = data.model;

  const onSave = () => {
    if (!id) return;
    const code = modelCode.trim();
    if (!code) {
      notify({ title: 'Model code is required.', tone: 'error' });
      return;
    }
    updateMut.mutate({
      id,
      modelCode: code,
      branding: branding.trim() || null,
      name,
      description: description.trim() || null,
      allowedOptions: allowed,
    });
  };

  const onToggleActive = () => {
    if (!id) return;
    updateMut.mutate({ id, active: !model.active });
  };

  const onDelete = async () => {
    if (!id) return;
    const skuCount = data.skus.length;
    if (!(await askConfirm({
      title: `Delete Model "${model.model_code} · ${model.name}"?`,
      body: `${skuCount} SKU(s) will keep their rows but lose the Model link.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    deleteMut.mutate(id, {
      onSuccess: () => {
        // Embedded mode: close the drawer + let the parent invalidate the
        // Modular list. Direct-route mode: bounce back to the vendored list.
        if (embedded && onClose) onClose();
        else navigate('/scm/product-models');
      },
    });
  };

  /** Validate + upload to Supabase Storage, then PATCH the Model with the
   *  public URL. Bucket policies (migration 0066) grant authenticated INSERT
   *  on `model-photos`; the bucket is `public: true` so the getPublicUrl
   *  result is a directly-loadable <img src=…>. */
  const onPhotoFile = async (rawFile: File) => {
    if (!id) return;
    setPhotoError(null);
    if (!rawFile.type.startsWith('image/')) {
      setPhotoError('Pick an image file (JPG / PNG / WebP).');
      return;
    }
    setPhotoUploading(true);
    try {
      /* WO-7 — the backend caps this endpoint at 2 MB, so raw phone photos
         used to bounce. Compress to the same 1600px budget the ProductModels
         list cell already uses; a still-oversized result gets the clear
         client-side error instead of a server 400. */
      const { file } = await prepareImageForUpload(rawFile, { maxDimension: 1600, wantThumb: false });
      if (file.size > 2 * 1024 * 1024) {
        setPhotoError('Still over 2 MB after compression - use a smaller image.');
        setPhotoUploading(false);
        return;
      }
      // HOUZS VENDOR — multipart POST to the Worker, which uploads to R2 and
      // patches product_models.photo_url itself (replaces the supabase.storage
      // client-side upload the source page used).
      await uploadPhotoMut.mutateAsync({ id, file });
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  const onPhotoRemove = async () => {
    if (!id) return;
    setPhotoError(null);
    try {
      await updateMut.mutateAsync({ id, photoUrl: null });
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  return (
    <div className="space-y-4">
      {/* Header --------------------------------------------------------- */}
      <PageHeader back
        eyebrow="Product Model"
        title={model.model_code}
        description={model.name}
        actions={
          /* Category + ACTIVE/INACTIVE pills — the old .titleRow chrome,
             reseated in the header's always-rendered actions slot. (The
             decorative <Layers> glyph went away with the bespoke title row;
             PageHeader's eyebrow rail carries that job now.) */
          <div className="flex flex-wrap items-center gap-2">
            <span className={styles.catPill}>{model.category}</span>
            <span className={`${styles.statusPill} ${model.active ? styles.active : styles.inactive}`}>
              {model.active ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
        }
        primaryAction={
          /* Every control stays an inline Button/Link rather than
             `secondaryActions`: MenuItem has no `disabled`, and Save changes
             must keep its `disabled={updateMut.isPending}` guard — moving it
             to a MenuItem would silently drop the in-flight lock. */
          <div className="flex flex-wrap items-stretch gap-2">
            {embedded ? (
              <button type="button" className={BACK_LINK} onClick={onClose}>
                <X {...ICON} /> Close
              </button>
            ) : (
              <Link to="/scm/product-models" className={BACK_LINK}>
                <ArrowLeft {...ICON} /> Product Models
              </Link>
            )}
            <Button variant="secondary" icon={<Store {...ICON} />} onClick={() => setAssigning(true)}>
              Assign supplier
            </Button>
            <Button variant="secondary" onClick={onToggleActive}>
              {model.active ? 'Deactivate' : 'Activate'}
            </Button>
            <Button variant="danger" icon={<Trash2 {...ICON} />} onClick={onDelete}>
              Delete
            </Button>
            <Button variant="primary" icon={<Save {...ICON} />} onClick={onSave} disabled={updateMut.isPending}>
              {updateMut.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        }
      />

      {/* Scoped, not bare. This dialog opens OVER a live edit form, so a failed
          chunk here used to bubble past every boundary in between to main.tsx's
          unkeyed top-level one and take the form down with it. Keyed on the
          model so closing/reopening or moving model clears it. */}
      {assigning && id && (
        <LazySlot resetKey={`assign-supplier:${id}`} fallback={null}>
          <AssignSupplierDialog
            modelIds={[id]}
            onClose={() => setAssigning(false)}
            onSaved={() => setAssigning(false)}
          />
        </LazySlot>
      )}

      {updateMut.isError && (
        <div className={BANNER_ERR}>
          Save failed: {updateMut.error instanceof Error ? updateMut.error.message : 'unknown'}
        </div>
      )}

      {/* Info card ------------------------------------------------------ */}
      <section className={CARD}>
        <h2 className={styles.cardTitle}>Model info</h2>
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className="t-eyebrow">Model code</span>
            {/* Commander 2026-05-27: "为什么不能 edit model code". Wired to
                modelCode state. SKU rows under this Model reference it by
                UUID (product_models.id), so renaming is safe — only the
                display label changes. Unique constraint on (model_code,
                category) prevents accidental clashes. */}
            <input
              type="text"
              value={modelCode}
              onChange={(e) => setModelCode(e.target.value)}
              placeholder="e.g. SF 5530 / 1005 / Lotti"
            />
          </label>
          <label className={styles.field}>
            <span className="t-eyebrow">Category</span>
            <input type="text" value={model.category} readOnly className={styles.readonly} />
          </label>
          <label className={styles.field}>
            <span className="t-eyebrow">Branding (optional)</span>
            <datalist id="branding-pool-model-detail">
              {sortByText(brandingPool.pool).map((b) => <option key={b} value={b} />)}
            </datalist>
            <input
              type="text"
              list="branding-pool-model-detail"
              value={branding}
              onChange={(e) => setBranding(e.target.value)}
              placeholder={
                model.category === 'SOFA' ? 'e.g. HOUZS'
                : model.category === 'BEDFRAME' ? 'usually encoded in Name; leave blank'
                : model.category === 'MATTRESS' ? 'e.g. 2990S / SEALY'
                : '—'
              }
            />
          </label>
          <label className={styles.field}>
            <span className="t-eyebrow">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                model.category === 'SOFA' ? 'e.g. SOFA 5530'
                : model.category === 'BEDFRAME' ? 'e.g. HILTON BEDFRAME'
                : 'e.g. SEALY MATTRESS'
              }
            />
          </label>
          <label className={`${styles.field} ${styles.fieldSpan2}`}>
            <span className="t-eyebrow">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional notes shown on quotations / catalogue printouts"
            />
          </label>
        </div>
      </section>

      {/* Photo card (PR #97) ------------------------------------------- */}
      <section className={CARD}>
        <div className={styles.photoRow}>
          {model.photo_url ? (
            <div className={styles.photoPreview}>
              <img src={resolveModelPhotoUrl(model.photo_url)} alt={`${model.model_code} photo`} />
              {photoUploading && <div className={styles.photoUploading}>Uploading…</div>}
            </div>
          ) : (
            <button
              type="button"
              className={styles.photoEmpty}
              onClick={() => photoInputRef.current?.click()}
              disabled={photoUploading}
            >
              <ImagePlus size={32} strokeWidth={1.5} />
              <span>{photoUploading ? 'Uploading…' : 'Click to upload photo'}</span>
            </button>
          )}
          <div className={styles.photoSide}>
            <h2 className={styles.photoSideTitle}>Photo</h2>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className={styles.hiddenInput}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPhotoFile(f);
              }}
            />
            <div className={styles.photoActions}>
              <Button
                variant="secondary"
                type="button"
                icon={<ImagePlus {...ICON} />}
                onClick={() => photoInputRef.current?.click()}
                disabled={photoUploading}
              >
                {model.photo_url ? 'Replace photo' : 'Upload photo'}
              </Button>
              {model.photo_url && (
                <Button
                  variant="danger"
                  type="button"
                  icon={<Trash2 {...ICON} />}
                  onClick={onPhotoRemove}
                  disabled={photoUploading || updateMut.isPending}
                >
                  Remove
                </Button>
              )}
            </div>
            {photoError && <div className={BANNER_ERR_SM}>{photoError}</div>}
          </div>
        </div>
      </section>

      {/* Photo gallery (multi-photo) — wires to the EXPECTED gallery endpoint
          (POST/GET/DELETE/PATCH /product-models/:id/photos). Renders the
          "Not yet wired · Setup notes" state until BACKEND-CHECKLIST A1 lands.
          The legacy single photo above is unaffected. */}
      {id && (
        <section className={CARD} style={{ padding: 0 }}>
          <ProductModelPhotoGallery modelId={id} modelName={model.name} />
        </section>
      )}

      {/* Allowed options ------------------------------------------------ */}
      <section className={CARD}>
        <h2 className={styles.cardTitle}>Allowed options</h2>
        <p className={styles.cardSub}>
          Every variant from the global Maintenance pool starts ticked on. Toggle
          off the ones this Model doesn't sell — only ticked variants surface
          when you "Add codes" or when the SO/PO line picker offers a variant.
          Use "All / None" beside each row to bulk-flip.
        </p>

        {model.category === 'SOFA' && (
          <SofaAllowedOptions
            allowed={allowed}
            onChange={setAllowed}
            sofaCompartments={maintActiveValues(maintenance.data?.data?.sofaCompartments ?? FALLBACK_SOFA_COMPARTMENTS)}
            sofaSizes={maintActiveValues(maintenance.data?.data?.sofaSizes ?? ['24', '26', '28', '30', '32', '35'])}
            sofaLegHeights={(maintenance.data?.data?.sofaLegHeights ?? []).map((o) => o.value)}
            sofaSpecials={specialsByCategory.sofa}
            sofaFabrics={(fabricLibQ.data ?? []).filter((f) => f.active).map((f) => f.id)}
          />
        )}

        {model.category === 'BEDFRAME' && (
          <BedframeAllowedOptions
            allowed={allowed}
            onChange={setAllowed}
            sizes={maintActiveValues(maintenance.data?.data?.bedframeSizes ?? FALLBACK_BEDFRAME_SIZES)}
            divanHeights={(maintenance.data?.data?.divanHeights ?? []).map((o) => o.value)}
            totalHeights={(maintenance.data?.data?.totalHeights ?? []).map((o) => o.value)}
            gaps={maintActiveValues(maintenance.data?.data?.gaps)}
            legHeights={(maintenance.data?.data?.legHeights ?? []).map((o) => o.value)}
            specials={specialsByCategory.bedframe}
          />
        )}

        {model.category === 'MATTRESS' && (
          <MattressAllowedOptions
            allowed={allowed}
            onChange={setAllowed}
            sizes={maintActiveValues(maintenance.data?.data?.mattressSizes ?? FALLBACK_MATTRESS_SIZES)}
          />
        )}

        {/* PR #66 — Mattress-only thickness input. Feeds the (HxWx{thickness}CM)
            dimensions in the SKU name template. Stored on allowed_options. */}
        {model.category === 'MATTRESS' && (
          <div className={styles.optGroup}>
            <div className={styles.optHead}>
              <span className="t-eyebrow">Mattress thickness (cm)</span>
            </div>
            <input
              type="number"
              min={0}
              max={99}
              step={1}
              value={
                typeof (allowed as { mattress_thickness_cm?: number }).mattress_thickness_cm === 'number'
                  ? (allowed as { mattress_thickness_cm: number }).mattress_thickness_cm
                  : ''
              }
              onChange={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                const next: AllowedOptions = { ...allowed };
                if (v == null || Number.isNaN(v)) {
                  delete (next as { mattress_thickness_cm?: number }).mattress_thickness_cm;
                } else {
                  (next as { mattress_thickness_cm: number }).mattress_thickness_cm = v;
                }
                setAllowed(next);
              }}
              placeholder="e.g. 31 (for AKKA-FIRM)"
              /* Hex-pinned: --line-strong / --c-paper only resolved through
                 the removed .page cascade (:root has them as
                 rgba(34,31,32,.28) / #f4f6f3 — this input would have gained a
                 dark border on a grey fill). Now border + surface tokens. */
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-14)',
                padding: 'var(--space-2) var(--space-3)',
                border: '1px solid #d6d9d2',
                borderRadius: 'var(--radius-sm)',
                background: '#fff',
                color: '#11140f',
                width: '160px',
              }}
            />
          </div>
        )}

        {(model.category === 'ACCESSORY' || model.category === 'SERVICE') && (
          <p className={styles.cardSub}>
            No configurable options for {model.category.toLowerCase()} models —
            SKU rows track everything directly.
          </p>
        )}
      </section>

      {/* SKU variants list --------------------------------------------- */}
      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={styles.cardTitle}>SKU variants ({data.skus.length})</h2>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {/* PR #87 — Commander 2026-05-26: "正常 default 都是全开的，但也
                要有一个关掉的 button". Bulk-toggle every variant in this Model
                so a discontinued line can be parked off the SO/PO picker in
                one click without losing its row / history / pricing.
                Both stay inline <Button>s (not PageHeader secondaryActions):
                their `disabled` all-on/all-off guard has no MenuItem field. */}
            {data.skus.length > 0 && (
              <>
                <Button
                  variant="secondary"
                  icon={<Power {...ICON} />}
                  disabled={statusMut.isPending || data.skus.every((s) => s.status === 'ACTIVE')}
                  onClick={() => {
                    const inactive = data.skus.filter((s) => s.status !== 'ACTIVE');
                    if (inactive.length === 0) return;
                    inactive.forEach((s) => statusMut.mutate({ id: s.id, status: 'ACTIVE' }));
                  }}
                  title="Activate every SKU under this Model"
                >
                  All on
                </Button>
                <Button
                  variant="secondary"
                  icon={<PowerOff {...ICON} />}
                  disabled={statusMut.isPending || data.skus.every((s) => s.status !== 'ACTIVE')}
                  onClick={async () => {
                    const active = data.skus.filter((s) => s.status === 'ACTIVE');
                    if (active.length === 0) return;
                    if (!(await askConfirm({
                      title: `Deactivate all ${active.length} SKU(s) under ${model.model_code}?`,
                      body: 'They stop showing on SO/PO pickers until re-activated.',
                      confirmLabel: 'Deactivate all',
                    }))) return;
                    active.forEach((s) => statusMut.mutate({ id: s.id, status: 'INACTIVE' }));
                  }}
                  title="Deactivate every SKU under this Model"
                >
                  All off
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              icon={<Wand2 {...ICON} />}
              onClick={() => setAddCodesOpen(true)}
            >
              Add codes…
            </Button>
          </div>
        </div>
        <p className={styles.cardSub}>
          Each row is a separate SKU with its own code, stock, cost, and pricing.
          Open code once at the Model layer; "Generate variants" stamps out one
          SKU row per allowed-option combination so you don't open codes 20 times.
          Click an ACTIVE/INACTIVE pill to flip a single variant off the picker
          without deleting the row.
        </p>
        {data.skus.length === 0 ? (
          <p className={styles.cardSub}>
            No SKUs under this Model yet. Toggle some allowed options above, save,
            then click "Add codes…" to materialise the variants you want.
          </p>
        ) : (
          <table className={styles.skuTable}>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Size</th>
                <th>Status</th>
                <th>POS</th>
                {showCost && <th style={{ textAlign: 'right' }}>Cost</th>}
                <th style={{ textAlign: 'right' }}>Price 2</th>
              </tr>
            </thead>
            <tbody>
              {data.skus.map((sku) => (
                <tr key={sku.id}>
                  <td>
                    <code>{sku.code}</code>
                  </td>
                  <td>{sku.name}</td>
                  <td>{sku.size_label ?? sku.size_code ?? '—'}</td>
                  <td>
                    {/* PR #87 — Status pill is now a button. One click flips
                        ACTIVE↔INACTIVE via PATCH /mfg-products/:id. Disabled
                        while a bulk toggle is in flight to avoid racing the
                        per-row mutation against bulk fan-out. */}
                    <button
                      type="button"
                      className={`${styles.statusPill} ${sku.status === 'ACTIVE' ? styles.active : styles.inactive}`}
                      /* border hex-pinned — var(--line) resolved to #d6d9d2
                         only via the removed .page cascade (:root has it as
                         rgba(34,31,32,.12)). */
                      style={{ cursor: 'pointer', border: '1px solid #d6d9d2' }}
                      disabled={statusMut.isPending}
                      onClick={() => statusMut.mutate({
                        id: sku.id,
                        status: sku.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                      })}
                      title={sku.status === 'ACTIVE'
                        ? 'Click to deactivate · removes from SO/PO picker'
                        : 'Click to activate · returns to SO/PO picker'}
                    >
                      {sku.status}
                    </button>
                  </td>
                  <td>
                    {/* One-shot SKUs start with pos_active=false and need an
                        explicit Activate to surface in the POS catalog. */}
                    {sku.one_shot ? (
                      sku.pos_active === false ? (
                        <button
                          type="button"
                          className={`${styles.statusPill} ${styles.inactive}`}
                          style={{ cursor: 'pointer', border: '1px solid #d6d9d2' }}
                          disabled={activateOneShotMut.isPending}
                          onClick={() => activateOneShotMut.mutate({ id: sku.id })}
                          title="Activate this one-shot SKU in POS"
                        >
                          Activate
                        </button>
                      ) : (
                        <span className={`${styles.statusPill} ${styles.active}`}>
                          Active in POS
                        </span>
                      )
                    ) : (
                      <span className={styles.statusPill}>—</span>
                    )}
                  </td>
                  {showCost && (
                    <td style={{ textAlign: 'right' }}>{formatRM(sku.cost_price_sen)}</td>
                  )}
                  <td style={{ textAlign: 'right' }}>{formatRM(sku.base_price_sen ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {/* + Add codes picker modal ------------------------------------- */}
      {addCodesOpen && id && (
        <AddCodesModal
          modelId={id}
          modelCode={model.model_code}
          modelName={model.name}
          branding={branding}
          category={model.category}
          allowed={allowed}
          mattressThicknessCm={
            typeof (allowed as { mattress_thickness_cm?: number }).mattress_thickness_cm === 'number'
              ? (allowed as { mattress_thickness_cm: number }).mattress_thickness_cm
              : null
          }
          formats={{
            bedframeCode: maintenance.data?.data?.bedframeCodeFormat,
            bedframeName: maintenance.data?.data?.bedframeNameFormat,
            sofaCode:     maintenance.data?.data?.sofaCodeFormat,
            sofaName:     maintenance.data?.data?.sofaNameFormat,
            mattressCode: maintenance.data?.data?.mattressCodeFormat,
            mattressName: maintenance.data?.data?.mattressNameFormat,
          }}
          sizeLabels={maintenance.data?.data?.sizeLabels}
          existingCodes={data.skus.map((s) => s.code)}
          onClose={() => setAddCodesOpen(false)}
        />
      )}
    </div>
  );
};

/* ────────────────────────── + Add codes picker modal ───────────────────────
   Lists every combination that comes out of the Model's allowed_options as
   a checkbox row. Codes that already exist on mfg_products are pre-disabled
   so commander can see what's there and can't double-insert.
   ────────────────────────────────────────────────────────────────────────── */

// SIZE_INFO now lives in ../lib/size-info (imported at top of file) so the
// New Model dialog + Maintenance pool list can read from the same source of
// truth. The api copy in apps/api/src/routes/product-models.ts §SIZE_INFO
// still has to be kept manually in sync (different runtime / package).

/** Candidate row carries the same fields the API's `rows` payload accepts so
    the modal can send them straight through without re-deriving server-side. */
type Candidate = { code: string; name: string; size_code: string | null; size_label: string | null };

/** PR #72 — per-category code/name format. Client substitutes placeholders
    using the row's local values, server just INSERTs verbatim. */
type FormatTemplates = {
  bedframeCode?: string; bedframeName?: string;
  sofaCode?:     string; sofaName?:     string;
  mattressCode?: string; mattressName?: string;
};

const DEFAULT_FORMATS = {
  bedframeCode: '{model_code}-({size})',
  // PR #100 — Commander 2026-05-26: match the mattress convention by
  // inserting {model_name} so generated descriptions read "TRION BEDFRAME
  // (6FT) (183X190CM)" instead of just "BEDFRAME (6FT) (…)". applyFormat
  // collapses empty {} pairs so a missing branding or model_name still
  // produces a clean string. Mirrors apps/api/src/routes/product-models.ts
  // §BEDFRAME.
  bedframeName: '{branding} {model_name} BEDFRAME ({size_label}) ({dimensions})',
  sofaCode:     '{model_code}-{compartment}',
  // PR #81 — Match commander's legacy sample "SOFA 5530 1A(LHF)". The old
  // template ('{model_name} {compartment}') worked only when commander
  // typed "SOFA 5530" into model.name; for new Models like "ADDA" it
  // produced "ADDA 1A(LHF)" (no "SOFA" word). Now inserts "SOFA" literal
  // + optional branding prefix. Mirrors API §SOFA branch.
  sofaName:     '{branding} SOFA {model_name} {compartment}',
  // PR #88 — Drop the "-NF" suffix per Commander ("NF 不需要"). Was
  // '{branding_nf}{model_code} MATT ({size})' producing "HAPPI.S-NF
  // PUREZONE MATT (K)"; now just prepends "{branding} " for a plain
  // "HAPPI.S PUREZONE MATT (K)". applyFormat trims the leading space
  // when branding is blank so the empty-branding case still produces
  // a clean "{model_code} MATT (size)".
  mattressCode: '{branding} {model_code} MATT ({size})',
  // PR #81 — Match 2990 sample. Was '{model_name} ({width}x...)' which
  // produced "GridCool (183x190x25CM)"; now produces
  // "Happi.S GridCool MATTRESS (183x190x25CM)". applyFormat() handles the
  // missing-branding case (empty string + trim() collapses the leading
  // space). Mirrors apps/api/src/routes/product-models.ts §MATTRESS.
  mattressName: '{branding} {model_name} MATTRESS ({width}x{length}x{thickness}CM)',
} as const;

function applyFormat(tpl: string, vars: Record<string, string>): string {
  // PR #85 — Commander 2026-05-26: all generated SKU code + name are
  // uppercased (server mirrors this in routes/product-models.ts
  // §generate-skus). Uppercasing here keeps the "+ Add Codes" picker
  // preview honest — what you see is exactly what the server will write.
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? '').trim().toUpperCase();
}

function computeCandidates(
  category: string,
  modelCode: string,
  modelName: string,
  branding: string,
  allowed: AOpts,
  mattressThicknessCm: number | null,
  fmt: FormatTemplates,
  /** PR #92 — Maintenance overrides (sizeLabels map). Threaded in so the
      Add codes preview reflects commander's relabel ("K → Super K") instead
      of staying stuck on the static SIZE_INFO. */
  cfg?: { sizeLabels?: Record<string, { label?: string; dimensions?: string } | undefined> } | null,
): Candidate[] {
  if (category === 'SOFA') {
    const codeFmt = fmt.sofaCode?.trim() || DEFAULT_FORMATS.sofaCode;
    const nameFmt = fmt.sofaName?.trim() || DEFAULT_FORMATS.sofaName;
    return (allowed.compartments ?? []).map((comp) => {
      const vars = { branding, model_code: modelCode, model_name: modelName, compartment: comp };
      return {
        code:       applyFormat(codeFmt, vars),
        name:       applyFormat(nameFmt, vars),
        size_code:  null,
        size_label: null,
      };
    });
  }
  if (category === 'BEDFRAME') {
    const codeFmt = fmt.bedframeCode?.trim() || DEFAULT_FORMATS.bedframeCode;
    const nameFmt = fmt.bedframeName?.trim() || DEFAULT_FORMATS.bedframeName;
    return (allowed.sizes ?? []).map((sz) => {
      const info  = resolveSizeInfo(sz, cfg);
      const label = info.label;
      const dim   = info.dim;
      const vars = {
        branding, model_code: modelCode, model_name: modelName,
        size: sz, size_label: label, dimensions: dim,
      };
      return {
        code:       applyFormat(codeFmt, vars),
        name:       applyFormat(nameFmt, vars).replace(/\s*\(\)\s*/g, ' ').trim(),
        size_code:  sz,
        size_label: label,
      };
    });
  }
  if (category === 'MATTRESS') {
    const codeFmt = fmt.mattressCode?.trim() || DEFAULT_FORMATS.mattressCode;
    const nameFmt = fmt.mattressName?.trim() || DEFAULT_FORMATS.mattressName;
    // PR #86 — `branding_nf` is the derived "{branding}-NF " (or "") used by
    // the mattress code template. Built here so the template stays a plain
    // string substitution and the empty-branding case doesn't leave a
    // dangling "-NF " in the output.
    const brandingNf = branding.trim() ? `${branding.trim()}-NF ` : '';
    return (allowed.sizes ?? []).map((sz) => {
      const info  = resolveSizeInfo(sz, cfg);
      const label = info.label;
      const vars: Record<string, string> = {
        branding, model_code: modelCode, model_name: modelName,
        branding_nf: brandingNf,
        size: sz, size_label: label,
        width:     info.w ? String(info.w) : '',
        length:    info.l ? String(info.l) : '',
        thickness: mattressThicknessCm != null ? String(mattressThicknessCm) : '',
      };
      return {
        code:       applyFormat(codeFmt, vars),
        name:       applyFormat(nameFmt, vars).replace(/\s*\(\)\s*/g, ' ').trim(),
        size_code:  sz,
        size_label: label,
      };
    });
  }
  return [];
}

function AddCodesModal({
  modelId, modelCode, modelName, branding, category, allowed, mattressThicknessCm, formats, sizeLabels, existingCodes, onClose,
}: {
  modelId: string;
  modelCode: string;
  modelName: string;
  branding: string;
  category: string;
  allowed: AOpts;
  mattressThicknessCm: number | null;
  formats: FormatTemplates;
  /** PR #92 — Maintenance sizeLabels override threaded in so the candidate
      preview reflects commander's relabel before generating SKUs. */
  sizeLabels?: Record<string, { label?: string; dimensions?: string } | undefined>;
  existingCodes: string[];
  onClose: () => void;
}) {
  const generateMut = useGenerateModelSkus();
  const notify = useNotify();
  const existingSet = useMemo(() => new Set(existingCodes), [existingCodes]);
  const candidates = useMemo(
    () => computeCandidates(category, modelCode, modelName, branding, allowed, mattressThicknessCm, formats, { sizeLabels }),
    [category, modelCode, modelName, branding, allowed, mattressThicknessCm, formats, sizeLabels],
  );
  // Default: tick every NEW code (existing ones can't be ticked anyway).
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.filter((c) => !existingSet.has(c.code)).map((c) => c.code)),
  );

  const togglePick = (code: string) => {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  };

  const newCount = candidates.filter((c) => !existingSet.has(c.code)).length;
  const existingCount = candidates.length - newCount;

  const submit = () => {
    if (picked.size === 0) {
      notify({ title: 'Pick at least one code to add.', tone: 'error' });
      return;
    }
    // PR #69 — send the FULL rows the modal computed locally so the API
    // doesn't need the saved allowed_options. Commander used to hit
    // `no_sizes` when she ticked sizes but didn't click Save Changes
    // before clicking Add codes.
    const rows = candidates
      .filter((c) => picked.has(c.code) && !existingSet.has(c.code))
      .map((c) => ({
        code:       c.code,
        name:       c.name,
        size_code:  c.size_code,
        size_label: c.size_label,
      }));
    generateMut.mutate(
      { id: modelId, rows },
      {
        onSuccess: async (res) => {
          await notify({
            title: `Added ${res.generated} code${res.generated === 1 ? '' : 's'}.`,
            body: res.skipped > 0 ? `Skipped ${res.skipped} (already existed).` : undefined,
          });
          onClose();
        },
        onError: (err) => {
          notify({ title: 'Add failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
        },
      },
    );
  };

  return (
    /* Modal chrome is Tailwind token markup now (was .modalBackdrop /
       .modal / .modalHead / .modalTitle / .modalClose) — same recipe as the
       Inventory drawer header. The list rows below stay in the module.css
       as repeated content primitives. */
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-[min(640px,100%)] flex-col gap-3 rounded-lg border border-border bg-surface p-5 shadow-slab"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-display text-[18px] font-extrabold leading-tight tracking-tight text-ink">
            Add codes to {modelCode}
          </h2>
          <button
            type="button"
            className="rounded p-1 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
            aria-label="Close"
          >
            <X {...ICON} />
          </button>
        </header>
        <p className={styles.modalSub}>
          Tick which variants to materialise. Existing codes are greyed out — they
          stay as-is. Each new code becomes a separate SKU row with its own stock,
          cost, and pricing.
        </p>

        {candidates.length === 0 ? (
          <div className={styles.modalEmpty}>
            No allowed options set yet. Toggle some Compartments / Sizes above,
            click Save changes, then come back here.
          </div>
        ) : (
          <div className={styles.modalList}>
            {candidates.map((cand) => {
              const exists = existingSet.has(cand.code);
              const ticked = picked.has(cand.code);
              return (
                <label
                  key={cand.code}
                  className={`${styles.modalRow} ${exists ? styles.modalRowExisting : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={exists || ticked}
                    disabled={exists}
                    onChange={() => togglePick(cand.code)}
                  />
                  <code className={styles.modalCode}>{cand.code}</code>
                  <span className={styles.modalName}>{cand.name}</span>
                  {exists && <span className={styles.modalExistsPill}>EXISTS</span>}
                </label>
              );
            })}
          </div>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-border pt-2">
          <span className={styles.modalCount}>
            {existingCount} existing · {newCount} new · {picked.size} ticked
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={generateMut.isPending || picked.size === 0}
            >
              {generateMut.isPending ? 'Adding…' : `Add ${picked.size} code${picked.size === 1 ? '' : 's'}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ────────────────────────── Per-category allowed-option panels ────── */

function ChipToggle({
  options, selected, onChange,
}: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const has = (v: string) => selected.includes(v);
  const toggle = (v: string) => {
    onChange(has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  return (
    <div className={styles.chipRow}>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`${styles.chip} ${has(opt) ? styles.chipOn : ''}`}
          onClick={() => toggle(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/** PR #87 — Bulk-toggle pair injected into each OptionGroup header. Commander
    wants every chip group to default to all-on and offer one-click All / None
    so a Model with 20 sizes doesn't need 20 individual taps to set up. */
function BulkChipToggle({
  options, selected, onChange,
}: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  if (options.length === 0) return null;
  return (
    <span className={styles.optBulk}>
      <button
        type="button"
        className={styles.optBulkBtn}
        onClick={() => onChange([...options])}
        disabled={selected.length === options.length}
        title="Tick every option"
      >
        All
      </button>
      <button
        type="button"
        className={styles.optBulkBtn}
        onClick={() => onChange([])}
        disabled={selected.length === 0}
        title="Untick every option"
      >
        None
      </button>
    </span>
  );
}

function SofaAllowedOptions({
  allowed, onChange, sofaCompartments, sofaSizes, sofaLegHeights, sofaSpecials, sofaFabrics,
}: {
  allowed: AllowedOptions; onChange: (next: AllowedOptions) => void;
  sofaCompartments: string[]; sofaSizes: string[];
  sofaLegHeights: string[]; sofaSpecials: string[];
  /** Active fabric_library.id slugs available to tick for this sofa Model. */
  sofaFabrics: string[];
}) {
  return (
    <>
      <OptionGroup
        label="Compartments"
        hint="Which seat/corner shapes this Model offers · pool managed in Maintenance"
        bulk={(
          <BulkChipToggle
            options={sofaCompartments}
            selected={allowed.compartments ?? []}
            onChange={(next) => onChange({ ...allowed, compartments: next })}
          />
        )}
      >
        <ChipToggle
          options={sofaCompartments}
          selected={allowed.compartments ?? []}
          onChange={(next) => onChange({ ...allowed, compartments: next })}
        />
      </OptionGroup>
      <OptionGroup
        label="Seat sizes (inches)"
        hint="Depth-of-seat variants this Model is built in"
        bulk={(
          <BulkChipToggle
            options={sofaSizes}
            selected={allowed.sizes ?? []}
            onChange={(next) => onChange({ ...allowed, sizes: next })}
          />
        )}
      >
        <ChipToggle
          options={sofaSizes}
          selected={allowed.sizes ?? []}
          onChange={(next) => onChange({ ...allowed, sizes: next })}
        />
      </OptionGroup>
      {sofaLegHeights.length > 0 && (
        <OptionGroup
          label="Leg heights"
          hint="Subset of the global sofa leg pool"
          bulk={(
            <BulkChipToggle
              options={sofaLegHeights}
              selected={allowed.leg_heights ?? []}
              onChange={(next) => onChange({ ...allowed, leg_heights: next })}
            />
          )}
        >
          <ChipToggle
            options={sofaLegHeights}
            selected={allowed.leg_heights ?? []}
            onChange={(next) => onChange({ ...allowed, leg_heights: next })}
          />
        </OptionGroup>
      )}
      {sofaSpecials.length > 0 && (
        <OptionGroup
          label="Specials"
          hint="Recliner / storage upgrades this Model supports"
          bulk={(
            <BulkChipToggle
              options={sofaSpecials}
              selected={allowed.specials ?? []}
              onChange={(next) => onChange({ ...allowed, specials: next })}
            />
          )}
        >
          <ChipToggle
            options={sofaSpecials}
            selected={allowed.specials ?? []}
            onChange={(next) => onChange({ ...allowed, specials: next })}
          />
        </OptionGroup>
      )}
      {sofaFabrics.length > 0 && (
        <OptionGroup
          label="Fabrics (colours)"
          hint="Which fabric options surface in the POS colour picker for this Model · pool managed in Fabric Library"
          bulk={(
            <BulkChipToggle
              options={sofaFabrics}
              selected={allowed.fabrics ?? []}
              onChange={(next) => onChange({ ...allowed, fabrics: next })}
            />
          )}
        >
          <ChipToggle
            options={sofaFabrics}
            selected={allowed.fabrics ?? []}
            onChange={(next) => onChange({ ...allowed, fabrics: next })}
          />
        </OptionGroup>
      )}
    </>
  );
}

function BedframeAllowedOptions({
  allowed, onChange, sizes, divanHeights, totalHeights, gaps, legHeights, specials,
}: {
  allowed: AllowedOptions; onChange: (next: AllowedOptions) => void;
  sizes: string[]; divanHeights: string[]; totalHeights: string[]; gaps: string[];
  legHeights: string[]; specials: string[];
}) {
  return (
    <>
      <OptionGroup
        label="Sizes"
        hint="Bed sizes this Model is offered in · pool managed in Maintenance"
        bulk={(
          <BulkChipToggle
            options={sizes}
            selected={allowed.sizes ?? []}
            onChange={(next) => onChange({ ...allowed, sizes: next })}
          />
        )}
      >
        <ChipToggle
          options={sizes}
          selected={allowed.sizes ?? []}
          onChange={(next) => onChange({ ...allowed, sizes: next })}
        />
      </OptionGroup>
      {divanHeights.length > 0 && (
        <OptionGroup
          label="Divan heights"
          bulk={(
            <BulkChipToggle
              options={divanHeights}
              selected={allowed.divan_heights ?? []}
              onChange={(next) => onChange({ ...allowed, divan_heights: next })}
            />
          )}
        >
          <ChipToggle
            options={divanHeights}
            selected={allowed.divan_heights ?? []}
            onChange={(next) => onChange({ ...allowed, divan_heights: next })}
          />
        </OptionGroup>
      )}
      {totalHeights.length > 0 && (
        <OptionGroup
          label="Total heights"
          bulk={(
            <BulkChipToggle
              options={totalHeights}
              selected={allowed.total_heights ?? []}
              onChange={(next) => onChange({ ...allowed, total_heights: next })}
            />
          )}
        >
          <ChipToggle
            options={totalHeights}
            selected={allowed.total_heights ?? []}
            onChange={(next) => onChange({ ...allowed, total_heights: next })}
          />
        </OptionGroup>
      )}
      {gaps.length > 0 && (
        <OptionGroup
          label="Gaps"
          bulk={(
            <BulkChipToggle
              options={gaps}
              selected={allowed.gaps ?? []}
              onChange={(next) => onChange({ ...allowed, gaps: next })}
            />
          )}
        >
          <ChipToggle
            options={gaps}
            selected={allowed.gaps ?? []}
            onChange={(next) => onChange({ ...allowed, gaps: next })}
          />
        </OptionGroup>
      )}
      {legHeights.length > 0 && (
        <OptionGroup
          label="Leg heights"
          bulk={(
            <BulkChipToggle
              options={legHeights}
              selected={allowed.leg_heights ?? []}
              onChange={(next) => onChange({ ...allowed, leg_heights: next })}
            />
          )}
        >
          <ChipToggle
            options={legHeights}
            selected={allowed.leg_heights ?? []}
            onChange={(next) => onChange({ ...allowed, leg_heights: next })}
          />
        </OptionGroup>
      )}
      {specials.length > 0 && (
        <OptionGroup
          label="Specials"
          bulk={(
            <BulkChipToggle
              options={specials}
              selected={allowed.specials ?? []}
              onChange={(next) => onChange({ ...allowed, specials: next })}
            />
          )}
        >
          <ChipToggle
            options={specials}
            selected={allowed.specials ?? []}
            onChange={(next) => onChange({ ...allowed, specials: next })}
          />
        </OptionGroup>
      )}
    </>
  );
}

function MattressAllowedOptions({
  allowed, onChange, sizes,
}: { allowed: AllowedOptions; onChange: (next: AllowedOptions) => void; sizes: string[] }) {
  return (
    <OptionGroup
      label="Sizes"
      hint="Mattress sizes this Model is sold in · pool managed in Maintenance"
      bulk={(
        <BulkChipToggle
          options={sizes}
          selected={allowed.sizes ?? []}
          onChange={(next) => onChange({ ...allowed, sizes: next })}
        />
      )}
    >
      <ChipToggle
        options={sizes}
        selected={allowed.sizes ?? []}
        onChange={(next) => onChange({ ...allowed, sizes: next })}
      />
    </OptionGroup>
  );
}

function OptionGroup({
  label, hint, children, bulk,
}: {
  label:    string;
  hint?:    string;
  children: React.ReactNode;
  /** PR #87 — Optional bulk-toggle slot rendered at the right edge of the
      header row. Each chip-group panel passes a <BulkChipToggle> here so
      All / None sit inline with the eyebrow label. */
  bulk?:    React.ReactNode;
}) {
  return (
    <div className={styles.optGroup}>
      <div className={styles.optHead}>
        <span className="t-eyebrow">{label}</span>
        {hint && <span className={styles.optHint}>{hint}</span>}
        {bulk}
      </div>
      {children}
    </div>
  );
}

function formatRM(sen: number | null | undefined): string {
  if (sen == null) return '—';
  const ringgit = sen / 100;
  return `RM ${ringgit.toFixed(2)}`;
}
