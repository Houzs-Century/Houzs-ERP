// ----------------------------------------------------------------------------
// SalesOrderNewFromProducts — catalogue-to-cart SO assembler at
// /scm/sales-orders/new/from-products.
//
// Parallel entry alongside the Full form (/scm/sales-orders/new) and the
// Guided sofa wizard (/scm/sales-orders/new/guided). One SO out the door,
// single customer, sticky-cart UX. Distinct from /scm/sales-orders/generate
// which is a BULK batch-generate tool that fans out N SOs from N picked
// products — different paradigm.
//
// Constraints (owner-confirmed across the three entries):
//   · Single source of truth — POST goes through the SAME
//     useCreateMfgSalesOrder hook the other two flows use.
//   · No OCR / Payments / Address / Copy-from here — those stay on the Full
//     form. After save we redirect to /scm/sales-orders/:docNo so the operator
//     can enrich on the detail.
//
// Layout (Final F5):
//   · Left  = catalogue (search field + category chips + product rows with
//             "+ Add" buttons)
//   · Right = sticky cart card (inline customer block above the lines, then
//             −/qty/+ stepper per line, subtotal in primary-ink, Create CTA)
//   · Mobile (Mobile phone-2 design): two-pane stacks; dark sticky bottom bar
//             shows "N · subtotal · Create" with full-width tap target.
//
// URL is state: ?q= (search) and ?cat= (category filter).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { lineIdentity } from "@2990s/shared";
import {
  ArrowLeft,
  Check,
  Loader2,
  Minus,
  Plus,
  Search,
  ShoppingCart,
  Sparkles,
  X,
} from "lucide-react";
import { useQuery as _useQuery } from "@tanstack/react-query";
void _useQuery;
import { Button } from "../../components/Button";
import {
  useMfgProducts,
  type MfgProductRow,
} from "../../vendor/scm/lib/mfg-products-queries";
import {
  useCreateMfgSalesOrder,
  useDebtorSearch,
  type DebtorSuggestion,
} from "../../vendor/scm/lib/sales-order-queries";
import { useIdempotencyKey } from "../../lib/idempotency";
import { cn } from "../../lib/utils";
import { fmtCenti } from "../../vendor/shared/format";
import { soDateGuardError, soSliplessPaymentError, soErrorText } from "../../vendor/scm/lib/so-form-validate";
import { hasSofaMixConflict, SOFA_MIX_MESSAGE } from "../../vendor/shared/so-variant-rule";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { PhoneInput } from "../../vendor/scm/components/PhoneInput";

// ── Types & constants ───────────────────────────────────────────────────────

type Category = "ALL" | "SOFA" | "BEDFRAME" | "MATTRESS" | "ACCESSORY" | "SERVICE";

const CATEGORIES: Array<{ key: Category; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "SOFA", label: "Sofas" },
  { key: "BEDFRAME", label: "Bedframes" },
  { key: "MATTRESS", label: "Mattresses" },
  { key: "ACCESSORY", label: "Accessories" },
  { key: "SERVICE", label: "Services" },
];

type Customer = {
  name: string;
  phone: string;
  email: string;
  debtorCode: string | null;
};

// Guarded centi→"RM …" — "—" for an absent/non-finite amount, never "RM NaN".
const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";

const itemGroupFor = (cat: string): string => {
  const c = cat.toUpperCase();
  if (c === "SOFA") return "sofa";
  if (c === "BEDFRAME") return "bedframe";
  if (c === "MATTRESS") return "mattress";
  if (c === "ACCESSORY") return "accessory";
  if (c === "SERVICE") return "service";
  return "others";
};

// ── Page ────────────────────────────────────────────────────────────────────

