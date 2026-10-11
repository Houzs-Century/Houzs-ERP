import { useEffect, useMemo, useState } from "react";
import { useMfgProducts, type MfgCategory, type MfgProductRow } from "../vendor/scm/lib/mfg-products-queries";
import "./mobile.css";

/* Perf cap (parity with SalesOrderNewFromProducts, PR #342) — never render more
   than this many rows at once. The full active catalog is ~1141 SKUs; painting
   every one as a bottom-sheet button froze the sheet on open + on each keystroke.
   Beyond the cap a hint tells the operator to narrow by search / category. */
const RENDER_CAP = 60;

/* ---------------------------------------------------------------------------
 * MobileSkuPicker — searchable bottom-sheet SKU catalog picker for the mobile
 * Sales Order line editor. Queries the REAL catalog through
 * useMfgProducts({ category, search }) (GET /mfg-products), so a tapped row
 * seeds the line with a genuine item_code + item_group + name (+ the catalog
 * selling price, which still BINDS on tap to default the line's unit price —
 * it is just no longer displayed here; Owner 2026-07-16: "amount 不需要").
 * The server recomputes the honest price on save — this picker never asserts
 * a price.
 *
 * Category is a FILTER chip row inside the sheet (never a mandatory pre-select
 * that blocks item selection): "All" shows every SKU, tapping a chip narrows
 * the list. Presentation reuses the app's bottom-sheet chrome (.sheet-bd /
 * .sheet / .grab / .sheet-head / .sheet-x / .sheet-scroll) + .searchbar /
 * .chips / .chip classes from mobile.css.
 * ------------------------------------------------------------------------- */

/* The line's category axis maps 1:1 to a catalog category. "" (General item)
   shows every SKU with no category filter. */
export type SkuPickerCat = "" | "sofa" | "bedframe";

const CAT_CHIPS: Array<{ value: MfgCategory | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "BEDFRAME", label: "Bedframe" },
  { value: "SOFA", label: "Sofa" },
  { value: "MATTRESS", label: "Mattress" },
  { value: "ACCESSORY", label: "Accessory" },
];

/** What a picked SKU hands back to the line: the canonical catalog code, the
 *  lowercase item_group the backend variant rule reads, the display name, and
 *  the catalog SELLING price in centi (defaults the line's unit price; the
 *  server recompute stays authoritative on save). */
export type PickedSku = {
  itemCode: string;
  itemGroup: string;
  name: string;
  unitPriceCenti: number;
  category: MfgCategory;
};

