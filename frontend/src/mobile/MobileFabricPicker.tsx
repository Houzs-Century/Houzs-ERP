import { useMemo, useState } from "react";
import { useDebouncedValue } from "../vendor/scm/lib/hooks";
import { useFabricColoursSearch, type FabricColourRow } from "../vendor/scm/lib/fabric-queries";
import { useModelAllowedOptionsByCode } from "../vendor/scm/lib/mfg-products-queries";
import { fabricAllowedByPool } from "../vendor/shared/fabric-pool";

/* MobileFabricPicker — the phone's server-typeahead fabric sheet (owner #1
   scaling pain 2026-07-14), moved out of MobileNewSO. The search box drives
   useFabricColoursSearch (GET /fabric-colours?q=…, capped 50 server-side) and
   fires only at >= 2 typed chars, debounced — the same logic layer as the
   desktop FabricColourCombobox.

   THE MODEL'S FABRIC POOL IS APPLIED HERE, as it is on the desktop. The sheet
   used to list every search hit, so a colour the Model does not enable could be
   picked and was refused on save as variant_not_allowed (docs/bugs/0889). The
   question is asked through vendor/shared/fabric-pool.ts, the module the save
   gate itself reads, so offered and accepted are one answer. The pool comes
   from the SAME by-code query the line card already made, so opening the sheet
   costs no request. The picked value lives on the SO line (FabricField shows
   it), so a saved line still renders its fabric whatever this sheet lists. */
export function MobileFabricPicker({ itemCode, fabricSeries, current, onPick, onClose }: {
  itemCode: string;
  fabricSeries: Map<string, string>;
  current: string;
  onPick: (c: FabricColourRow) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 200);
  const trimmed = debounced.trim();
  const coloursQ = useFabricColoursSearch(trimmed, { enabled: trimmed.length >= 2, itemCode: itemCode || null });
  const allowQ = useModelAllowedOptionsByCode(itemCode || undefined);
  const pool = allowQ.data?.fabrics ?? null;
  const rows = useMemo(
    () => (coloursQ.data ?? []).filter((c) => fabricAllowedByPool(pool, c.colourId, c.fabricId)).slice(0, 50),
    [coloursQ.data, pool],
  );
  const anyHit = (coloursQ.data?.length ?? 0) > 0;

  return (
    <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="sheet-head">
          <div>
            <div className="ey" style={{ color: "#a16a2e" }}>Fabric</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Pick a fabric / colour</div>
          </div>
          <button className="sheet-x" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div style={{ padding: "0 14px 10px", flex: "none" }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type 2+ chars — fabric code or colour" autoFocus />
          </div>
        </div>

        <div className="sheet-scroll" style={{ gap: 7 }}>
          {rows.length === 0 ? (
            <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "28px 0" }}>
              {trimmed.length < 2
                ? "Type at least 2 characters to search…"
                : coloursQ.isFetching
                  ? "Searching…"
                  : anyHit
                    ? `Fabrics match "${trimmed}", but none is enabled for this model.`
                    : `No fabrics match "${trimmed}".`}
            </div>
          ) : (
            rows.map((c) => {
              const on = c.colourId === current;
              const series = fabricSeries.get(c.fabricId) ?? "";
              return (
                <button
                  key={c.colourId}
                  type="button"
                  onClick={() => { onPick(c); onClose(); }}
                  style={{
                    textAlign: "left", width: "100%", boxSizing: "border-box",
                    border: on ? "1px solid #16695f" : "1px solid rgba(34,31,32,.12)",
                    background: on ? "#e1efed" : "#fff",
                    borderRadius: 11, padding: "10px 12px", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  {c.swatchHex && (
                    <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: c.swatchHex, border: "1px solid rgba(34,31,32,.15)" }} />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: "#11140f" }}>{c.colourId}</span>
                    {(c.label || series) && (
                      <span style={{ display: "block", fontSize: 10.5, color: "#767b6e", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[series, c.label].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  {on && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M20 6 9 17l-5-5" /></svg>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
