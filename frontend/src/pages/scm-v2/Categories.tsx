// ----------------------------------------------------------------------------
// Categories — catalogue-category management at /scm/categories.
//
// Reads + writes scm.categories via the publicCategoriesApi (backend
// scm/routes/categories.ts). The grid is now editable:
//   · Click the card image → hero editor (existing HeroImageEditor drawer).
//   · Click the kebab on the card → Edit / Delete / Move up / Move down.
//   · "+ New category" in the toolbar → create form drawer.
//
// Delete is gated server-side on product_models.category referencing this id;
// the 409 response carries a count + sample model codes so we can offer a
// "Go to Products" jump that pre-filters by category so the operator can
// re-categorise before retrying the delete.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
// Static named imports — every icon the Categories page might render is listed
// here so Rollup can tree-shake the rest of lucide-react out of the bundle.
// The earlier `import * as Lucide from "lucide-react"` (and the subsequent
// `lucide-react/dynamicIconImports` map) both forced every icon module to be
// reachable from this chunk, ballooning the lucide chunk to ~780–920 KB raw.
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FolderTree,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X,
  // ── Picker icons (kebab → PascalCase). Adding a new pick here means
  // adding it to POPULAR_ICONS below AND to ICON_MAP. Names outside this
  // map fall back to the Package icon at render time.
  Armchair,
  Baby,
  Bath,
  Bed,
  BedDouble,
  BedSingle,
  Blocks,
  Coffee,
  CookingPot,
  Lamp,
  LampCeiling,
  LampDesk,
  LampFloor,
  LampWallDown,
  Microwave,
  Monitor,
  Package,
  Package2,
  Refrigerator,
  School,
  Shapes,
  ShoppingBag,
  ShowerHead,
  Sofa,
  Speaker,
  Store,
  Tag,
  Toilet,
  Tv,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../components/Button";
import { HeroImageEditor } from "../../components/scm-v2/HeroImageEditor";
import { classifyLoadError, errMsg } from "../../components/scm-v2/PhotoGallery";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { writeFailedAs } from "../../vendor/scm/lib/mutation-error";
import { cn } from "../../lib/utils";

// ── Types ───────────────────────────────────────────────────────────────────

type CategoryRow = {
  id: string;
  name: string;
  slug?: string | null;
  hero_image_key?: string | null;
  hero_url?: string | null;
};

// The wire shape returned by POST/PATCH (label + icon, not the read-side
// "name + slug" alias).
type CategoryWire = {
  id: string;
  label: string;
  icon: string;
  sort_order: number;
  hero_image_key: string | null;
};

// Curated picks — lucide names that show up first in the icon picker. They
// cover ~95% of real-world catalogue categories so the operator usually
// doesn't need to drop into free-text. Free text below stays as the escape.
// Each entry MUST also exist in ICON_MAP below; names outside the map render
// as the Package fallback. (`sink` was previously listed but is not exported
// by lucide-react 0.460, so the picker silently dropped it — omitted here.)
const POPULAR_ICONS = [
  "sofa", "armchair", "bed", "bed-double", "bed-single",
  "lamp", "lamp-ceiling", "lamp-desk", "lamp-floor", "lamp-wall-down",
  "utensils", "coffee", "cooking-pot", "refrigerator", "microwave",
  "bath", "shower-head", "toilet",
  "baby", "shapes", "school", "blocks",
  "package", "package-2", "shopping-bag", "tag", "store",
  "tv", "speaker", "monitor",
];

const ICON_MAP: Record<string, LucideIcon> = {
  armchair: Armchair,
  baby: Baby,
  bath: Bath,
  bed: Bed,
  "bed-double": BedDouble,
  "bed-single": BedSingle,
  blocks: Blocks,
  coffee: Coffee,
  "cooking-pot": CookingPot,
  lamp: Lamp,
  "lamp-ceiling": LampCeiling,
  "lamp-desk": LampDesk,
  "lamp-floor": LampFloor,
  "lamp-wall-down": LampWallDown,
  microwave: Microwave,
  monitor: Monitor,
  package: Package,
  "package-2": Package2,
  refrigerator: Refrigerator,
  school: School,
  shapes: Shapes,
  "shopping-bag": ShoppingBag,
  "shower-head": ShowerHead,
  sofa: Sofa,
  speaker: Speaker,
  store: Store,
  tag: Tag,
  toilet: Toilet,
  tv: Tv,
  utensils: Utensils,
};