export function MobileSkuPicker({
  initialCat,
  onPick,
  onPickMany,
  onClose,
}: {
  /* The line's current category seeds the sheet's default chip so a bedframe
     line opens pre-filtered to bedframes — but the operator can switch to
     "All" or any other chip, so it never BLOCKS selecting another category. */
  initialCat?: SkuPickerCat;
  onPick: (sku: PickedSku) => void;
  /* Optional multi-select. When provided, rows become toggleable and a footer
     "Add N products" button hands back every selected SKU at once. When absent,
     the sheet keeps the single-tap-to-add behaviour (back-compat). */
  onPickMany?: (skus: PickedSku[]) => void;
  onClose: () => void;
}) {
  const multi = typeof onPickMany === "function";
  const seedCat: MfgCategory | "" =
    initialCat === "sofa" ? "SOFA" : initialCat === "bedframe" ? "BEDFRAME" : "";
  const [cat, setCat] = useState<MfgCategory | "">(seedCat);
  /* Search is DEBOUNCED (PR #342 parity) — `searchInput` is the live text box;
     only after a 250ms idle does it commit to `search`, the value that drives the
     server query. Without this every keystroke refetched the whole catalog and
     repainted the sheet, freezing the input while typing. */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput !== search) setSearch(searchInput);
    }, 250);
    return () => window.clearTimeout(t);
  }, [searchInput, search]);
  /* Multi-select order-preserving pick list (keyed by catalog id → the picked
     SKU) so "Add N products" hands back selections in the order tapped. */
  const [picked, setPicked] = useState<Array<{ id: string; sku: PickedSku }>>([]);

  // The catalog read. Category "" omits the filter; search is a server-side
  // code/name match (GET /mfg-products?category=&search=).
  //
  // Server-typeahead gate (owner #1 scaling pain, 2026-07-14) — the "All / no
  // search" read used to pull the WHOLE ~1141-SKU catalog on every open. It is
  // now bounded: the query only fires once the operator has typed >= 2 chars OR
  // narrowed to a category chip (a category-scoped read is bounded to that
  // category). Below the gate we show a prompt instead of fetching everything.
  const trimmedSearch = search.trim();
  const gateOpen = trimmedSearch.length >= 2 || cat !== "";
  const productsQ = useMfgProducts({
    category: cat || undefined,
    search: trimmedSearch || undefined,
    enabled: gateOpen,
  });

  const rows = useMemo<MfgProductRow[]>(
    () => (productsQ.data ?? []).filter((p) => p.status !== "INACTIVE"),
    [productsQ.data],
  );
  // Cap the DOM to RENDER_CAP rows so an "All / no search" set can't freeze the
  // sheet; the hint below tells the operator to narrow when rows are hidden.
  const shown = useMemo(() => rows.slice(0, RENDER_CAP), [rows]);
  const hiddenCount = rows.length - shown.length;

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Catalog</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Pick a product</div>
          </div>
          <button className="sheet-x" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div style={{ padding: "0 14px 10px", display: "flex", flexDirection: "column", gap: 9, flex: "none" }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search code or name"
              autoFocus
            />
          </div>
          <div className="chips">
            {CAT_CHIPS.map((c) => (
              <button
                key={c.value || "all"}
                className={`chip${cat === c.value ? " on" : ""}`}
                onClick={() => setCat(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="sheet-scroll" style={{ gap: 7 }}>
          {!gateOpen ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>Type at least 2 characters, or pick a category, to browse the catalog.</div>
          ) : productsQ.isLoading ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>Loading catalog{"…"}</div>
          ) : productsQ.isError ? (
            <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "28px 0" }}>Couldn{"’"}t load the catalog. Pull down and try again.</div>
          ) : rows.length === 0 ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>No products match{search.trim() ? ` "${search.trim()}"` : ""}.</div>
          ) : (
            <>
            {shown.map((p) => {
              const skuOf = (): PickedSku => ({
                itemCode: p.code,
                itemGroup: p.category.toLowerCase(),
                name: p.name,
                unitPriceCenti: p.sell_price_sen ?? 0,
                category: p.category,
              });
              const isOn = multi && picked.some((x) => x.id === p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    if (multi) {
                      // Toggle this row in/out of the running selection.
                      setPicked((prev) =>
                        prev.some((x) => x.id === p.id)
                          ? prev.filter((x) => x.id !== p.id)
                          : [...prev, { id: p.id, sku: skuOf() }],
                      );
                      return;
                    }
                    onPick(skuOf());
                    onClose();
                  }}
                  style={{
                    textAlign: "left", width: "100%", boxSizing: "border-box",
                    border: `1px solid ${isOn ? "#0c3f39" : "rgba(34,31,32,.12)"}`, borderRadius: 11,
                    background: isOn ? "#f0f6f2" : "#fff",
                    padding: "10px 12px", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  {multi && (
                    <span
                      aria-hidden
                      style={{
                        flex: "none", width: 18, height: 18, borderRadius: 5,
                        border: `1.6px solid ${isOn ? "#0c3f39" : "rgba(34,31,32,.28)"}`,
                        background: isOn ? "#0c3f39" : "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      {isOn && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
                      )}
                    </span>
                  )}
                  {/* Description only — desktop parity (SoLineCard picker rows,
                      Commander 2026-05-27: "picker rows show description only —
                      one scannable line per SKU. The code still binds on click").
                      Owner 2026-07-16: mobile still stacked a redundant
                      "<code> · <CATEGORY>" line under the name and squeezed the
                      name into a nowrap/ellipsis column. The name now takes the
                      row's full width and WRAPS instead of truncating; category
                      stays available as the chip filter above. skuOf() still
                      binds p.code / p.category on tap — display-only change. */}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: "#11140f", overflowWrap: "anywhere" }}>{p.name}</span>
                </button>
              );
            })}
            {hiddenCount > 0 && (
              <div style={{ textAlign: "center", color: "#9aa093", fontSize: 11, padding: "10px 0 4px" }}>
                Showing the first {RENDER_CAP} of {rows.length} products — narrow by search or category.
              </div>
            )}
            </>
          )}
        </div>

        {multi && (
          <div className="sheet-foot">
            <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: picked.length ? "#11140f" : "#9aa093" }}>
              {picked.length} selected
            </span>
            <button
              type="button"
              className="btn"
              disabled={picked.length === 0}
              onClick={() => {
                if (picked.length === 0) return;
                onPickMany?.(picked.map((x) => x.sku));
                onClose();
              }}
              style={{ flex: "none", opacity: picked.length === 0 ? 0.5 : 1, padding: "10px 16px" }}
            >
              {picked.length <= 1 ? "Add product" : `Add ${picked.length} products`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
