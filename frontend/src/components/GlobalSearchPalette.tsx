import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import {
  Search,
  X,
  Wrench,
  Users,
  Layers,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  FileText,
  Package,
  ShoppingCart,
  PackageCheck,
  Truck,
  ReceiptText,
  Receipt,
} from "lucide-react";
import { cn, formatDate } from "../lib/utils";
import { HighlightedText } from "../lib/highlight";
import {
  GLOBAL_SEARCH_MIN_LENGTH,
  searchHitStatus,
  useGlobalSearchResults,
  useSearchStatusVocabulary,
  type SearchHit,
  type SearchHitType,
} from "../lib/globalSearch";

// The Cmd+K overlay, split from GlobalSearch.tsx (the provider + trigger the
// shell always loads) so the shell's initial bundle does not carry it: it is
// fetched right after first paint and is in hand long before a person opens it.
// ── Palette overlay ──────────────────────────────────────────

export function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const { term, hits, loading, error, degradedNotice } = useGlobalSearchResults(q);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const navigate = useNavigate();

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => {
      const previous = restoreFocusRef.current;
      if (previous?.isConnected) previous.focus();
    });
  }, [onClose]);

  // Focus the input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A new term must never retain the prior term's keyboard selection.
  useEffect(() => {
    setSelected(0);
  }, [term]);

  // Visual grouping is also the canonical keyboard order.
  const groups = useMemo(() => groupHits(hits), [hits]);
  const orderedHits = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  // Esc / arrows / enter
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (e.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((element) => element.getAttribute("aria-hidden") !== "true");
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (orderedHits.length > 0) {
          setSelected((s) => Math.min(orderedHits.length - 1, s + 1));
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (e.key === "Enter") {
        // Native buttons handle their own Enter activation. Letting the event
        // bubble into the palette handler would also open the keyboard-selected
        // row (for example when the Close button has focus).
        if (e.target !== inputRef.current) return;
        e.preventDefault();
        const hit = selected >= 0 ? orderedHits.at(selected) : undefined;
        if (hit) {
          navigate(hit.link);
          closeAndRestoreFocus();
        }
      }
    },
    [orderedHits, selected, navigate, closeAndRestoreFocus]
  );

  // Keep the selected row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-ink/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={closeAndRestoreFocus}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-[640px] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-ink/20"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
      >
        {/* Search input row */}
        <div className="group flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <Search
            size={16}
            className="shrink-0 text-ink-muted transition-colors duration-fast group-focus-within:text-primary"
          />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search orders, projects, service cases, products, people…"
            aria-label="Search orders, projects, service cases, products and people"
            aria-controls="global-search-results"
            aria-expanded={orderedHits.length > 0}
            aria-activedescendant={
              orderedHits[selected] ? `global-search-option-${orderedHits[selected]._idx}` : undefined
            }
            aria-autocomplete="list"
            className="flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted"
          />
          <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink-muted sm:inline">
            Esc
          </kbd>
          <button
            onClick={closeAndRestoreFocus}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-bg/60 hover:text-ink sm:-mr-1 sm:h-8 sm:w-8"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="max-h-[60vh] overflow-y-auto"
        >
          {term.length === 0 && <EmptyHelp />}
          {term.length > 0 && term.length < GLOBAL_SEARCH_MIN_LENGTH && (
            <div role="status" aria-live="polite" className="px-4 py-8 text-center text-[12px] text-ink-muted">
              Type 1 more character to search everywhere.
            </div>
          )}
          {term.length >= GLOBAL_SEARCH_MIN_LENGTH && loading && (
            <div role="status" aria-live="polite" className="px-4 py-6 text-center text-[12px] text-ink-muted">
              Searching for “{term}”…
            </div>
          )}
          {error && (
            <div role="alert" className="m-3 rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-err">
              Search failed: {error}
            </div>
          )}
          {degradedNotice && !error && (
            <div role="alert" className="m-3 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-ink">
              {degradedNotice}
            </div>
          )}
          {term.length >= GLOBAL_SEARCH_MIN_LENGTH && !loading && hits.length === 0 && !error && (
            <div role="status" aria-live="polite" className="flex flex-col items-center gap-1 px-4 py-10 text-center">
              <Search size={20} className="text-ink-muted" />
              {/* Never claim absence when a source went unread — degradedNotice
                  above already says so, and this copy must not contradict it. */}
              <div className="text-[12.5px] text-ink">
                {degradedNotice ? `No matches found for “${term}” in what could be searched.` : `No matches for “${term}”.`}
              </div>
              <div className="text-[10.5px] text-ink-muted">Try a different keyword.</div>
            </div>
          )}
          {hits.length > 0 &&
            groups.map((g) => (
              <div key={g.type} role="group" aria-label={TYPE_META[g.type].label}>
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-subtle bg-bg/80 px-4 py-1.5 backdrop-blur-sm">
                  <span className="text-primary-ink">{TYPE_META[g.type].icon}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-primary-ink">
                    {TYPE_META[g.type].label}
                  </span>
                  <span className="text-[10px] text-ink-muted">· {g.items.length}</span>
                </div>
                {g.items.map((item) => (
                  <HitRow
                    key={`${item.type}-${item.id}`}
                    item={item}
                    query={term}
                    isSelected={item._idx === selected}
                    onHover={() => setSelected(item._idx)}
                    onSelect={() => {
                      navigate(item.link);
                      closeAndRestoreFocus();
                    }}
                  />
                ))}
              </div>
            ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-bg/50 px-4 py-2 text-[10px] text-ink-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-surface px-1 py-px font-mono text-[9px]">
                <ArrowUp size={9} className="inline" />
                <ArrowDown size={9} className="inline" />
              </kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-surface px-1 py-px font-mono text-[9px]">
                <CornerDownLeft size={9} className="inline" />
              </kbd>
              open
            </span>
          </div>
          <div>{hits.length} result{hits.length === 1 ? "" : "s"}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}

const HIGHLIGHT_CLASS =
  "rounded-[3px] bg-primary/[.12] px-px font-semibold text-primary-ink";

function HitRow({
  item,
  query,
  isSelected,
  onHover,
  onSelect,
}: {
  item: SearchHit & { _idx: number };
  query: string;
  isSelected: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const meta = TYPE_META[item.type];
  const vocab = useSearchStatusVocabulary();
  const status = searchHitStatus(item, vocab);
  return (
    <button
      id={`global-search-option-${item._idx}`}
      role="option"
      aria-selected={isSelected}
      data-idx={item._idx}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 border-l-2 border-transparent px-4 py-2.5 text-left transition-colors",
        isSelected
          ? "border-primary bg-primary/[.07]"
          : "hover:bg-primary/[.04]"
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg",
          meta.tile
        )}
      >
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {/* Bold the matched keyword in the title (query passed from palette). */}
          <span className="truncate text-[12.5px] font-medium text-ink">
            <HighlightedText text={item.title} query={query} className={HIGHLIGHT_CLASS} />
          </span>
          {status && (
            <span
              className="shrink-0 rounded px-1.5 py-px text-[10px] font-semibold"
              style={{ background: status.bg, color: status.fg }}
            >
              {status.label}
            </span>
          )}
          {item.date && (
            <span className="shrink-0 text-[10px] text-ink-muted">
              {formatDate(item.date)}
            </span>
          )}
        </div>
        {item.subtitle && (
          <div className="truncate text-[11px] text-ink-secondary">
            <HighlightedText text={item.subtitle} query={query} className={HIGHLIGHT_CLASS} />
          </div>
        )}
      </div>
      {isSelected && (
        <CornerDownLeft size={11} className="mt-1 shrink-0 text-primary" />
      )}
    </button>
  );
}

function EmptyHelp() {
  return (
    <div className="px-4 py-6">
      <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-ink-muted">
        What you can search
      </div>
      <ul className="space-y-1.5 text-[12px] text-ink-secondary">
        <li className="flex items-center gap-2">
          <FileText size={12} className="text-primary/70" />
          Sales orders by SO no, customer, phone, PO, or ref
        </li>
        <li className="flex items-center gap-2">
          <Truck size={12} className="text-primary/70" />
          Purchase orders, GRNs, Delivery orders, Invoices by doc no, party, or ref
        </li>
        <li className="flex items-center gap-2">
          <ReceiptText size={12} className="text-primary/70" />
          Suppliers, customers, credit notes, receipts, delivery returns and payment vouchers, where you have access
        </li>
        <li className="flex items-center gap-2">
          <Layers size={12} className="text-primary/70" />
          Projects by code, name, venue, organizer, or brand
        </li>
        <li className="flex items-center gap-2">
          <Wrench size={12} className="text-primary/70" />
          Service cases by ASSR no, customer, phone, or issue
        </li>
        <li className="flex items-center gap-2">
          <Package size={12} className="text-primary/70" />
          Products by code or name
        </li>
        <li className="flex items-center gap-2">
          <Users size={12} className="text-primary/70" />
          Teammates by name, email, or role
        </li>
      </ul>
    </div>
  );
}

// Group hits in the same order users see and keyboard navigation follows.
function groupHits(hits: SearchHit[]): Array<{
  type: SearchHitType;
  items: Array<SearchHit & { _idx: number }>;
}> {
  const order: SearchHitType[] = [
    "sales_order",
    "purchase_order",
    "grn",
    "delivery_order",
    "sales_invoice",
    "purchase_invoice",
    "credit_note",
    "receipt",
    "payment_voucher",
    "delivery_return",
    "supplier",
    "customer",
    "project",
    "assr_case",
    "product",
    "user",
  ];
  const map = new Map<SearchHitType, SearchHit[]>();
  hits.forEach((h) => {
    const arr = map.get(h.type) ?? [];
    arr.push(h);
    map.set(h.type, arr);
  });
  const out: Array<{ type: SearchHitType; items: Array<SearchHit & { _idx: number }> }> = [];
  let nextIndex = 0;
  for (const t of order) {
    const items = map.get(t);
    if (items && items.length > 0) {
      out.push({
        type: t,
        items: items.map((item) => ({
          ...item,
          _idx: nextIndex++,
        })),
      });
    }
  }
  return out;
}

// Nico 2026-07-13 (GlobalSearch Theme C handoff) — each result type gets a
// coloured 26×26 icon tile so the palette scans by type at a glance. Hex
// literals are the exact Theme C secondary swatches from vendor/design-system/
// tokens.css (--c-secondary-a forest, --c-secondary-b blue, --c-warn amber).
// `learning` is already registered as #1F3A8A in tailwind.config.js so the
// project + product tiles share that blue via its opacity variants.
const TYPE_META: Record<
  SearchHitType,
  { label: string; icon: ReactNode; tile: string }
> = {
  sales_order: {
    label: "Sales Orders",
    icon: <FileText size={13} />,
    tile: "bg-primary/[.12] text-primary",
  },
  purchase_order: {
    label: "Purchase Orders",
    icon: <ShoppingCart size={13} />,
    tile: "bg-[#B76B00]/[.14] text-[#B76B00]",
  },
  grn: {
    label: "GRNs",
    icon: <PackageCheck size={13} />,
    tile: "bg-[#2F5D4F]/[.14] text-[#2F5D4F]",
  },
  delivery_order: {
    label: "Delivery Orders",
    icon: <Truck size={13} />,
    tile: "bg-primary/[.12] text-primary",
  },
  sales_invoice: {
    label: "Sales Invoices",
    icon: <ReceiptText size={13} />,
    tile: "bg-primary/[.12] text-primary",
  },
  purchase_invoice: {
    label: "Purchase Invoices",
    icon: <Receipt size={13} />,
    tile: "bg-[#B76B00]/[.14] text-[#B76B00]",
  },
  project: {
    label: "Projects",
    icon: <Layers size={13} />,
    tile: "bg-learning/[.12] text-learning",
  },
  assr_case: {
    label: "Service Cases",
    icon: <Wrench size={13} />,
    tile: "bg-[#B76B00]/[.14] text-[#B76B00]",
  },
  product: {
    label: "Products",
    icon: <Package size={13} />,
    tile: "bg-learning/[.12] text-learning",
  },
  user: {
    label: "Users",
    icon: <Users size={13} />,
    tile: "bg-[#2F5D4F]/[.14] text-[#2F5D4F]",
  },
  supplier: {
    label: "Suppliers",
    icon: <ShoppingCart size={13} />,
    tile: "bg-[#B76B00]/[.14] text-[#B76B00]",
  },
  customer: {
    label: "Customers",
    icon: <Users size={13} />,
    tile: "bg-primary/[.12] text-primary",
  },
  credit_note: {
    label: "Credit / Debit Notes",
    icon: <FileText size={13} />,
    tile: "bg-primary/[.12] text-primary",
  },
  receipt: {
    label: "Receipts",
    icon: <Receipt size={13} />,
    tile: "bg-[#2F5D4F]/[.14] text-[#2F5D4F]",
  },
  delivery_return: {
    label: "Delivery Returns",
    icon: <Truck size={13} />,
    tile: "bg-primary/[.12] text-primary",
  },
  payment_voucher: {
    label: "Payment Vouchers",
    icon: <ReceiptText size={13} />,
    tile: "bg-[#B76B00]/[.14] text-[#B76B00]",
  },
};