// Free-text icon names that aren't in the map fall back to the Package icon
// so the data round-trips fine (the picker's text input + popular grid still
// works); only the rendered glyph downgrades for unknown names.
function resolveIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Package;
  return ICON_MAP[name] ?? Package;
}

// ── Mutations ───────────────────────────────────────────────────────────────

const useCreateCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    // silent-mutation-ok: its only consumer, CategoryForm.onSubmit, awaits
    // createMut.mutateAsync inside try/catch and puts errMsg(e) into formError,
    // which renders as the red panel above the Create button.
    mutationFn: (body: { id: string; label: string; icon: string; sort_order?: number }) =>
      authedFetch<{ category: CategoryWire }>("/categories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scm-categories"] }),
  });
};

const useUpdateCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    // silent-mutation-ok: TWO consumers, both surface the refusal.
    // CategoryForm.onSubmit awaits updateMut.mutateAsync in try/catch → formError
    // panel; Categories.move() (Move up / Move down) passes a per-call onError on
    // each .mutate — without it a refused reorder just left the card where it was,
    // which is the "the button does nothing" shape this checker exists for.
    mutationFn: ({ id, ...patch }: { id: string; label?: string; icon?: string; sort_order?: number }) =>
      authedFetch<{ category: CategoryWire }>(`/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scm-categories"] }),
  });
};

const useDeleteCategory = () => {
  const qc = useQueryClient();
  return useMutation({
    // silent-mutation-ok: its only consumer, DeleteConfirm.onConfirm, awaits
    // deleteMut.mutateAsync inside try/catch and always sets `inUse`, which
    // renders the red "Can't delete" panel — the modal stays open on a refusal
    // rather than closing as if it had worked.
    mutationFn: (id: string) =>
      authedFetch<{ ok: true }>(`/categories/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scm-categories"] }),
  });
};

// ── Component ───────────────────────────────────────────────────────────────

