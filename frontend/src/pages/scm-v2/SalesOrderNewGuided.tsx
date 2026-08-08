// ----------------------------------------------------------------------------
// SalesOrderNewGuided — showroom-floor 6-step sofa configurator at
// /scm/sales-orders/new/guided.
//
// Parallel entry alongside the existing power form (/scm/sales-orders/new).
// Designed for the in-showroom flow where a sales rep walks a walk-in
// customer through "pick model → pick modules → pick fabric tier → confirm",
// then enriches the SO (OCR / Payments / Address / etc.) on the Detail page.
//
// Constraints (owner-confirmed):
//   · Single source of truth — POST goes through the SAME useCreateMfgSalesOrder
//     hook the power form uses, hitting POST /mfg-sales-orders.
//   · No OCR / Payments / Address / Copy-from in the wizard — those stay on the
//     power form. The wizard creates the SO header + sofa lines, then redirects
//     to the SO Detail so the operator can add payments etc. there.
//   · Step 5 "Add-ons" is intentionally a pass-through in v1 (PWP picker lives
//     on the SO Detail; not duplicated here).
//
// Pricing in the wizard preview is BEST-EFFORT (sum of per-SKU base_price_sen
// × qty). The server-side combo-pricing engine re-prices on POST — the wizard
// shows an indicative subtotal, not the authoritative number.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { lineIdentity } from "@2990s/shared";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Minus,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "../../components/Button";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";

// authedFetch surfaces backend errors as Error objects whose `.message` already
// contains the human-readable string errMsg() built (status + body). We
// just unwrap to a string for display.
const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
import {
  useCreateMfgSalesOrder,
  useDebtorSearch,
  type DebtorSuggestion,
} from "../../vendor/scm/lib/sales-order-queries";
import { useIdempotencyKey } from "../../lib/idempotency";
import { useQuery } from "@tanstack/react-query";
import { cn } from "../../lib/utils";
import { fmtCenti } from "../../vendor/shared/format";
import { soDateGuardError, soSliplessPaymentError, soErrorText } from "../../vendor/scm/lib/so-form-validate";
import { hasSofaMixConflict, SOFA_MIX_MESSAGE } from "../../vendor/shared/so-variant-rule";
import { todayMyt } from "../../vendor/scm/lib/dates";
import { PhoneInput } from "../../vendor/scm/components/PhoneInput";

// ── Types ────────────────────────────────────────────────────────────────────

type Tier = "PRICE_1" | "PRICE_2" | "PRICE_3";

type ProductModel = {
  id: string;
  model_code: string;
  name: string;
  category: string;
  description: string | null;
  photo_url: string | null;
  active: boolean;
  sku_count?: number;
};

type MfgProduct = {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string | null;
  base_model: string | null;
  model_id: string | null;
  base_price_sen: number;
  price1_sen: number | null;
  sell_price_sen: number | null;
  size_code: string | null;
  size_label: string | null;
  status: string;
};

type Customer = {
  name: string;
  phone: string;
  email: string;
  debtorCode: string | null;
};

const STEPS = [
  "Customer",
  "Model",
  "Modules",
  "Fabric",
  "Add-ons",
  "Review",
] as const;

const TIER_LABELS: Record<Tier, { short: string; long: string }> = {
  PRICE_1: { short: "Tier 1", long: "PRICE_1 · standard fabric" },
  PRICE_2: { short: "Tier 2", long: "PRICE_2 · premium fabric" },
  PRICE_3: { short: "Tier 3", long: "PRICE_3 · top-end fabric / leather" },
};

// Guarded centi→"RM …" — "—" for an absent/non-finite amount, never "RM NaN".
const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

// ── Hooks (wizard-local) ────────────────────────────────────────────────────

const useSofaModels = () =>
  useQuery({
    queryKey: ["scm", "product-models", "SOFA"],
    queryFn: () =>
      authedFetch<{ models: ProductModel[] }>(
        "/product-models?category=SOFA",
      ).then((r) => r.models),
    staleTime: 5 * 60_000,
  });

const useSofaSkus = () =>
  useQuery({
    queryKey: ["scm", "mfg-products", "SOFA"],
    queryFn: () =>
      authedFetch<{ products: MfgProduct[] }>(
        "/mfg-products?category=SOFA",
      ).then((r) => r.products),
    staleTime: 5 * 60_000,
  });

// ── Page ────────────────────────────────────────────────────────────────────

