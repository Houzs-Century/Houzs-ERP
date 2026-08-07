// ----------------------------------------------------------------------------
// VariantsTab — per-SKU variant maintenance for a sofa base model.
//
// Lives as a top-tab on the Products page (next to SKU Master, Modular,
// Maintenance, Combos, Fabric). The matching combo-pricing UI already lives
// on the existing `combos` tab via the vendored SofaComboTab (full CRUD +
// history + anchors) — see the design handoff: combo-pricing is NOT
// duplicated here, only the docked variant editor from the Final design.
//
// Layout (Final · Pricing & Variants, right pane):
//   · Base model picker
//   · Axes — Size / Fabric tier / Colour swatches; selected = primary-soft
//     + primary border. Multi-select per axis acts as a filter on the table.
//   · Variant table — one row per SKU under the picked model:
//       SKU code (mono) · variant summary · price override · enable toggle
//   · Cancel / Save variants — local staged edits, batched PATCH on Save.
//
// Writes wire to existing endpoints:
//   PATCH /mfg-products/:id  { sell_price_sen / status }
// (useUpdateMfgProductPrices + useUpdateMfgProductStatus). Both already work
// in prod for the SKU Master editor — no new backend.
//
// "Setup notes" link in the header notes the BACKEND-CHECKLIST A6
// (sofa-compartments rename — for variant axis renames) dependency. Until A6
// ships, renames must be done one row at a time via SKU Master.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  RotateCw,
  Save,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "../../../components/Button";
import {
  useMfgProducts,
  useUpdateMfgProductStatus,
  useUpdateMfgProductPrices,
  type MfgProductRow,
} from "../../../vendor/scm/lib/mfg-products-queries";
import { authedFetch } from "../../../vendor/scm/lib/authed-fetch";
import { classifyLoadError, errMsg } from "../../../components/scm-v2/PhotoGallery";
import { cn } from "../../../lib/utils";
import { fmtCenti } from "@2990s/shared";

// ── Types ───────────────────────────────────────────────────────────────────

type Tier = "PRICE_1" | "PRICE_2" | "PRICE_3";
const TIER_LABELS: Record<Tier, string> = {
  PRICE_1: "Tier 1",
  PRICE_2: "Tier 2",
  PRICE_3: "Tier 3",
};

type ProductModel = {
  id: string;
  model_code: string;
  name: string;
  category: string;
  allowed_options?: {
    sizes?: string[] | null;
    fabrics?: string[] | null;
    compartments?: string[] | null;
  } | null;
};

type StagedEdit = {
  sellPriceSen?: number | null; // null = clear override → falls back to base
  status?: "ACTIVE" | "INACTIVE";
};

const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

// ── Hook: sofa models ───────────────────────────────────────────────────────

const useSofaModels = () =>
  useQuery({
    queryKey: ["product-models-sofa-for-variants"],
    queryFn: () =>
      authedFetch<{ models: ProductModel[] }>(
        `/product-models?category=SOFA`,
      ).then((r) => r.models),
    staleTime: 5 * 60_000,
    retry: false,
  });

// ── Component ───────────────────────────────────────────────────────────────