export function Categories() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // When Categories is mounted inside the Products page (as the
  // `?tab=categories` sub-tab, per PR #164) the "← Products" breadcrumb
  // navigates to `/scm/products` — dropping the `?tab=categories` query
  // and teleporting the user back to the SKU Master tab. Hide the
  // breadcrumb in that case; the outer Products tab strip already tells
  // them where they are.
  const embedded = location.pathname === "/scm/products";

  const catsQ = useQuery({
    queryKey: ["scm-categories"],
    queryFn: () =>
      authedFetch<{ categories: CategoryRow[] }>(`/categories`).then((r) =>
        r.categories.slice().sort((a, b) => a.name.localeCompare(b.name)),
      ),
    retry: false,
    staleTime: 60_000,
  });
  const loadStatus = catsQ.error ? classifyLoadError(catsQ.error) : "ok";
  const cats = catsQ.data ?? [];

  // URL state · 3 modes: hero / meta / new. Only one drawer open at a time.
  const heroId = searchParams.get("edit-hero");
  const metaId = searchParams.get("edit-meta");
  const isNew = searchParams.get("new") === "1";
  const editingHero = heroId ? cats.find((c) => c.id === heroId) ?? null : null;
  const editingMeta = metaId ? cats.find((c) => c.id === metaId) ?? null : null;

  const openHero = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("edit-hero", id);
    sp.delete("edit-meta");
    sp.delete("new");
    setSearchParams(sp, { replace: true });
  };
  const openMeta = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("edit-meta", id);
    sp.delete("edit-hero");
    sp.delete("new");
    setSearchParams(sp, { replace: true });
  };
  const openNew = () => {
    const sp = new URLSearchParams(searchParams);
    sp.set("new", "1");
    sp.delete("edit-hero");
    sp.delete("edit-meta");
    setSearchParams(sp, { replace: true });
  };
  const closeDrawer = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete("edit-hero");
    sp.delete("edit-meta");
    sp.delete("new");
    setSearchParams(sp, { replace: true });
  };

  // Esc closes whichever drawer is open
  useEffect(() => {
    if (!heroId && !metaId && !isNew) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroId, metaId, isNew]);

  // Reorder via arrows — adjust this row's sort_order to one slot above or
  // below its neighbour in display order.
  const updateMut = useUpdateCategory();
  const sortedByOrder = useMemo(
    () =>
      cats
        .slice()
        .sort((a, b) => {
          // Surface the API's sort_order field (we read it via the same
          // /categories list); fall back to name for stability.
          const ao = (a as unknown as { sort_order?: number }).sort_order ?? 0;
          const bo = (b as unknown as { sort_order?: number }).sort_order ?? 0;
          if (ao !== bo) return ao - bo;
          return a.name.localeCompare(b.name);
        }),
    [cats],
  );
  const move = (id: string, dir: -1 | 1) => {
    const idx = sortedByOrder.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const swap = sortedByOrder[idx + dir];
    if (!swap) return;
    const curOrder =
      (sortedByOrder[idx] as unknown as { sort_order?: number }).sort_order ?? idx;
    const swapOrder =
      (swap as unknown as { sort_order?: number }).sort_order ?? idx + dir;
    // Swap the two orders so they trade places. Backend just stores them.
    // Fire-and-forget, so the refusal has to be raised here: nothing awaits
    // these and the grid re-renders from cache, so without onError a refused
    // PATCH left the card exactly where it was and said nothing.
    const onError = writeFailedAs("Category order not changed");
    updateMut.mutate({ id: swap.id, sort_order: curOrder }, { onError });
    updateMut.mutate({ id, sort_order: swapOrder }, { onError });
  };

  return (
    <div className="space-y-4 py-4 sm:py-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {!embedded && (
            <button
              type="button"
              onClick={() => navigate("/scm/products")}
              className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted hover:text-primary"
            >
              <ArrowLeft size={12} /> Products
            </button>
          )}
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
            <FolderTree size={11} /> SCM · Catalogue · Categories
          </div>
          <h1 className="mt-1 font-display text-[21px] font-extrabold tracking-tight text-ink">
            Categories
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Catalogue categories. Each one carries a cover image (hero) and a
            sort position. Click the card image to set the cover; use the
            menu for edit / delete / reorder.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={openNew}>
          New category
        </Button>
      </div>

      {/* Loading */}
      {catsQ.isLoading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-48 rounded-xl" />
          ))}
        </div>
      )}

      {/* Not configured / error */}
      {loadStatus === "not-configured" && !catsQ.isLoading && (
        <div className="rounded-lg border border-border bg-surface-2 px-5 py-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
            <FolderTree size={20} />
          </div>
          <div className="mt-3 text-[14px] font-bold text-ink">
            Categories endpoint not yet live
          </div>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[12px] leading-relaxed text-ink-muted">
            The categories list endpoint isn't registered yet. Track at{" "}
            <span className="font-money">BACKEND-CHECKLIST · A2</span>.
          </p>
          <div className="mt-4">
            <Button
              variant="secondary"
              icon={<RotateCw size={14} />}
              onClick={() => catsQ.refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      {loadStatus === "error" && !catsQ.isLoading && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't load categories: {errMsg(catsQ.error)}
        </div>
      )}

      {/* Empty */}
      {loadStatus === "ok" && !catsQ.isLoading && cats.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-surface-2 px-4 py-12 text-center text-[12px] text-ink-muted">
          No categories yet. Click <span className="font-semibold text-ink">+ New category</span> to add one.
        </div>
      )}

      {/* Grid */}
      {loadStatus === "ok" && sortedByOrder.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortedByOrder.map((c, idx) => (
            <CategoryCard
              key={c.id}
              cat={c}
              isFirst={idx === 0}
              isLast={idx === sortedByOrder.length - 1}
              onOpenHero={() => openHero(c.id)}
              onOpenMeta={() => openMeta(c.id)}
              onMoveUp={() => move(c.id, -1)}
              onMoveDown={() => move(c.id, +1)}
            />
          ))}
        </div>
      )}

      {/* Drawers */}
      {editingHero && (
        <Drawer onClose={closeDrawer} title={`Edit hero · ${editingHero.name}`}>
          <HeroImageEditor
            categoryId={editingHero.id}
            categoryName={editingHero.name}
            onClose={closeDrawer}
          />
        </Drawer>
      )}
      {editingMeta && (
        <Drawer onClose={closeDrawer} title={`Edit category · ${editingMeta.name}`}>
          <CategoryForm
            mode="edit"
            initial={editingMeta}
            onClose={closeDrawer}
          />
        </Drawer>
      )}
      {isNew && (
        <Drawer onClose={closeDrawer} title="New category">
          <CategoryForm mode="create" onClose={closeDrawer} />
        </Drawer>
      )}
    </div>
  );
}