export function SalesOrderNewFromProducts() {
  const navigate = useNavigate();
  const create = useCreateMfgSalesOrder();
  /* One key for the one order this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the SO detail on success, so the MOUNT is
     exactly one order — same rule as the other create surfaces. */
  const idemKey = useIdempotencyKey();

  // URL state: ?q=<search> ?cat=<category>
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const cat = (searchParams.get("cat") ?? "ALL") as Category;
  const setQ = (next: string) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set("q", next);
    else sp.delete("q");
    setSearchParams(sp, { replace: true });
  };
  const setCat = (next: Category) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "ALL") sp.delete("cat");
    else sp.set("cat", next);
    setSearchParams(sp, { replace: true });
  };
  const clearFilters = () => {
    setQInput("");
    const sp = new URLSearchParams(searchParams);
    sp.delete("q");
    sp.delete("cat");
    setSearchParams(sp, { replace: true });
  };

  /* Perf (go-live 2026-07-13) — the search field is DEBOUNCED. `qInput` is the
     live text box; only after a 250ms idle does it commit to the URL `q`, which
     is the value that drives the server query (useMfgProducts). Without this,
     every keystroke refetched the ~2000-SKU catalogue and re-rendered the whole
     list, which froze the page while typing. Clearing (X / Clear filters) writes
     both immediately so the reset is instant. */
  const [qInput, setQInput] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (qInput !== q) setQ(qInput);
    }, 250);
    return () => window.clearTimeout(t);
    // setQ is stable-by-behaviour (writes the URL); q re-runs the timer to a
    // no-op once the committed value catches up. qInput drives the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput, q]);
  const clearSearch = () => {
    setQInput("");
    setQ("");
  };

  // Catalogue — server-side filter on category + search via useMfgProducts.
  // Server-typeahead gate (owner #1 scaling pain, 2026-07-14) — the "All / no
  // search" read used to pull the WHOLE ~2000-SKU catalogue up front. It is now
  // bounded: the query only fires once >= 2 search chars are typed OR a category
  // chip is picked (a category-scoped read is bounded). Below the gate the
  // Catalogue shows a prompt instead. Cart selections are held in `knownByCode`
  // + `cartQty`, independent of this query, so gating never drops a picked item.
  const productsQ = useMfgProducts({
    category: cat === "ALL" ? undefined : cat,
    search: q.trim() || undefined,
    enabled: q.trim().length >= 2 || cat !== "ALL",
  });

  // Cart state — qty by SKU code (0 = not in cart).
  const [cartQty, setCartQty] = useState<Record<string, number>>({});
  const adjust = (code: string, delta: number) => {
    const next = Math.max(0, (cartQty[code] ?? 0) + delta);
    const out = { ...cartQty };
    if (next === 0) delete out[code];
    else out[code] = next;
    setCartQty(out);
  };
  const add = (code: string) => {
    setCartQty({ ...cartQty, [code]: (cartQty[code] ?? 0) + 1 });
  };
  const remove = (code: string) => {
    const out = { ...cartQty };
    delete out[code];
    setCartQty(out);
  };
  const clearCart = () => setCartQty({});

  // Customer state
  const [customer, setCustomer] = useState<Customer>({
    name: "",
    phone: "",
    email: "",
    debtorCode: null,
  });
  const [showValidation, setShowValidation] = useState(false);

  // Manual-add modal (Empty-state secondary CTA + cart-side action).
  const [manualOpen, setManualOpen] = useState(false);

  // Cart derived rows — index by code for O(1) lookup + bound to all known
  // products in the cache so we can render rows even when the catalogue filter
  // hides them (an item added before the user narrowed the category).
  const [knownByCode, setKnownByCode] = useState<Record<string, MfgProductRow>>({});
  useEffect(() => {
    if (!productsQ.data || productsQ.data.length === 0) return;
    setKnownByCode((prev) => {
      const out = { ...prev };
      for (const p of productsQ.data) out[p.code] = p;
      return out;
    });
  }, [productsQ.data]);

  const cartLines = useMemo(() => {
    return Object.entries(cartQty)
      .filter(([, qty]) => qty > 0)
      .map(([code, qty]) => {
        const sku = knownByCode[code];
        const priceSen = sku?.sell_price_sen ?? sku?.base_price_sen ?? 0;
        return { code, qty, sku: sku ?? null, priceSen };
      });
  }, [cartQty, knownByCode]);
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0);
  const subtotalSen = cartLines.reduce((s, l) => s + l.priceSen * l.qty, 0);

  // Submit
  const [postError, setPostError] = useState<string | null>(null);
  const customerValid = customer.name.trim() && customer.phone.trim();
  const canSubmit = customerValid && cartLines.length > 0 && !create.isPending;

  const onSubmit = async () => {
    if (!canSubmit) {
      setShowValidation(true);
      return;
    }
    setShowValidation(false);
    setPostError(null);
    const items = cartLines.map((l) => ({
      itemCode: l.code,
      itemGroup: itemGroupFor(l.sku?.category ?? "OTHERS"),
      description: l.sku?.name ?? "",
      qty: l.qty,
      unitPriceCenti: l.priceSen,
      discountCenti: 0,
      unitCostCenti: 0,
      variants: { addedVia: "from-products" },
      remark: "",
    }));
    /* Pre-validate with the SAME shared guards the Full form (SalesOrderNew)
       runs, so a bad cart surfaces one plain sentence here instead of a raw
       server 400/409. A cart CAN mix categories, so hasSofaMixConflict is the
       real guard here (a sofa + bedframe/mattress cart 400s so_sofa_no_other_main
       on the server). This flow collects no dates or payments (added on the SO
       detail), so soDateGuardError / soSliplessPaymentError run on empty inputs
       and pass — kept for single-logic-layer parity so a future date/payment
       field is guarded automatically. Variant completeness
       (missingRequiredVariants) only fires once a processing date is set (server
       parity); none is set here, so it's enforced on the SO detail. */
    const preErr =
      soDateGuardError({ processingDate: "", deliveryDate: "", today: todayMyt() }) ??
      (hasSofaMixConflict(items.map((i) => i.itemGroup)) ? { title: SOFA_MIX_MESSAGE } : null) ??
      soSliplessPaymentError([]);
    if (preErr) {
      setPostError(soErrorText(preErr));
      return;
    }

    /* This flow carries no Processing Date and no variant editors by design
       ("enrich on the SO detail after save"), so nothing here can be
       spec-complete and nothing here needs to be: variant completeness is the
       PROCEED rule (owner 2026-08-13), and proceeding happens on the detail
       page once a date is set.

       It used to downgrade such a cart to a DRAFT, because the confirm gate
       (2026-08-08) would have refused a direct-CONFIRMED create. That gate no
       longer asks about variants, so the downgrade would now only strand a
       real order in Draft for no reason. */
    const body: Record<string, unknown> = {
      customerName: customer.name.trim(),
      phone: customer.phone.trim(),
      email: customer.email.trim() || null,
      debtorCode: customer.debtorCode || null,
      items,
    };
    try {
      const res = await create.mutateAsync({ ...body, idempotencyKey: idemKey });
      navigate(`/scm/sales-orders/${res.docNo}`);
    } catch (e) {
      setPostError(errMsg(e));
    }
  };

  return (
    <div className="space-y-4 py-4 sm:py-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate("/scm/sales-orders")}
            className="mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted hover:text-primary"
          >
            <ArrowLeft size={12} /> Sales Orders
          </button>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
            <ShoppingCart size={11} /> SCM · Sales Order · From Products
          </div>
          <h1 className="mt-1 font-display text-[21px] font-extrabold tracking-tight text-ink">
            New order from catalogue
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Pick products from the catalogue, set quantities, confirm. Payments
            and address are added on the SO detail after save.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/scm/sales-orders/new")}
          className="text-[12px] font-semibold text-primary underline underline-offset-[3px] decoration-primary/40 hover:text-primary-ink hover:decoration-primary"
        >
          Switch to Full form
        </button>
      </div>

      {/* POST error banner */}
      {postError && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't create the sales order: {postError}
        </div>
      )}

      {/* Body: catalogue left, cart right (stacks on mobile) */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Catalogue
          q={q}
          qInput={qInput}
          setQInput={setQInput}
          onClearSearch={clearSearch}
          cat={cat}
          setCat={setCat}
          products={productsQ.data ?? []}
          loading={productsQ.isLoading}
          error={productsQ.error ? errMsg(productsQ.error) : null}
          cartQty={cartQty}
          onAdd={add}
          onAdjust={adjust}
          onClearFilters={clearFilters}
          onManualAdd={() => setManualOpen(true)}
        />
        <CartCard
          customer={customer}
          setCustomer={setCustomer}
          showValidation={showValidation}
          cartLines={cartLines}
          cartCount={cartCount}
          subtotalSen={subtotalSen}
          onAdjust={adjust}
          onRemove={remove}
          onClearCart={clearCart}
          submitting={create.isPending}
          canSubmit={Boolean(canSubmit)}
          onSubmit={onSubmit}
        />
      </div>

      {/* Mobile sticky footer — only when the cart has lines, hidden on lg+ */}
      <MobileFooter
        cartCount={cartCount}
        subtotalSen={subtotalSen}
        submitting={create.isPending}
        canSubmit={Boolean(canSubmit)}
        onSubmit={onSubmit}
      />

      {/* Manual-add modal (out-of-catalogue codes) */}
      {manualOpen && (
        <ManualAddModal
          onClose={() => setManualOpen(false)}
          onAdd={(row) => {
            setKnownByCode((prev) => ({ ...prev, [row.code]: row }));
            setCartQty((prev) => ({ ...prev, [row.code]: (prev[row.code] ?? 0) + 1 }));
            setManualOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── Catalogue (left) ────────────────────────────────────────────────────────

// Perf cap — the catalogue never renders more than this many rows at once, so
// a 2000-SKU "All / no search" set can't freeze the page. Beyond the cap a
// hint tells the operator to narrow by category or search.
const RENDER_CAP = 60;

function Catalogue({
  q,
  qInput,
  setQInput,
  onClearSearch,
  cat,
  setCat,
  products,
  loading,
  error,
  cartQty,
  onAdd,
  onAdjust,
  onClearFilters,
  onManualAdd,
}: {
  q: string;
  qInput: string;
  setQInput: (s: string) => void;
  onClearSearch: () => void;
  cat: Category;
  setCat: (c: Category) => void;
  products: MfgProductRow[];
  loading: boolean;
  error: string | null;
  cartQty: Record<string, number>;
  onAdd: (code: string) => void;
  onAdjust: (code: string, delta: number) => void;
  onClearFilters: () => void;
  onManualAdd: () => void;
}) {
  const filteredActive = useMemo(
    () => products.filter((p) => p.status === "ACTIVE"),
    [products],
  );
  // Cap the DOM to RENDER_CAP rows — see RENDER_CAP note above.
  const shown = useMemo(
    () => filteredActive.slice(0, RENDER_CAP),
    [filteredActive],
  );
  const hiddenCount = filteredActive.length - shown.length;
  const hasFilters = q.trim() !== "" || cat !== "ALL";
  /* Server-typeahead gate (2026-07-14): the catalogue query only fires once >= 2
     search chars are typed OR a category chip is picked. Below the gate we show a
     prompt rather than the "no products" empties (which would misread as "empty
     catalogue"). Mirrors the parent's useMfgProducts `enabled`. */
  const gateOpen = q.trim().length >= 2 || cat !== "ALL";
  const isEmptyAfterFilters =
    !loading && !error && hasFilters && gateOpen && filteredActive.length === 0;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-stone sm:p-5">
      {/* Search */}
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <input
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search products, SKU, name…"
          className="block w-full rounded-md border border-border bg-surface-2 py-2 pl-9 pr-9 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        {qInput && (
          <button
            type="button"
            onClick={onClearSearch}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted hover:bg-surface-dim hover:text-ink"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Category chips */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {CATEGORIES.map((c) => {
          const isOn = cat === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setCat(c.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-colors",
                isOn
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-surface-2 text-ink-secondary hover:border-primary/40 hover:text-primary",
              )}
              aria-pressed={isOn}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="mt-4 divide-y divide-border-subtle">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <div className="skeleton h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3 w-2/3 rounded" />
                <div className="skeleton h-2.5 w-1/3 rounded" />
              </div>
              <div className="skeleton h-7 w-14 rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="mt-4 rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't load products: {error}
        </div>
      )}

      {/* Server-typeahead prompt — shown below the gate (no fetch happens). */}
      {!loading && !error && !gateOpen && (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-4 text-[12px] text-ink-muted">
          Type at least 2 characters, or pick a category, to browse the catalogue.
        </div>
      )}

      {/* Empty (no products at all in this category, ignoring search) */}
      {!loading && !error && gateOpen && !hasFilters && filteredActive.length === 0 && (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-4 text-[12px] text-ink-muted">
          No active products in this category yet.
        </div>
      )}

      {/* Empty after filters (S1 design) */}
      {isEmptyAfterFilters && (
        <div className="mt-4 flex flex-col items-center rounded-xl border border-border bg-surface p-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed border-border-strong text-ink-muted">
            <Search size={22} />
          </div>
          <div className="mt-4 font-display text-[15px] font-bold text-ink">
            No matching products
          </div>
          <p className="mt-1.5 max-w-[340px] text-[12.5px] leading-relaxed text-ink-muted">
            Nothing matches{" "}
            {q && (
              <>
                <span className="font-money text-accent">'{q}'</span>
                {cat !== "ALL" && " and "}
              </>
            )}
            {cat !== "ALL" && (
              <>
                the{" "}
                <span className="font-semibold text-accent">
                  {CATEGORIES.find((c) => c.key === cat)?.label}
                </span>{" "}
                category
              </>
            )}
            . Try a broader keyword or clear the category.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={onClearFilters}>
              Clear filters
            </Button>
            <Button variant="secondary" onClick={onManualAdd}>
              Add item manually
            </Button>
          </div>
        </div>
      )}

      {/* Product rows (capped at RENDER_CAP to keep the page responsive) */}
      {!loading && !error && filteredActive.length > 0 && (
        <ul className="mt-3 divide-y divide-border-subtle">
          {shown.map((p) => {
            const qty = cartQty[p.code] ?? 0;
            const inCart = qty > 0;
            const priceSen = p.sell_price_sen ?? p.base_price_sen ?? 0;
            return (
              <li
                key={p.id}
                className="flex min-h-[3.25rem] flex-nowrap items-center gap-3 py-2.5"
              >
                {/* placeholder thumb */}
                <div
                  className="h-10 w-10 shrink-0 rounded-lg border border-border"
                  style={{
                    background:
                      "repeating-linear-gradient(45deg, #e3e6e0 0 4px, #f4f6f3 4px 8px)",
                  }}
                  aria-hidden
                />
                {/* Description ONCE, code NOT displayed — the shared rule
                    (vendor/shared/line-identity.ts) and the picker precedent it
                    encodes (Commander 2026-05-27: "picker rows show description
                    only — one scannable line per SKU. The code still binds on
                    click"). The code still BINDS: this card's onClick adds
                    p.code to the cart. BRANDING is kept and is not a duplicate —
                    it appears nowhere else on the card — so its line renders
                    whenever it exists, now without the leading code. */}
                {(() => {
                  const { primary, secondary } = lineIdentity({
                    code: p.code,
                    description: p.name,
                    variant: p.branding,
                  });
                  return (
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-semibold text-ink">
                        {primary}
                      </div>
                      {secondary && (
                        <div className="truncate font-money text-[10.5px] text-ink-muted">
                          {secondary}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div className="shrink-0 font-money text-[12px] font-bold text-ink">
                  {fmtRm(priceSen)}
                </div>
                {inCart ? (
                  <div className="inline-flex shrink-0 items-center overflow-hidden rounded-md border border-border bg-surface">
                    <button
                      type="button"
                      onClick={() => onAdjust(p.code, -1)}
                      aria-label="Decrease qty"
                      className="flex h-7 w-7 items-center justify-center bg-surface-2 text-ink-secondary hover:bg-surface-dim"
                    >
                      <Minus size={12} />
                    </button>
                    <span className="w-7 text-center font-money text-[12px] font-bold text-ink">
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => onAdjust(p.code, +1)}
                      aria-label="Increase qty"
                      className="flex h-7 w-7 items-center justify-center bg-primary text-white hover:bg-primary-ink"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAdd(p.code)}
                    className="shrink-0 rounded-md border border-primary/30 bg-primary-soft px-3 py-1.5 text-[11.5px] font-bold text-primary-ink hover:bg-primary hover:text-white"
                  >
                    + Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Cap hint — more matches exist than we render; narrow to reach them. */}
      {!loading && !error && hiddenCount > 0 && (
        <div className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-center text-[11.5px] text-ink-muted">
          Showing the first {RENDER_CAP} of {filteredActive.length} products.
          Search or pick a category to narrow the list.
        </div>
      )}
    </div>
  );
}

// ── Cart card (right) ───────────────────────────────────────────────────────

function CartCard({
  customer,
  setCustomer,
  showValidation,
  cartLines,
  cartCount,
  subtotalSen,
  onAdjust,
  onRemove,
  onClearCart,
  submitting,
  canSubmit,
  onSubmit,
}: {
  customer: Customer;
  setCustomer: (c: Customer) => void;
  showValidation: boolean;
  cartLines: Array<{ code: string; qty: number; sku: MfgProductRow | null; priceSen: number }>;
  cartCount: number;
  subtotalSen: number;
  onAdjust: (code: string, delta: number) => void;
  onRemove: (code: string) => void;
  onClearCart: () => void;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  return (
    <aside className="self-start rounded-xl border border-border bg-surface p-4 shadow-stone lg:sticky lg:top-4">
      {/* Customer block */}
      <CustomerBlock
        customer={customer}
        setCustomer={setCustomer}
        showValidation={showValidation}
      />
      <div className="my-3 h-px bg-border-subtle" />

      {/* Lines header */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Selected · {cartCount} pc{cartCount === 1 ? "" : "s"}
        </div>
        {cartLines.length > 0 && (
          <button
            type="button"
            onClick={onClearCart}
            className="text-[10.5px] font-semibold text-primary hover:text-primary-ink"
          >
            Clear
          </button>
        )}
      </div>

      {/* Lines */}
      {cartLines.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-border bg-surface-2 px-3 py-6 text-center text-[12px] text-ink-muted">
          No products selected yet.
          <br />
          Add from the catalogue → the cart appears here.
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-border-subtle">
          {cartLines.map((l) => (
            <li key={l.code} className="py-2.5">
              <div className="flex items-start justify-between gap-2">
                {/* Description ONCE, code NOT displayed — the shared rule
                    (vendor/shared/line-identity.ts). The code still BINDS: it is
                    this cart row's key and what onRemove(l.code) acts on. The
                    code stays the visible fallback for a SKU with no name. */}
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-semibold text-ink">
                    {lineIdentity({ code: l.code, description: l.sku?.name }).primary}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(l.code)}
                  aria-label="Remove from cart"
                  className="text-err hover:text-err/80"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="inline-flex items-center overflow-hidden rounded-md border border-border bg-surface">
                  <button
                    type="button"
                    onClick={() => onAdjust(l.code, -1)}
                    aria-label="Decrease qty"
                    className="flex h-6 w-6 items-center justify-center bg-surface-2 text-ink-secondary hover:bg-surface-dim"
                  >
                    <Minus size={11} />
                  </button>
                  <span className="w-7 text-center font-money text-[12px] font-bold text-ink">
                    {l.qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => onAdjust(l.code, +1)}
                    aria-label="Increase qty"
                    className="flex h-6 w-6 items-center justify-center bg-primary text-white hover:bg-primary-ink"
                  >
                    <Plus size={11} />
                  </button>
                </div>
                <span className="font-money text-[12.5px] font-bold text-ink-secondary">
                  {fmtRm(l.priceSen * l.qty)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Subtotal */}
      <div className="mt-3 flex items-baseline justify-between border-t-2 border-border pt-3">
        <span className="text-[12px] font-bold text-ink">Subtotal</span>
        <span className="font-money text-[19px] font-extrabold text-primary-ink">
          {fmtRm(subtotalSen)}
        </span>
      </div>

      {/* Validation hint */}
      {showValidation && !canSubmit && (
        <div className="mt-3 rounded-md border border-err/40 bg-err/5 p-2.5 text-[11.5px] text-err">
          {(!customer.name.trim() || !customer.phone.trim()) && (
            <div>Customer name and phone are required.</div>
          )}
          {cartLines.length === 0 && <div>Add at least one product first.</div>}
        </div>
      )}

      {/* CTA — desktop. On mobile the sticky bottom bar handles submit. */}
      <div className="mt-3 hidden lg:block">
        <div className="flex items-center justify-between gap-3">
          <span className="font-money text-[13px] font-bold text-primary-ink">
            {fmtRm(subtotalSen)}
          </span>
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={submitting || !canSubmit}
            icon={submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          >
            {submitting ? "Saving…" : "Create Sales Order"}
          </Button>
        </div>
        <p className="mt-1 text-right text-[10.5px] text-ink-muted">
          Server validates SKU codes and re-prices any matching combo on save.
        </p>
      </div>
    </aside>
  );
}

// ── Inline customer block (in cart) ─────────────────────────────────────────

function CustomerBlock({
  customer,
  setCustomer,
  showValidation,
}: {
  customer: Customer;
  setCustomer: (c: Customer) => void;
  showValidation: boolean;
}) {
  const debtors = useDebtorSearch(customer.name.trim().length >= 2 ? customer.name.trim() : "");
  const [showSuggest, setShowSuggest] = useState(false);
  const suggestions: DebtorSuggestion[] = (debtors.data?.debtors ?? []).filter(
    (d) => (d.debtor_name ?? "").toLowerCase() !== customer.name.trim().toLowerCase(),
  );
  const applySuggestion = (d: DebtorSuggestion) => {
    setCustomer({
      name: d.debtor_name ?? "",
      phone: d.phone ?? "",
      email: customer.email,
      debtorCode: d.debtor_code,
    });
    setShowSuggest(false);
  };
  const nameMissing = showValidation && !customer.name.trim();
  const phoneMissing = showValidation && !customer.phone.trim();
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Customer
      </div>
      <div className="mt-2 space-y-2">
        <div className="relative">
          <input
            type="text"
            value={customer.name}
            onChange={(e) => {
              setCustomer({ ...customer, name: e.target.value, debtorCode: null });
              setShowSuggest(true);
            }}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => window.setTimeout(() => setShowSuggest(false), 150)}
            placeholder="Customer name *"
            className={cn(
              "block w-full rounded-md border bg-surface px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
              nameMissing ? "border-err" : "border-border",
            )}
          />
          {showSuggest && suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-surface shadow-lg">
              {suggestions.slice(0, 6).map((d) => (
                <button
                  type="button"
                  key={d.debtor_code ?? d.debtor_name ?? Math.random()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySuggestion(d)}
                  className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-primary-soft"
                >
                  <div className="font-semibold text-ink">{d.debtor_name}</div>
                  {(d.debtor_code || d.phone) && (
                    <div className="font-money text-[10px] text-ink-muted">
                      {[d.debtor_code, d.phone].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <PhoneInput
            value={customer.phone}
            onChange={(v) => setCustomer({ ...customer, phone: v })}
            className={cn(
            "block w-full rounded-md border bg-surface px-3 py-1.5 font-money text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
            phoneMissing ? "border-err" : "border-border",
            )}
          />
        <input
          type="email"
          value={customer.email}
          onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
          placeholder="Email (optional)"
          className="block w-full rounded-md border border-border bg-surface px-3 py-1.5 font-money text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        {customer.debtorCode && (
          <div className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-primary">
            <Check size={11} /> Matched debtor{" "}
            <span className="font-money">{customer.debtorCode}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Mobile sticky footer ────────────────────────────────────────────────────

function MobileFooter({
  cartCount,
  subtotalSen,
  submitting,
  canSubmit,
  onSubmit,
}: {
  cartCount: number;
  subtotalSen: number;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  if (cartCount === 0) return null;
  return (
    <div className="sticky bottom-0 -mx-4 mt-4 bg-sidebar px-4 py-3 text-sidebar-ink shadow-[0_-4px_18px_-8px_rgba(17,24,16,.4)] lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-brand text-sidebar-ink-muted">
            {cartCount} pc{cartCount === 1 ? "" : "s"} · subtotal
          </div>
          <div className="font-money text-[16px] font-extrabold text-accent-bright">
            {fmtRm(subtotalSen)}
          </div>
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting || !canSubmit}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-md px-4 text-[13px] font-bold transition-colors",
            canSubmit && !submitting
              ? "bg-primary text-white hover:bg-primary-ink"
              : "cursor-not-allowed bg-sidebar-hover text-sidebar-ink-muted",
          )}
        >
          {submitting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Check size={14} />
          )}
          {submitting ? "Saving…" : "Create SO"}
        </button>
      </div>
    </div>
  );
}

// ── Manual-add modal ────────────────────────────────────────────────────────

function ManualAddModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (row: MfgProductRow) => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [priceRm, setPriceRm] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const canAdd = code.trim() && name.trim() && Number(priceRm) > 0;
  const submit = () => {
    if (!canAdd) return;
    const priceSen = Math.round(Number(priceRm) * 100);
    // Construct a minimal MfgProductRow stand-in. The server validates the
    // itemCode against mfg_products.code on POST, so a typo here gets caught
    // at save time rather than silently riding through.
    const row: MfgProductRow = {
      id: `manual-${code.trim()}`,
      code: code.trim(),
      name: name.trim(),
      category: "ACCESSORY",
      base_price_sen: priceSen,
      price1_sen: null,
      sell_price_sen: priceSen,
      status: "ACTIVE",
      unit_m3_milli: 0,
    };
    onAdd(row);
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-slab"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-brand text-accent">
            <Sparkles size={11} /> Add item manually
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
        <p className="mt-1 text-[11.5px] text-ink-muted">
          For SKUs not yet in the catalogue. The server validates the code on
          save — if it doesn't exist in <span className="font-money">mfg_products</span>,
          the SO will be rejected and you can fix it on the detail.
        </p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              SKU code <span className="text-err">*</span>
            </span>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="MIL-LSHAPE"
              className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-1.5 font-money text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Description <span className="text-err">*</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Milano L-shape sofa"
              className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Unit price (RM) <span className="text-err">*</span>
            </span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={priceRm}
              onChange={(e) => setPriceRm(e.target.value)}
              placeholder="1280.00"
              className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-1.5 font-money text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canAdd}>
            Add to cart
          </Button>
        </div>
      </div>
    </div>
  );
}