export function VariantsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const modelId = searchParams.get("model") ?? "";

  const setModelId = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    if (id) sp.set("model", id);
    else sp.delete("model");
    setSearchParams(sp, { replace: true });
  };

  const modelsQ = useSofaModels();
  const skusQ = useMfgProducts({ category: "SOFA" });

  const models = modelsQ.data ?? [];
  const skus = skusQ.data ?? [];
  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId) ?? null,
    [models, modelId],
  );
  const modelSkus = useMemo(
    () => (selectedModel ? skus.filter((s) => s.model_id === selectedModel.id) : []),
    [skus, selectedModel],
  );

  // Axis state — filter, multi-select
  const [pickedSizes, setPickedSizes] = useState<Set<string>>(new Set());
  const [pickedTiers, setPickedTiers] = useState<Set<Tier>>(new Set());
  const [pickedColours, setPickedColours] = useState<Set<string>>(new Set());

  // Reset axis picks when model changes
  useEffect(() => {
    setPickedSizes(new Set());
    setPickedTiers(new Set());
    setPickedColours(new Set());
    setStaged({});
    setSaveError(null);
  }, [modelId]);

  const allSizes = useMemo<string[]>(() => {
    const fromAllowed = selectedModel?.allowed_options?.sizes ?? [];
    if (fromAllowed.length > 0) return [...fromAllowed].sort();
    // Fallback: derive from SKU size_code values when allowed_options is empty.
    return Array.from(
      new Set(modelSkus.map((s) => s.size_code ?? "").filter(Boolean)),
    ).sort();
  }, [selectedModel, modelSkus]);
  const allTiers: Tier[] = ["PRICE_1", "PRICE_2", "PRICE_3"];
  const allColours = useMemo<string[]>(() => {
    return [...(selectedModel?.allowed_options?.fabrics ?? [])].sort();
  }, [selectedModel]);

  // Filter the SKU rows by the picks. Empty pick set on an axis = "no filter".
  const filteredSkus = useMemo(() => {
    return modelSkus.filter((s) => {
      if (pickedSizes.size > 0) {
        const sz = s.size_code ?? "";
        if (!pickedSizes.has(sz)) return false;
      }
      // Tier / colour filters are advisory in v1 — concrete tier/colour live
      // inside seat_height_prices + default_variants, not on the row directly.
      // We honour them only when the row's default_variants contains the keys.
      if (pickedTiers.size > 0) {
        const tier = (s.default_variants as { fabricTier?: string } | null)?.fabricTier;
        if (!tier || !pickedTiers.has(tier as Tier)) return false;
      }
      if (pickedColours.size > 0) {
        const col = (s.default_variants as { colourId?: string } | null)?.colourId;
        if (!col || !pickedColours.has(col)) return false;
      }
      return true;
    });
  }, [modelSkus, pickedSizes, pickedTiers, pickedColours]);

  // Staged edits + save mutations
  const [staged, setStaged] = useState<Record<string, StagedEdit>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const priceMut = useUpdateMfgProductPrices();
  const statusMut = useUpdateMfgProductStatus();

  const dirty = Object.keys(staged).length > 0;
  const stageEdit = (id: string, patch: StagedEdit) => {
    setSaveOk(false);
    setStaged((prev) => {
      const cur = prev[id] ?? {};
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  };

  const cancelEdits = () => {
    setStaged({});
    setSaveError(null);
  };

  const saveEdits = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    const entries = Object.entries(staged);
    const failures: string[] = [];
    for (const [id, edit] of entries) {
      try {
        if (edit.sellPriceSen !== undefined) {
          await priceMut.mutateAsync({
            id,
            // sell-price routes through price1Sen on this PATCH shape (the
            // existing SKU Master editor's "Selling" column maps to it).
            price1Sen: edit.sellPriceSen,
          });
        }
        if (edit.status !== undefined) {
          await statusMut.mutateAsync({ id, status: edit.status });
        }
      } catch (e) {
        failures.push(`${id}: ${errMsg(e)}`);
      }
    }
    setSaving(false);
    if (failures.length > 0) {
      setSaveError(`${failures.length} failed · ${failures[0]}`);
    } else {
      setStaged({});
      setSaveOk(true);
    }
  };

  const writesLikelyMissing =
    skusQ.error && classifyLoadError(skusQ.error) === "not-configured";

  const [showSetup, setShowSetup] = useState(false);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
            <Sparkles size={11} /> Products · Variants
          </div>
          <h2 className="mt-1 font-display text-[18px] font-extrabold tracking-tight text-ink">
            Per-SKU variant maintenance
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Toggle a variant active / inactive and override its selling price
            without touching the SKU Master grid. Combo pricing lives on the{" "}
            <span className="font-money">Combos</span> tab.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          aria-expanded={showSetup}
          className="text-[12px] font-semibold text-primary underline underline-offset-[3px] decoration-primary/40 hover:text-primary-ink hover:decoration-primary"
        >
          Setup notes
        </button>
      </div>

      {showSetup && (
        <div className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-[12px] text-primary-ink">
          <div className="text-[10px] font-semibold uppercase tracking-brand text-primary">
            Setup notes · Variants editor
          </div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            <li>
              Reads + writes the same <span className="font-money">mfg_products</span> table the
              SKU Master grid uses — there's no separate "variants" entity. A
              SKU under a sofa base model IS a variant.
            </li>
            <li>
              "Enable" toggles <span className="font-money">status</span> (ACTIVE / INACTIVE).
              Inactive variants stay in the catalogue but disappear from picker
              + POS surfaces.
            </li>
            <li>
              "Price override" writes <span className="font-money">price1_sen</span> (the
              Selling column). Blank clears the override and falls back to base.
            </li>
            <li>
              Renaming a variant axis cascades through{" "}
              <span className="font-money">sofa_compartments</span> — needs{" "}
              <span className="font-money">BACKEND-CHECKLIST · A6</span> (sofa-compartment
              rename). Until that ships, rename one row at a time via SKU Master.
            </li>
          </ul>
        </div>
      )}

      {/* Model picker */}
      <ModelPicker
        models={models}
        loading={modelsQ.isLoading}
        error={modelsQ.error ? errMsg(modelsQ.error) : null}
        selectedId={modelId}
        onPick={setModelId}
      />

      {!selectedModel ? (
        <div className="rounded-md border border-dashed border-border bg-surface-2 px-4 py-8 text-center text-[12px] text-ink-muted">
          Pick a sofa model above to see its variants.
        </div>
      ) : (
        <>
          {/* Axes */}
          <AxesBar
            sizes={allSizes}
            tiers={allTiers}
            colours={allColours}
            pickedSizes={pickedSizes}
            pickedTiers={pickedTiers}
            pickedColours={pickedColours}
            onSizes={setPickedSizes}
            onTiers={setPickedTiers}
            onColours={setPickedColours}
          />

          {/* Variants table */}
          <VariantsTable
            loading={skusQ.isLoading}
            error={writesLikelyMissing ? null : skusQ.error ? errMsg(skusQ.error) : null}
            notConfigured={Boolean(writesLikelyMissing)}
            rows={filteredSkus}
            staged={staged}
            onStage={stageEdit}
            onRetry={() => skusQ.refetch()}
            onOpenSetup={() => setShowSetup(true)}
          />

          {/* Footer — Cancel / Save */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
            <div className="text-[11.5px] text-ink-muted">
              {dirty
                ? `${Object.keys(staged).length} variant${
                    Object.keys(staged).length === 1 ? "" : "s"
                  } staged · changes commit on Save.`
                : "No changes."}
              {saveError && (
                <span className="ml-2 inline-flex items-center gap-1 font-semibold text-err">
                  <AlertCircle size={11} /> {saveError}
                </span>
              )}
              {saveOk && !saving && (
                <span className="ml-2 inline-flex items-center gap-1 font-semibold text-primary">
                  <Check size={11} /> Saved.
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={cancelEdits}
                disabled={!dirty || saving}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={saveEdits}
                disabled={!dirty || saving}
                icon={
                  saving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )
                }
              >
                {saving ? "Saving…" : "Save variants"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Model picker ────────────────────────────────────────────────────────────

function ModelPicker({
  models,
  loading,
  error,
  selectedId,
  onPick,
}: {
  models: ProductModel[];
  loading: boolean;
  error: string | null;
  selectedId: string;
  onPick: (id: string) => void;
}) {
  /* Same idiom as the Products page's ModelFilterRail (owner-approved,
     2026-05-28 "100个 model 不是排到尾巴去了吗", re-confirmed 2026-08-07
     "太丑了" against this tab's all-pills dump): the first PICKER_VISIBLE
     pills inline, the rest behind ONE "More (N) ▼" pill with a searchable
     popover, and the picked model always promoted into the visible row.
     The old side-by-side search box is gone — search lives in the popover. */
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const { inline, overflow } = useMemo(() => {
    if (models.length <= PICKER_VISIBLE) return { inline: models, overflow: [] as ProductModel[] };
    const head = models.slice(0, PICKER_VISIBLE);
    const tail = models.slice(PICKER_VISIBLE);
    const picked = tail.find((m) => m.id === selectedId);
    if (picked) {
      return {
        inline: [...head.slice(0, -1), picked],
        overflow: [head[head.length - 1]!, ...tail.filter((m) => m.id !== selectedId)],
      };
    }
    return { inline: head, overflow: tail };
  }, [models, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filteredOverflow = useMemo(() => {
    const trimmed = q.trim().toLowerCase();
    if (!trimmed) return overflow;
    return overflow.filter(
      (m) =>
        m.model_code.toLowerCase().includes(trimmed) ||
        (m.name ?? "").toLowerCase().includes(trimmed),
    );
  }, [q, overflow]);

  const pill = (m: ProductModel) => {
    const isOn = m.id === selectedId;
    return (
      <button
        key={m.id}
        type="button"
        onClick={() => onPick(m.id)}
        className={cn(
          "whitespace-nowrap rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-colors",
          isOn
            ? "border-primary bg-primary text-white"
            : "border-border bg-surface-2 text-ink-secondary hover:border-primary/40 hover:text-primary",
        )}
        aria-pressed={isOn}
      >
        <span>{m.model_code}</span>
        {m.name && m.name !== m.model_code && (
          <span className={cn("ml-1 opacity-80", isOn ? "" : "text-ink-muted")}>
            · {m.name}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-stone">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Sofa model
        </div>
        {loading && <span className="text-[11px] text-ink-muted">Loading…</span>}
      </div>
      {error ? (
        <div className="mt-2 rounded-md border border-err/40 bg-err/5 p-2.5 text-[12px] text-err">
          Couldn't load sofa models: {error}
        </div>
      ) : (
        <div ref={wrapRef} className="relative mt-2 flex flex-wrap items-center gap-1.5">
          {models.length === 0 && !loading && (
            <span className="text-[11.5px] text-ink-muted">No sofa models registered.</span>
          )}
          {inline.map(pill)}
          {overflow.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-haspopup="listbox"
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-surface px-3 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-primary/40 hover:text-primary"
              >
                <span>More ({overflow.length})</span>
                <ChevronDown size={12} strokeWidth={1.75} />
              </button>
              {open && (
                <div
                  role="listbox"
                  className="absolute right-0 top-full z-50 mt-1 flex max-h-[360px] w-[300px] flex-col rounded-md border border-border bg-surface p-2 shadow-slab"
                >
                  <div className="relative mb-2">
                    <Search
                      size={13}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
                      aria-hidden
                    />
                    <input
                      autoFocus
                      type="search"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search model…"
                      className="block w-full rounded-md border border-border bg-surface-2 py-1.5 pl-8 pr-2 text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="flex flex-1 flex-wrap content-start gap-1.5 overflow-y-auto">
                    {filteredOverflow.length === 0 && (
                      <span className="px-1 py-2 text-[11.5px] text-ink-muted">No models match.</span>
                    )}
                    {filteredOverflow.slice(0, PICKER_OVERFLOW_CAP).map((m) => pill(m))}
                    {filteredOverflow.length > PICKER_OVERFLOW_CAP && (
                      <span className="px-1 py-2 text-[11.5px] text-ink-muted">
                        +{filteredOverflow.length - PICKER_OVERFLOW_CAP} more — keep typing to narrow.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* Same numbers as the Products page's ModelFilterRail — one idiom, two tabs. */
const PICKER_VISIBLE = 12;
const PICKER_OVERFLOW_CAP = 60;

// ── Axes bar ────────────────────────────────────────────────────────────────

function AxesBar({
  sizes,
  tiers,
  colours,
  pickedSizes,
  pickedTiers,
  pickedColours,
  onSizes,
  onTiers,
  onColours,
}: {
  sizes: string[];
  tiers: Tier[];
  colours: string[];
  pickedSizes: Set<string>;
  pickedTiers: Set<Tier>;
  pickedColours: Set<string>;
  onSizes: (next: Set<string>) => void;
  onTiers: (next: Set<Tier>) => void;
  onColours: (next: Set<string>) => void;
}) {
  const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-surface p-4 shadow-stone lg:grid-cols-3">
      <Axis title="Size" empty="No sizes registered for this model.">
        {sizes.map((s) => {
          const isOn = pickedSizes.has(s);
          return (
            <Chip
              key={s}
              label={s}
              selected={isOn}
              onClick={() => onSizes(toggle(pickedSizes, s))}
            />
          );
        })}
      </Axis>
      <Axis title="Fabric tier" empty="No tiers.">
        {tiers.map((t) => {
          const isOn = pickedTiers.has(t);
          return (
            <Chip
              key={t}
              label={TIER_LABELS[t]}
              selected={isOn}
              onClick={() => onTiers(toggle(pickedTiers, t))}
            />
          );
        })}
      </Axis>
      <Axis title="Colour" empty="No fabrics in this model's allowed_options.">
        {colours.map((c) => {
          const isOn = pickedColours.has(c);
          return (
            <Chip
              key={c}
              label={c}
              selected={isOn}
              onClick={() => onColours(toggle(pickedColours, c))}
            />
          );
        })}
      </Axis>
    </div>
  );
}

function Axis({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const isEmpty = Array.isArray(children)
    ? children.length === 0
    : !children;
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {title}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {isEmpty ? (
          <span className="text-[11px] italic text-ink-muted">{empty}</span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
        selected
          ? "border-primary bg-primary-soft text-primary-ink"
          : "border-border bg-surface text-ink-secondary hover:border-primary/40 hover:text-primary",
      )}
      aria-pressed={selected}
    >
      {label}
    </button>
  );
}

// ── Variants table ─────────────────────────────────────────────────────────

function VariantsTable({
  loading,
  error,
  notConfigured,
  rows,
  staged,
  onStage,
  onRetry,
  onOpenSetup,
}: {
  loading: boolean;
  error: string | null;
  notConfigured: boolean;
  rows: MfgProductRow[];
  staged: Record<string, StagedEdit>;
  onStage: (id: string, patch: StagedEdit) => void;
  onRetry: () => void;
  onOpenSetup: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-10 rounded" />
        ))}
      </div>
    );
  }
  if (notConfigured) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 px-5 py-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[10px] border border-amber-300 bg-warning-bg text-warning-text">
          <Sparkles size={20} />
        </div>
        <div className="mt-3 text-[14px] font-bold text-ink">
          Variants endpoint not yet wired
        </div>
        <p className="mx-auto mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-ink-muted">
          The mfg-products read isn't responding. See{" "}
          <span className="font-money">BACKEND-CHECKLIST · A6 / A7</span>.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" onClick={onOpenSetup}>
            Setup notes
          </Button>
          <Button
            variant="secondary"
            icon={<RotateCw size={14} />}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
        <div className="flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <Button
            variant="secondary"
            icon={<RotateCw size={12} />}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface-2 px-4 py-8 text-center text-[12px] text-ink-muted">
        No variants under this model match the current axis picks.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <table className="w-full text-[12.5px]">
        <thead className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
          <tr>
            <th className="px-3 py-2 text-left">SKU</th>
            <th className="px-3 py-2 text-left">Variant</th>
            <th className="px-3 py-2 text-right">Base</th>
            <th className="px-3 py-2 text-right">Override</th>
            <th className="px-3 py-2 text-right">Effective</th>
            <th className="px-3 py-2 text-right">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <VariantRow
              key={r.id}
              row={r}
              alternateBg={i % 2 === 1}
              staged={staged[r.id]}
              onStage={(patch) => onStage(r.id, patch)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VariantRow({
  row,
  alternateBg,
  staged,
  onStage,
}: {
  row: MfgProductRow;
  alternateBg: boolean;
  staged?: StagedEdit;
  onStage: (patch: StagedEdit) => void;
}) {
  const basePriceSen = row.base_price_sen ?? 0;
  const liveSellSen = staged?.sellPriceSen ?? row.sell_price_sen ?? row.price1_sen ?? null;
  const liveStatus = staged?.status ?? row.status;
  const enabled = liveStatus === "ACTIVE";
  // The "effective" price is what the order engine charges: the override if
  // present, else the base.
  const effectiveSen = liveSellSen ?? basePriceSen;
  const overrideHasValue = liveSellSen !== null && liveSellSen !== undefined;

  // Local input state so the user can type freely; commit on blur.
  const [overrideStr, setOverrideStr] = useState<string>(
    overrideHasValue ? (liveSellSen! / 100).toFixed(2) : "",
  );
  useEffect(() => {
    setOverrideStr(overrideHasValue ? (liveSellSen! / 100).toFixed(2) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const commitOverride = () => {
    const t = overrideStr.trim();
    if (t === "") {
      onStage({ sellPriceSen: null });
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return; // ignore garbage
    onStage({ sellPriceSen: Math.round(n * 100) });
  };

  const variantSummary = useMemo(() => {
    // Build a compact "Variant" cell from the row's distinguishing axes.
    const parts: string[] = [];
    if (row.size_code) parts.push(row.size_code);
    const dv = row.default_variants as Record<string, unknown> | null;
    const fabricTier = dv?.fabricTier;
    if (typeof fabricTier === "string") {
      const label = TIER_LABELS[fabricTier as Tier];
      if (label) parts.push(label);
    }
    const colour =
      typeof dv?.colourId === "string" ? (dv.colourId as string) : null;
    if (colour) parts.push(colour);
    return parts.length > 0 ? parts.join(" · ") : "—";
  }, [row]);

  return (
    <tr
      className={cn(
        "border-t border-border-subtle align-middle",
        alternateBg && "bg-surface-2",
        staged && "ring-1 ring-inset ring-primary/30",
      )}
    >
      <td className="px-3 py-2 font-money text-[11.5px] text-ink">{row.code}</td>
      <td className="px-3 py-2 text-ink-secondary">
        <span>{row.name}</span>
        <div className="font-money text-[10.5px] text-ink-muted">
          {variantSummary}
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <span
          className={cn(
            "font-money",
            overrideHasValue ? "text-ink-muted line-through" : "text-ink",
          )}
        >
          {fmtRm(basePriceSen)}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          <span className="font-money text-[11px] text-ink-muted">RM</span>
          <input
            type="text"
            inputMode="decimal"
            value={overrideStr}
            placeholder="—"
            onChange={(e) => setOverrideStr(e.target.value)}
            onBlur={commitOverride}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
            aria-label={`Price override for ${row.code}`}
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-right font-money text-[11.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <span
          className={cn(
            "font-money font-semibold",
            staged?.sellPriceSen !== undefined ? "text-primary" : "text-ink",
          )}
        >
          {fmtRm(effectiveSen)}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <Toggle
          on={enabled}
          onChange={(next) =>
            onStage({ status: next ? "ACTIVE" : "INACTIVE" })
          }
          ariaLabel={`Toggle ${row.code} ${enabled ? "off" : "on"}`}
        />
      </td>
    </tr>
  );
}

function Toggle({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        on ? "border-primary bg-primary" : "border-border bg-surface-dim",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform",
          on ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