// ── Card with kebab menu ────────────────────────────────────────────────────

function CategoryCard({
  cat,
  isFirst,
  isLast,
  onOpenHero,
  onOpenMeta,
  onMoveUp,
  onMoveDown,
}: {
  cat: CategoryRow;
  isFirst: boolean;
  isLast: boolean;
  onOpenHero: () => void;
  onOpenMeta: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const Icon = resolveIcon(cat.slug);
  return (
    <div
      className={cn(
        "group relative rounded-xl border border-border bg-surface shadow-stone transition-all hover:-translate-y-px hover:border-primary/40",
        // While the kebab dropdown is open, lift the card above its siblings.
        // The card uses `hover:-translate-y-px`, and `transform` creates a
        // stacking context that locks the absolutely-positioned dropdown
        // inside the card. Without an explicit z-index, DOM-later sibling
        // cards (next row in the grid) paint on top and clip the menu.
        menuOpen && "z-30",
      )}
    >
      {/* Image area — clickable, opens hero editor. overflow-hidden lives
          here (not on the card wrapper) so the kebab dropdown can extend
          below the card without being clipped. rounded-t-xl keeps the
          image's top corners flush with the card's rounded border. */}
      <button
        type="button"
        onClick={onOpenHero}
        className="relative block aspect-[16/7] w-full overflow-hidden rounded-t-xl bg-surface-2"
        style={{
          backgroundImage: cat.hero_url ? `url(${cat.hero_url})` : undefined,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
        aria-label={`Edit hero for ${cat.name}`}
      >
        {!cat.hero_url && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-muted">
            <ImageIcon size={28} className="opacity-60" />
          </div>
        )}
      </button>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={onOpenMeta}
          className="min-w-0 flex-1 text-left"
          aria-label={`Edit category metadata for ${cat.name}`}
        >
          <div className="flex items-center gap-2">
            <Icon size={14} className="shrink-0 text-ink-muted" />
            <span className="truncate font-display text-[14px] font-bold text-ink">
              {cat.name}
            </span>
          </div>
          {cat.slug && (
            <div className="mt-0.5 truncate font-money text-[10.5px] text-ink-muted">
              {cat.slug}
            </div>
          )}
        </button>

        {/* Kebab menu */}
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-dim hover:text-ink"
            aria-label="Open menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
                aria-hidden
              />
              <div
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface shadow-slab"
              >
                <MenuItem icon={<Pencil size={12} />} onClick={() => { setMenuOpen(false); onOpenMeta(); }}>
                  Edit metadata
                </MenuItem>
                <MenuItem
                  icon={<ArrowUp size={12} />}
                  onClick={() => { setMenuOpen(false); onMoveUp(); }}
                  disabled={isFirst}
                >
                  Move up
                </MenuItem>
                <MenuItem
                  icon={<ArrowDown size={12} />}
                  onClick={() => { setMenuOpen(false); onMoveDown(); }}
                  disabled={isLast}
                >
                  Move down
                </MenuItem>
                <div className="my-1 h-px bg-border-subtle" />
                <MenuItem
                  icon={<Trash2 size={12} />}
                  tone="danger"
                  onClick={() => { setMenuOpen(false); setDeleting(true); }}
                >
                  Delete…
                </MenuItem>
              </div>
            </>
          )}
        </div>
      </div>

      {deleting && (
        <DeleteConfirm cat={cat} onClose={() => setDeleting(false)} />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  disabled,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-semibold transition-colors",
        tone === "danger" ? "text-err hover:bg-err/10" : "text-ink-secondary hover:bg-primary-soft hover:text-primary-ink",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ── Category form (shared by new + edit) ────────────────────────────────────

function CategoryForm({
  mode,
  initial,
  onClose,
}: {
  mode: "create" | "edit";
  initial?: CategoryRow;
  onClose: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.slug ?? "package");
  const [formError, setFormError] = useState<string | null>(null);

  const createMut = useCreateCategory();
  const updateMut = useUpdateCategory();
  const submitting = createMut.isPending || updateMut.isPending;

  const idValid = mode === "edit" || /^[a-z0-9][a-z0-9-]{0,49}$/.test(id);
  const canSubmit = !submitting && idValid && label.trim().length > 0 && icon.trim().length > 0;

  const onSubmit = async () => {
    setFormError(null);
    try {
      if (mode === "create") {
        await createMut.mutateAsync({ id, label: label.trim(), icon: icon.trim() });
      } else if (initial) {
        await updateMut.mutateAsync({ id: initial.id, label: label.trim(), icon: icon.trim() });
      }
      onClose();
    } catch (e) {
      setFormError(errMsg(e));
    }
  };

  return (
    <div className="space-y-4">
      {/* ID (create only) */}
      {mode === "create" && (
        <Field
          label="ID / slug"
          hint="Stable URL-safe identifier — lowercase letters, digits, hyphens. e.g. 'living-room'. Can't be changed later."
          invalid={id.length > 0 && !idValid}
        >
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder="living-room"
            className={cn(
              "block w-full rounded-md border bg-surface px-3 py-2 font-money text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
              id.length > 0 && !idValid ? "border-err" : "border-border",
            )}
            maxLength={50}
          />
          {id.length > 0 && !idValid && (
            <div className="mt-1 text-[10.5px] font-semibold text-err">
              Use lowercase letters / digits / hyphens, must start with alnum.
            </div>
          )}
        </Field>
      )}

      <Field label="Label" hint="Shown on the catalogue card.">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Living room"
          className="block w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          maxLength={200}
        />
      </Field>

      <Field label="Icon" hint="Pick from the curated set below. Free-text is stored as-is but unknown names render the Package fallback.">
        <IconPicker value={icon} onChange={setIcon} />
      </Field>

      {formError && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>{formError}</div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={!canSubmit}
          icon={submitting ? <Loader2 size={14} className="animate-spin" /> : undefined}
        >
          {submitting ? "Saving…" : mode === "create" ? "Create category" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  invalid,
  children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      {hint && (
        <div className="mt-0.5 text-[10.5px] text-ink-muted">{hint}</div>
      )}
      <div className="mt-1.5">{children}</div>
      {invalid && null}
    </label>
  );
}

// ── Icon picker ─────────────────────────────────────────────────────────────

function IconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const CurrentIcon = resolveIcon(value);
  return (
    <div className="space-y-2">
      {/* Free-text input with current preview */}
      <div className="flex items-center gap-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-ink">
          <CurrentIcon size={20} />
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.trim().toLowerCase())}
          placeholder="sofa"
          className="block w-full rounded-md border border-border bg-surface px-3 py-2 font-money text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          spellCheck={false}
          maxLength={40}
        />
      </div>
      {/* Popular picks */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Popular
        </div>
        <div className="mt-1.5 grid grid-cols-6 gap-1.5 sm:grid-cols-8">
          {POPULAR_ICONS.map((name) => {
            const I = ICON_MAP[name];
            if (!I) return null;
            const isOn = value === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => onChange(name)}
                title={name}
                className={cn(
                  "flex h-9 items-center justify-center rounded-md border transition-colors",
                  isOn
                    ? "border-primary bg-primary-soft text-primary-ink"
                    : "border-border bg-surface text-ink-secondary hover:border-primary/40 hover:text-primary",
                )}
              >
                <I size={16} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Delete confirm ──────────────────────────────────────────────────────────

function DeleteConfirm({
  cat,
  onClose,
}: {
  cat: CategoryRow;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const deleteMut = useDeleteCategory();
  const [inUse, setInUse] = useState<{ count: number; sample: string[] } | null>(null);

  const onConfirm = async () => {
    setInUse(null);
    try {
      await deleteMut.mutateAsync(cat.id);
      onClose();
    } catch (e) {
      // 409 carries the "category_in_use" payload; surface it inline.
      const msg = errMsg(e);
      // Best-effort extract — server returns the count + sample_models inside
      // the error body. The vendored authedFetch stringifies error bodies; we
      // look for the marker phrase to detect the gated 409.
      if (/category_in_use/i.test(msg)) {
        // Pull count + a few model codes from the message blob.
        const countMatch = msg.match(/"count"\s*:\s*(\d+)/);
        const samplesMatch = msg.match(/"sample_models"\s*:\s*\[([^\]]*)\]/);
        const sample = samplesMatch
          ? samplesMatch[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
          : [];
        setInUse({ count: countMatch ? Number(countMatch[1]) : 0, sample });
        return;
      }
      // Fallback — generic error toast.
      setInUse({ count: 0, sample: [] });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface shadow-slab"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-3">
          <div className="font-display text-[14px] font-extrabold text-ink">
            Delete category · {cat.name}
          </div>
        </div>
        <div className="space-y-3 px-5 py-4">
          {!inUse ? (
            <>
              <p className="text-[12px] text-ink-secondary">
                This removes the category from the catalogue. If a hero image
                is set, the R2 blob is removed too. This can't be undone.
              </p>
              <p className="text-[11px] text-ink-muted">
                Product models that reference this category will block the
                delete with a 409 — you'll see how many + sample codes here so
                you can re-categorise first.
              </p>
            </>
          ) : (
            <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">
                    Can't delete — {inUse.count > 0
                      ? `${inUse.count} product model${inUse.count === 1 ? "" : "s"} still use this category.`
                      : "category is referenced by product models."}
                  </div>
                  {inUse.sample.length > 0 && (
                    <div className="mt-1 font-money text-[10.5px] text-ink-secondary">
                      {inUse.sample.join(" · ")}
                      {inUse.count > inUse.sample.length && ` … +${inUse.count - inUse.sample.length} more`}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => navigate(`/scm/product-models?category=${encodeURIComponent(cat.id)}`)}
                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-err/40 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/10"
                  >
                    Go to Products to re-categorise →
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">
          <Button variant="secondary" onClick={onClose}>
            {inUse ? "Close" : "Cancel"}
          </Button>
          {!inUse && (
            <Button
              variant="danger"
              onClick={onConfirm}
              disabled={deleteMut.isPending}
              icon={deleteMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            >
              {deleteMut.isPending ? "Deleting…" : "Delete"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────────

function Drawer({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-ink/40"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={cn(
          "ml-auto h-full w-full max-w-[640px] overflow-y-auto bg-surface shadow-slab",
          "animate-[rise_220ms_cubic-bezier(0.16,1,0.3,1)_both]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-surface px-5 py-3">
          <div className="font-display text-[14px] font-extrabold text-ink">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-muted hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