export function SalesOrderNewGuided() {
  const navigate = useNavigate();
  const create = useCreateMfgSalesOrder();
  /* One key for the one order this page is open to raise (lib/idempotency.ts).
     This is a route-level form that navigates to the SO detail on success, so
     the MOUNT is exactly one order — same rule as mobile MobileNewSO, one logic
     layer. Minted once by useState's lazy init: stable across re-renders and
     across a re-press after a stalled submit (the retry replays the first
     order's docNo), fresh on the next mount so a genuinely new order is new. */
  const idemKey = useIdempotencyKey();

  const [step, setStep] = useState<number>(0);
  const [showValidation, setShowValidation] = useState<boolean>(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Draft state
  const [customer, setCustomer] = useState<Customer>({
    name: "",
    phone: "",
    email: "",
    debtorCode: null,
  });
  const [modelId, setModelId] = useState<string | null>(null);
  // qty per SKU code (0 = not in the build)
  const [moduleQty, setModuleQty] = useState<Record<string, number>>({});
  const [tier, setTier] = useState<Tier>("PRICE_1");
  const [note, setNote] = useState<string>("");

  // Data
  const modelsQ = useSofaModels();
  const skusQ = useSofaSkus();
  const skusForModel = useMemo<MfgProduct[]>(() => {
    if (!modelId || !skusQ.data) return [];
    return skusQ.data
      .filter((s) => s.model_id === modelId)
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [modelId, skusQ.data]);
  const selectedModel = useMemo<ProductModel | null>(() => {
    if (!modelId || !modelsQ.data) return null;
    return modelsQ.data.find((m) => m.id === modelId) ?? null;
  }, [modelId, modelsQ.data]);

  // Derived
  const moduleEntries = useMemo(
    () =>
      Object.entries(moduleQty).filter(([, qty]) => qty > 0) as Array<
        [string, number]
      >,
    [moduleQty],
  );
  const modulePcs = useMemo(
    () => moduleEntries.reduce((s, [, q]) => s + q, 0),
    [moduleEntries],
  );
  const subtotalSen = useMemo(() => {
    if (!skusQ.data) return 0;
    let sum = 0;
    for (const [code, qty] of moduleEntries) {
      const sku = skusQ.data.find((s) => s.code === code);
      if (!sku) continue;
      const price = sku.sell_price_sen ?? sku.base_price_sen ?? 0;
      sum += price * qty;
    }
    return sum;
  }, [moduleEntries, skusQ.data]);

  // Validation per step
  const stepValid = (s: number): boolean => {
    if (s === 0) return customer.name.trim().length > 0 && customer.phone.trim().length > 0;
    if (s === 1) return Boolean(modelId);
    if (s === 2) return moduleEntries.length > 0;
    return true; // tier / add-ons / review always valid
  };

  const goNext = () => {
    if (!stepValid(step)) {
      setShowValidation(true);
      return;
    }
    setShowValidation(false);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const goBack = () => {
    setShowValidation(false);
    setStep((s) => Math.max(s - 1, 0));
  };

  // Reset module qty when model changes
  useEffect(() => {
    setModuleQty({});
  }, [modelId]);

  const onSubmit = async () => {
    setPostError(null);
    // Build the items payload. One line per chosen module, qty as picked. The
    // backend's sofa-build / combo-pricing engine takes over from here.
    const items = moduleEntries.map(([code, qty]) => {
      const sku = skusQ.data?.find((s) => s.code === code);
      const unitPriceSen = sku?.sell_price_sen ?? sku?.base_price_sen ?? 0;
      return {
        itemCode: code,
        itemGroup: "sofa",
        description: sku?.name ?? "",
        qty,
        unitPriceCenti: unitPriceSen,
        discountCenti: 0,
        unitCostCenti: 0,
        variants: {
          fabricTier: tier,
          configuredVia: "wizard",
        },
        remark: "",
      };
    });

    /* Pre-validate with the SAME shared guards the Full form (SalesOrderNew)
       runs, so a bad build surfaces one plain sentence here instead of a raw
       server 400/409. The wizard collects no dates or payments (added on the SO
       detail after save), so soDateGuardError / soSliplessPaymentError operate
       on empty inputs and pass — kept for single-logic-layer parity so a future
       date/payment field on this flow is guarded automatically. Every line here
       is a sofa module, so hasSofaMixConflict can't fire in practice, but the
       check mirrors the Full form verbatim. Variant completeness
       (missingRequiredVariants) is enforced only once a processing date is set
       (server parity); the guided flow sets none, so it's enforced on the SO
       detail, not here. */
    const preErr =
      soDateGuardError({ processingDate: "", deliveryDate: "", today: todayMyt() }) ??
      (hasSofaMixConflict(items.map((i) => i.itemGroup)) ? { title: SOFA_MIX_MESSAGE } : null) ??
      soSliplessPaymentError([]);
    if (preErr) {
      setPostError(soErrorText(preErr));
      return;
    }

    const body: Record<string, unknown> = {
      customerName: customer.name.trim(),
      phone: customer.phone.trim(),
      email: customer.email.trim() || null,
      debtorCode: customer.debtorCode || null,
      note: note.trim() || null,
      items,
      // Dates intentionally omitted — server permits header-first.
      /* Owner 2026-08-08 — CONFIRMING now requires every sofa line's Seat
         Height + Fabrics (and a venue + salesperson). The wizard deliberately
         collects none of those — its model is "assemble the build, enrich on
         the SO detail" — so it lands a DRAFT the operator completes and
         confirms there (the detail's DRAFT banner). Without this flag the
         create would land CONFIRMED and the server confirm gate would refuse
         every wizard build outright. */
      asDraft: true,
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
            <Sparkles size={11} /> SCM · Sales Order · New
          </div>
          <h1 className="mt-1 font-display text-[21px] font-extrabold tracking-tight text-ink">
            New Sales Order · Guided
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Showroom-floor sofa configurator. Pick customer → model → modules →
            fabric, review, and create. Payments / address are added on the SO
            detail after save.
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

      {/* Stepper */}
      <SoStepper currentStep={step} stepValid={stepValid} onJump={(i) => i <= step && setStep(i)} />

      {/* Validation banner (S5 state) */}
      {showValidation && !stepValid(step) && (
        <ValidationBlock step={step} customer={customer} modelId={modelId} moduleEntries={moduleEntries} />
      )}

      {/* POST error */}
      {postError && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't create the sales order: {postError}
        </div>
      )}

      {/* Body: step content + right summary (stacks on mobile) */}
      <div className="grid gap-4 lg:grid-cols-[1fr_290px]">
        <div className="min-w-0">
          {step === 0 && (
            <StepCustomer
              customer={customer}
              setCustomer={setCustomer}
              showValidation={showValidation}
            />
          )}
          {step === 1 && (
            <StepModel
              models={modelsQ.data ?? []}
              loading={modelsQ.isLoading}
              error={modelsQ.error ? errMsg(modelsQ.error) : null}
              modelId={modelId}
              setModelId={setModelId}
            />
          )}
          {step === 2 && (
            <StepModules
              model={selectedModel}
              skus={skusForModel}
              loading={skusQ.isLoading}
              error={skusQ.error ? errMsg(skusQ.error) : null}
              moduleQty={moduleQty}
              setModuleQty={setModuleQty}
            />
          )}
          {step === 3 && <StepFabric tier={tier} setTier={setTier} />}
          {step === 4 && <StepAddons />}
          {step === 5 && (
            <StepReview
              customer={customer}
              model={selectedModel}
              moduleEntries={moduleEntries}
              skus={skusQ.data ?? []}
              tier={tier}
              note={note}
              setNote={setNote}
              subtotalSen={subtotalSen}
            />
          )}
        </div>

        <SoLiveSummary
          customer={customer}
          model={selectedModel}
          modulePcs={modulePcs}
          tier={tier}
          subtotalSen={subtotalSen}
          step={step}
          isLast={step === STEPS.length - 1}
          submitting={create.isPending}
          onBack={goBack}
          onNext={goNext}
          onSubmit={onSubmit}
        />
      </div>

      {/* Mobile sticky footer — visible only on small screens; the desktop
          summary panel handles back/next on lg+. */}
      <MobileFooter
        subtotalSen={subtotalSen}
        modulePcs={modulePcs}
        step={step}
        isLast={step === STEPS.length - 1}
        submitting={create.isPending}
        onBack={goBack}
        onNext={goNext}
        onSubmit={onSubmit}
      />
    </div>
  );
}

// ── Stepper ─────────────────────────────────────────────────────────────────

function SoStepper({
  currentStep,
  stepValid,
  onJump,
}: {
  currentStep: number;
  stepValid: (s: number) => boolean;
  onJump: (i: number) => void;
}) {
  return (
    <>
      {/* Desktop / tablet horizontal stepper */}
      <ol className="hidden flex-wrap items-center gap-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-stone sm:flex">
        {STEPS.map((label, i) => {
          const isActive = i === currentStep;
          const isDone = i < currentStep;
          const invalid = i < currentStep && !stepValid(i);
          return (
            <li key={label} className="flex flex-1 items-center">
              <button
                type="button"
                onClick={() => onJump(i)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors",
                  i <= currentStep ? "cursor-pointer" : "cursor-default",
                )}
                disabled={i > currentStep}
                aria-current={isActive ? "step" : undefined}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors",
                    isDone && !invalid && "border-primary bg-primary text-white",
                    isActive && "border-primary bg-primary text-white ring-2 ring-primary/30",
                    !isActive && !isDone && "border-border bg-surface text-ink-muted",
                    invalid && "border-err bg-err/10 text-err",
                  )}
                >
                  {isDone && !invalid ? <Check size={12} /> : i + 1}
                </span>
                <span
                  className={cn(
                    "whitespace-nowrap text-[11.5px] font-semibold",
                    isActive ? "text-ink" : "text-ink-muted",
                    invalid && "text-err",
                  )}
                >
                  {label}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <span
                  className={cn(
                    "mx-2 h-px flex-1",
                    i < currentStep ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
      {/* Mobile compact bar */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3 shadow-stone sm:hidden">
        <div className="flex items-center gap-1">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full",
                i <= currentStep ? "bg-primary" : "bg-border",
              )}
            />
          ))}
        </div>
        <div className="text-[11.5px] text-ink-muted">
          Step <span className="font-bold text-primary">{currentStep + 1} / {STEPS.length}</span> ·{" "}
          <span className="font-semibold text-ink">{STEPS[currentStep]}</span>
        </div>
      </div>
    </>
  );
}

// ── Step 0 · Customer ───────────────────────────────────────────────────────

function StepCustomer({
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
    <div className="rounded-xl border border-border bg-surface p-5 shadow-stone sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
        Step 1 · Customer
      </div>
      <h2 className="mt-1 font-display text-[16px] font-extrabold text-ink">
        Who is the order for?
      </h2>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        Type the name to search existing debtors, or type a new name to start a
        walk-in. Phone is required; email is optional.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FieldLabel label="Customer name" required invalid={nameMissing}>
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
              placeholder="Search existing or type new walk-in…"
              className={cn(
                "block w-full rounded-md border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
                nameMissing ? "border-err" : "border-border",
              )}
            />
            <Search size={14} className="pointer-events-none absolute right-2.5 top-2.5 text-ink-muted" />
            {showSuggest && suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-surface shadow-lg">
                {suggestions.slice(0, 8).map((d) => (
                  <button
                    type="button"
                    key={d.debtor_code ?? d.debtor_name ?? Math.random()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applySuggestion(d)}
                    className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-primary-soft"
                  >
                    <div className="font-semibold text-ink">{d.debtor_name}</div>
                    {(d.debtor_code || d.phone) && (
                      <div className="font-money text-[10.5px] text-ink-muted">
                        {[d.debtor_code, d.phone].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {customer.debtorCode && (
            <div className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold text-primary">
              <Check size={11} /> Matched debtor{" "}
              <span className="font-money">{customer.debtorCode}</span>
            </div>
          )}
          {!customer.debtorCode && customer.name.trim().length >= 2 && (
            <div className="mt-1 text-[10.5px] text-ink-muted">
              Walk-in (new customer)
            </div>
          )}
        </FieldLabel>

        <FieldLabel label="Phone" required invalid={phoneMissing}>
          <PhoneInput
            value={customer.phone}
            onChange={(v) => setCustomer({ ...customer, phone: v })}
            className={cn(
              "block w-full rounded-md border bg-surface px-3 py-2 font-money text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20",
              phoneMissing ? "border-err" : "border-border",
            )}
          />
        </FieldLabel>

        <FieldLabel label="Email" hint="Optional">
          <input
            type="email"
            value={customer.email}
            onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
            placeholder="customer@example.com"
            className="block w-full rounded-md border border-border bg-surface px-3 py-2 font-money text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </FieldLabel>
      </div>

      <div className="mt-4 rounded-md border border-border-subtle bg-surface-2 p-3 text-[11px] text-ink-secondary">
        Address, salesperson, venue and other header fields default from your
        profile and can be edited on the SO detail after save.
      </div>
    </div>
  );
}

// ── Step 1 · Model ──────────────────────────────────────────────────────────

function StepModel({
  models,
  loading,
  error,
  modelId,
  setModelId,
}: {
  models: ProductModel[];
  loading: boolean;
  error: string | null;
  modelId: string | null;
  setModelId: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-stone sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
        Step 2 · Sofa model
      </div>
      <h2 className="mt-1 font-display text-[16px] font-extrabold text-ink">
        Which sofa is the customer configuring?
      </h2>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        Active sofa models from the product catalogue. Modules in the next step
        will be filtered to this model.
      </p>

      {loading && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-20 rounded-lg" />
          ))}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't load sofa models: {error}
        </div>
      )}
      {!loading && !error && models.length === 0 && (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-4 text-[12px] text-ink-muted">
          No sofa models in the catalogue yet. Add one from{" "}
          <span className="font-money">Products · Sofa Master</span> first.
        </div>
      )}
      {!loading && !error && models.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {models
            .filter((m) => m.active)
            .map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModelId(m.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-all hover:-translate-y-px hover:shadow-stone",
                  modelId === m.id
                    ? "border-primary bg-primary-soft"
                    : "border-border bg-surface hover:border-primary/40",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-[13px] text-ink">{m.name}</span>
                  {modelId === m.id && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white">
                      <Check size={12} />
                    </span>
                  )}
                </div>
                <div className="mt-1 font-money text-[10.5px] text-accent">{m.model_code}</div>
                {typeof m.sku_count === "number" && (
                  <div className="mt-2 text-[10.5px] text-ink-muted">
                    {m.sku_count} module{m.sku_count === 1 ? "" : "s"}
                  </div>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ── Step 2 · Modules (the hero step) ────────────────────────────────────────

function StepModules({
  model,
  skus,
  loading,
  error,
  moduleQty,
  setModuleQty,
}: {
  model: ProductModel | null;
  skus: MfgProduct[];
  loading: boolean;
  error: string | null;
  moduleQty: Record<string, number>;
  setModuleQty: (next: Record<string, number>) => void;
}) {
  const adjust = (code: string, delta: number) => {
    const cur = moduleQty[code] ?? 0;
    const next = Math.max(0, cur + delta);
    const out = { ...moduleQty };
    if (next === 0) delete out[code];
    else out[code] = next;
    setModuleQty(out);
  };
  const toggle = (code: string) => {
    if ((moduleQty[code] ?? 0) > 0) {
      const out = { ...moduleQty };
      delete out[code];
      setModuleQty(out);
    } else {
      setModuleQty({ ...moduleQty, [code]: 1 });
    }
  };

  const selectedSkus = useMemo(
    () => skus.filter((s) => (moduleQty[s.code] ?? 0) > 0),
    [skus, moduleQty],
  );

  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-stone sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
        Step 3 · Modules
      </div>
      <h2 className="mt-1 font-display text-[16px] font-extrabold text-ink">
        Pick modules for {model?.name ?? "the sofa"}
      </h2>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        Tap to add or remove a module. The top-view preview assembles live and
        the subtotal recomputes. Module-level pricing is indicative; the server
        re-prices any matching combo on save.
      </p>

      {/* Top-view preview */}
      <SofaTopView selected={selectedSkus} />

      {loading && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-lg" />
          ))}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          Couldn't load modules: {error}
        </div>
      )}
      {!loading && !error && skus.length === 0 && (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-4 text-[12px] text-ink-muted">
          This model has no modules registered under it yet. Add SKUs via{" "}
          <span className="font-money">Products · SKU Master</span> with a
          matching <span className="font-money">model_id</span>.
        </div>
      )}
      {!loading && !error && skus.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {skus.map((sku) => {
            const qty = moduleQty[sku.code] ?? 0;
            const selected = qty > 0;
            const priceSen = sku.sell_price_sen ?? sku.base_price_sen ?? 0;
            return (
              <div
                key={sku.code}
                className={cn(
                  "rounded-lg border p-3 transition-all",
                  selected
                    ? "border-primary bg-primary-soft"
                    : "border-border bg-surface hover:border-primary/40",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggle(sku.code)}
                    className="min-w-0 flex-1 text-left"
                  >
                    {/* Description ONCE, code NOT displayed — the shared rule
                        (vendor/shared/line-identity.ts) and the picker precedent
                        (Commander 2026-05-27). The code still BINDS:
                        toggle(sku.code) on this very button. SIZE_LABEL is kept
                        and is not a duplicate — it appears nowhere else on the
                        tile — so its line renders whenever it exists. */}
                    {(() => {
                      const { primary, secondary } = lineIdentity({
                        code: sku.code,
                        description: sku.name,
                        variant: sku.size_label,
                      });
                      return (
                        <>
                          <div className="text-[12.5px] font-bold text-ink">{primary}</div>
                          {secondary && (
                            <div className="font-money text-[10.5px] text-ink-muted">
                              {secondary}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(sku.code)}
                    aria-label={selected ? "Remove module" : "Add module"}
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors",
                      selected ? "border-primary bg-primary text-white" : "border-border-strong text-ink-muted",
                    )}
                  >
                    {selected ? <Check size={11} /> : <Plus size={11} />}
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="font-money text-[12px] font-bold text-primary-ink">
                    {fmtRm(priceSen)}
                  </span>
                  {selected && (
                    <div className="inline-flex items-center overflow-hidden rounded-md border border-border bg-surface">
                      <button
                        type="button"
                        onClick={() => adjust(sku.code, -1)}
                        aria-label="Decrease qty"
                        className="flex h-7 w-7 items-center justify-center bg-surface-2 text-ink-secondary hover:bg-surface-dim"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="w-6 text-center font-money text-[12px] font-bold text-ink">
                        {qty}
                      </span>
                      <button
                        type="button"
                        onClick={() => adjust(sku.code, +1)}
                        aria-label="Increase qty"
                        className="flex h-7 w-7 items-center justify-center bg-primary text-white hover:bg-primary-ink"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SofaTopView({ selected }: { selected: MfgProduct[] }) {
  // Render one colored block per qty unit. Petrol shades for regular modules;
  // brass-bright for any module whose code/name hints at "recliner" so the eye
  // can pick out the special pieces (matches the design's recliner accent).
  const blocks = selected.flatMap((sku) => {
    const qty = sku.sell_price_sen ?? sku.base_price_sen ? 1 : 1; // dummy; replaced below
    void qty;
    return Array.from({ length: 1 }).map(() => sku); // we want one block per qty in caller — use flat below
  });
  void blocks;
  // The above is unused — we instead expand directly:
  const expanded: MfgProduct[] = [];
  for (const sku of selected) {
    // We don't have qty here; selected is the unique SKU list. Caller would have
    // to thread qty in for accurate stacking. For v1 the preview shows ONE block
    // per selected module — it's a visual cue, not an accounting tool.
    expanded.push(sku);
  }
  const colorFor = (sku: MfgProduct, i: number): string => {
    const txt = `${sku.code} ${sku.name}`.toLowerCase();
    if (/(recliner|power|motor)/.test(txt)) return "bg-accent-bright";
    if (/(corner|chaise|c\b)/.test(txt)) return "bg-primary-ink";
    return i % 2 === 0 ? "bg-primary" : "bg-primary/85";
  };
  return (
    <div className="mt-4 flex min-h-[96px] items-end justify-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-surface-2 p-4">
      {expanded.length === 0 ? (
        <span className="text-[11px] italic text-ink-muted">
          Top-view preview will appear here as you pick modules
        </span>
      ) : (
        expanded.map((sku, i) => (
          <div
            key={sku.code}
            title={sku.name}
            className={cn("rounded-[3px]", colorFor(sku, i))}
            style={{
              width: 36 + (i % 3) * 8,
              height: 48 + ((i + 1) % 2) * 8,
            }}
          />
        ))
      )}
    </div>
  );
}

// ── Step 3 · Fabric tier ────────────────────────────────────────────────────

function StepFabric({ tier, setTier }: { tier: Tier; setTier: (t: Tier) => void }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-stone sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
        Step 4 · Fabric tier
      </div>
      <h2 className="mt-1 font-display text-[16px] font-extrabold text-ink">
        Pick a price tier
      </h2>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        Tier drives the combo-pricing lookup. The specific fabric series and
        colour are picked on the SO detail (where the full fabric library and
        swatches live).
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {(Object.keys(TIER_LABELS) as Tier[]).map((t) => {
          const isOn = tier === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTier(t)}
              className={cn(
                "rounded-lg border p-4 text-left transition-all hover:-translate-y-px",
                isOn
                  ? "border-primary bg-primary-soft shadow-stone"
                  : "border-border bg-surface hover:border-primary/40",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-[14px] font-extrabold text-ink">
                  {TIER_LABELS[t].short}
                </span>
                {isOn && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white">
                    <Check size={12} />
                  </span>
                )}
              </div>
              <div className="mt-1 font-money text-[10.5px] text-ink-muted">
                {TIER_LABELS[t].long}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 4 · Add-ons (intentional pass-through) ─────────────────────────────

function StepAddons() {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-stone sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
        Step 5 · Add-ons
      </div>
      <h2 className="mt-1 font-display text-[16px] font-extrabold text-ink">
        No add-ons in the guided flow
      </h2>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        PWP discounts, free gifts and special add-ons live on the SO detail
        where the full rule engine is available. Add them after save.
      </p>
      <div className="mt-4 rounded-md border border-primary/30 bg-primary-soft px-4 py-3 text-[12px] text-primary-ink">
        Tip: tap <span className="font-semibold">Next</span> to continue to
        Review — you'll be redirected to the SO detail after save where add-ons
        can be applied with the full PWP picker.
      </div>
    </div>
  );
}

// ── Step 5 · Review ─────────────────────────────────────────────────────────

function StepReview({
  customer,
  model,
  moduleEntries,
  skus,
  tier,
  note,
  setNote,
  subtotalSen,
}: {
  customer: Customer;
  model: ProductModel | null;
  moduleEntries: Array<[string, number]>;
  skus: MfgProduct[];
  tier: Tier;
  note: string;
  setNote: (s: string) => void;
  subtotalSen: number;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface p-5 shadow-stone sm:p-6">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
          Step 6 · Review
        </div>
        <h2 className="mt-1 font-display text-[16px] font-extrabold text-ink">
          Confirm and create the sales order
        </h2>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          On save, you'll be taken to the SO detail where payments, address and
          add-ons can be filled in.
        </p>

        <dl className="mt-4 space-y-3 text-[12.5px]">
          <ReviewRow
            label="Customer"
            value={
              <>
                <div className="font-semibold text-ink">{customer.name}</div>
                <div className="font-money text-[11px] text-ink-muted">
                  {[customer.debtorCode, customer.phone, customer.email]
                    .filter(Boolean)
                    .join(" · ") || "walk-in"}
                </div>
              </>
            }
          />
          <ReviewRow
            label="Model"
            value={
              <div className="text-ink">
                {model?.name}{" "}
                <span className="font-money text-[11px] text-ink-muted">
                  {model?.model_code}
                </span>
              </div>
            }
          />
          <ReviewRow
            label="Fabric tier"
            value={<span className="text-ink">{TIER_LABELS[tier].long}</span>}
          />
          <ReviewRow
            label="Modules"
            value={
              <ul className="space-y-1">
                {moduleEntries.map(([code, qty]) => {
                  const sku = skus.find((s) => s.code === code);
                  const priceSen = sku?.sell_price_sen ?? sku?.base_price_sen ?? 0;
                  return (
                    <li
                      key={code}
                      className="flex items-center justify-between gap-3 text-[12px]"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-ink">{sku?.name ?? code}</span>{" "}
                        <span className="font-money text-[10.5px] text-ink-muted">
                          {code} · ×{qty}
                        </span>
                      </span>
                      <span className="shrink-0 font-money text-ink">
                        {fmtRm(priceSen * qty)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            }
          />
        </dl>

        <div className="mt-5">
          <FieldLabel label="Note" hint="Optional · shown on the SO detail">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything the back office should know about this order…"
              className="block w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </FieldLabel>
        </div>

        <div className="mt-4 flex items-baseline justify-between rounded-lg border border-primary/30 bg-primary-soft px-4 py-3">
          <span className="text-[11.5px] font-semibold uppercase tracking-brand text-primary">
            Indicative subtotal
          </span>
          <span className="font-money text-[20px] font-extrabold text-primary-ink">
            {fmtRm(subtotalSen)}
          </span>
        </div>
        <p className="mt-1 text-[10.5px] text-ink-muted">
          Server re-prices any matching sofa combo on save.
        </p>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 border-b border-border-subtle pb-3 last:border-b-0 last:pb-0">
      <dt className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

// ── Live summary side panel (desktop) ───────────────────────────────────────

function SoLiveSummary({
  customer,
  model,
  modulePcs,
  tier,
  subtotalSen,
  step,
  isLast,
  submitting,
  onBack,
  onNext,
  onSubmit,
}: {
  customer: Customer;
  model: ProductModel | null;
  modulePcs: number;
  tier: Tier;
  subtotalSen: number;
  step: number;
  isLast: boolean;
  submitting: boolean;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
}) {
  return (
    <aside className="hidden self-start rounded-xl border border-border bg-surface p-4 shadow-stone lg:block">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Live summary
      </div>
      <dl className="mt-3 space-y-2 text-[12px]">
        <SummaryRow label="Customer" value={customer.name || "—"} />
        <SummaryRow label="Model" value={model?.name ?? "—"} />
        <SummaryRow
          label="Modules"
          value={
            modulePcs > 0 ? (
              <span className="font-semibold text-primary">{modulePcs} pc{modulePcs === 1 ? "" : "s"}</span>
            ) : (
              <span className="text-ink-muted">—</span>
            )
          }
        />
        <SummaryRow label="Fabric tier" value={TIER_LABELS[tier].short} />
      </dl>
      <div className="my-3 h-px bg-border-subtle" />
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-ink-muted">Subtotal</span>
        <span className="font-money text-[18px] font-extrabold text-primary-ink">
          {fmtRm(subtotalSen)}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-ink-muted">
        Fabric / add-ons applied later
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          onClick={onBack}
          disabled={step === 0 || submitting}
          icon={<ChevronLeft size={14} />}
        >
          Back
        </Button>
        {isLast ? (
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={submitting}
            icon={submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          >
            {submitting ? "Saving…" : "Save draft SO"}
          </Button>
        ) : (
          <Button variant="primary" onClick={onNext} disabled={submitting}>
            Next{" "}
            <ChevronRight size={14} />
          </Button>
        )}
      </div>
    </aside>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-ink">{value}</dd>
    </div>
  );
}

// ── Mobile sticky footer ────────────────────────────────────────────────────

function MobileFooter({
  subtotalSen,
  modulePcs,
  step,
  isLast,
  submitting,
  onBack,
  onNext,
  onSubmit,
}: {
  subtotalSen: number;
  modulePcs: number;
  step: number;
  isLast: boolean;
  submitting: boolean;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-4 border-t border-border bg-surface px-4 py-3 shadow-[0_-4px_18px_-8px_rgba(17,24,16,.12)] lg:hidden">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] text-ink-muted">
          Subtotal · {modulePcs} pc{modulePcs === 1 ? "" : "s"}
        </span>
        <span className="font-money text-[16px] font-extrabold text-primary-ink">
          {fmtRm(subtotalSen)}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button
          variant="secondary"
          onClick={onBack}
          disabled={step === 0 || submitting}
          icon={<ChevronLeft size={14} />}
        >
          Back
        </Button>
        {isLast ? (
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={submitting}
            icon={submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          >
            {submitting ? "Saving…" : "Save draft SO"}
          </Button>
        ) : (
          <Button variant="primary" onClick={onNext} disabled={submitting}>
            Next <ChevronRight size={14} />
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Validation block (S5 state) ─────────────────────────────────────────────

function ValidationBlock({
  step,
  customer,
  modelId,
  moduleEntries,
}: {
  step: number;
  customer: Customer;
  modelId: string | null;
  moduleEntries: Array<[string, number]>;
}) {
  const missing: string[] = [];
  if (step === 0) {
    if (!customer.name.trim()) missing.push("Customer name");
    if (!customer.phone.trim()) missing.push("Phone");
  } else if (step === 1) {
    if (!modelId) missing.push("Sofa model");
  } else if (step === 2) {
    if (moduleEntries.length === 0) missing.push("At least one module");
  }
  return (
    <div className="rounded-lg border border-err/40 bg-err/5 px-4 py-3 text-[12px] text-err">
      <div className="flex items-start gap-2">
        <X size={14} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold">
            Complete this step first — required: {missing.join(", ")}
          </div>
          <div className="mt-0.5 text-[11px] opacity-90">
            Fill the highlighted fields to continue to{" "}
            <span className="font-semibold">{STEPS[step + 1] ?? "the next step"}</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Reusable field label ────────────────────────────────────────────────────

function FieldLabel({
  label,
  required,
  invalid,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  invalid?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
        {required && <span className="ml-1 text-err">*</span>}
        {hint && !required && (
          <span className="ml-1.5 normal-case tracking-normal text-ink-muted/80">
            · {hint}
          </span>
        )}
      </span>
      <div className="mt-1.5">{children}</div>
      {invalid && (
        <div className="mt-1 text-[10.5px] font-semibold text-err">Required</div>
      )}
    </label>
  );
}
