/* ------------------------------------------------------------------------- *
 * MobileRacks — "where is it?" on the warehouse floor.
 *
 * Owner 2026-09-12: 「电脑版本有的，手机版本都要有」. The desktop has three rack
 * surfaces — /scm/warehouses/racks (the grid + CRUD), the floor plan, and the
 * "All Companies" tab (`CrossCompanyRacks`). A storekeeper standing at the rack
 * had NONE of them: `frontend/src/mobile` reached `/warehouse` only to CREATE a
 * rack (MobileModuleList's FORM_RACK), never to look one up. Finding which rack
 * held a customer's sofa meant walking back to a PC.
 *
 * This screen is the LOOKUP half, and it is read-only on purpose: it answers
 * "which rack holds this" and "what is on this rack". Creating, renaming and
 * deleting racks stay where they are (desktop Racks & Bins, and the existing
 * mobile create form) — a phone in a warehouse is a finder, not an editor.
 *
 * IT OWNS NO RULES. Every predicate here comes from the ONE tested logic layer
 * the desktop reads — `vendor/scm/lib/warehouse-floorplan.ts` (`toSlot`,
 * `matchSlot`, `compareRackLabels`, `resolvedZoneLabel`, `itemDescription`,
 * `itemMeta`, `statusCounts`) — so a change to how a rack is matched, sorted or
 * zoned moves both surfaces at once. Re-implementing any of them under a mobile
 * name would be invisible to `check-shared-mirrors`, which is exactly the drift
 * that rule exists to stop.
 *
 * Data: `useCrossCompanyRacks` (GET /warehouse/cross-company), the same feed
 * the desktop "All Companies" tab reads. Cross-company is the right default for
 * a FINDER — the physical warehouse is one building whatever the book says, and
 * the rack you are standing at may be owned by the other company's record. The
 * endpoint scopes to the companies the caller may see (scopeToAllowedCompanies),
 * so widening the view does not widen access.
 *
 * Gate: the menu row points at /scm/warehouses/racks, which is a real entry in
 * the desktop `NAV_TABS` (Sidebar.tsx — anyAccess `scm.warehouse.inventory`,
 * hideForSalesRep). MobileApp's `allowed()` resolves the row against that same
 * entry, so the phone and the desktop are gated by one declaration, not two.
 * ------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { fmtDate, fmtQty } from "@2990s/shared";
import {
  useCrossCompanyRacks,
  type CrossCompanyRack,
} from "../vendor/scm/lib/warehouse-queries";
import {
  compareRackLabels,
  EMPTY_FILTERS,
  itemDescription,
  itemMeta,
  matchSlot,
  resolvedZoneLabel,
  statusCounts,
  toSlot,
  type FloorFilters,
  type Slot,
  type SlotStatus,
} from "../vendor/scm/lib/warehouse-floorplan";

/** A slot plus the company + physical warehouse it sits in. The floor-plan slot
 *  model carries neither (that view is pinned to one company + one warehouse),
 *  so the cross-company surfaces bolt them on — desktop `CrossCompanyRacks`
 *  does exactly this, with the same two fields. */
export type MobileRackSlot = Slot & { companyCode: string; warehouseCode: string };

export function toMobileRackSlot(r: CrossCompanyRack): MobileRackSlot {
  return {
    ...toSlot(r),
    companyCode: r.company_code ?? "—",
    warehouseCode: r.warehouse_code ?? "—",
  };
}

const STATUS_LABEL: Record<SlotStatus, string> = {
  occupied: "Occupied",
  reserved: "Reserved",
  empty: "Empty",
};

/* Status pill colours — control flow, not a colour table. Matches the desktop
   pill semantics (occupied = brand, reserved = warning, empty = muted) using
   the mobile palette variables. */
function pillStyle(st: SlotStatus): { background: string; color: string } {
  if (st === "occupied") return { background: "var(--brand-bg)", color: "var(--brand-d)" };
  if (st === "reserved") return { background: "#fdf2df", color: "#8a5a12" };
  return { background: "var(--bg)", color: "var(--mut)" };
}

/** Filter + sort, as ONE pure step so a test can drive it without a DOM.
 *  Sorting is company → warehouse → rack label, and the rack label comparison
 *  is `compareRackLabels` (the natural A2 < A10 order the desktop uses), never
 *  a string sort. */
export function visibleRackSlots(
  slots: MobileRackSlot[],
  opts: { company: string; warehouse: string; filters: FloorFilters },
): MobileRackSlot[] {
  return slots
    .filter(
      (s) =>
        (!opts.company || s.companyCode === opts.company) &&
        (!opts.warehouse || s.warehouseCode === opts.warehouse) &&
        matchSlot(s, opts.filters),
    )
    .sort(
      (a, b) =>
        a.companyCode.localeCompare(b.companyCode) ||
        a.warehouseCode.localeCompare(b.warehouseCode) ||
        compareRackLabels(a.rack.rack, b.rack.rack),
    );
}

const STATUS_CHIPS: { key: SlotStatus | ""; label: string }[] = [
  { key: "", label: "All" },
  { key: "occupied", label: "Occupied" },
  { key: "reserved", label: "Reserved" },
  { key: "empty", label: "Empty" },
];

function RackCard({ slot }: { slot: MobileRackSlot }) {
  const zone = resolvedZoneLabel(slot);
  const pill = pillStyle(slot.status);
  return (
    <div className="so-row" style={{ cursor: "default" }}>
      <div className="so-row-head">
        <div>
          <div className="so-row-name">{slot.rack.rack}</div>
          <div style={{ fontSize: 10.5, color: "var(--mut)", fontWeight: 600, marginTop: 2 }}>
            {[slot.companyCode, slot.warehouseCode, zone].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="spill" style={pill}>{STATUS_LABEL[slot.status]}</span>
      </div>

      {slot.items.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--mut)" }}>
          {slot.status === "reserved" ? "Reserved — nothing stored yet." : "Nothing on this rack."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {slot.items.map((it) => (
            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>
                  {itemDescription(it)}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--mut)", fontWeight: 600, marginTop: 1 }}>
                  {[itemMeta(it), it.stocked_in_date ? `in ${fmtDate(it.stocked_in_date)}` : ""]
                    .filter(Boolean)
                    .join(" · ") || it.item_code}
                </div>
              </div>
              <div className="tnum" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)", whiteSpace: "nowrap" }}>
                {fmtQty(it.qty)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MobileRacks({ onBack }: { onBack: () => void }) {
  const query = useCrossCompanyRacks();
  const resp = query.data;

  const [filters, setFilters] = useState<FloorFilters>(EMPTY_FILTERS);
  const [company, setCompany] = useState("");
  const [warehouse, setWarehouse] = useState("");

  const slots = useMemo<MobileRackSlot[]>(
    () => (resp?.racks ?? []).map(toMobileRackSlot),
    [resp],
  );
  const rows = useMemo(
    () => visibleRackSlots(slots, { company, warehouse, filters }),
    [slots, company, warehouse, filters],
  );
  const counts = useMemo(() => statusCounts(rows), [rows]);

  const warehouseOptions = resp?.warehouses ?? [];
  const companyOptions = resp?.companies ?? [];

  const body = () => {
    if (query.isLoading) return <Note>Loading racks…</Note>;
    /* A failed read must SAY so. Silently rendering "no racks" would tell a
       storekeeper the bay is empty when the truth is the request failed. */
    if (query.isError) return <Note>Could not load the racks. Pull down or try again.</Note>;
    if (slots.length === 0) return <Note>No racks in any warehouse you can see.</Note>;
    if (rows.length === 0) return <Note>No rack matches that search.</Note>;
    return (
      <>
        {rows.map((s) => (
          <RackCard key={`${s.companyCode}/${s.warehouseCode}/${s.rack.id}`} slot={s} />
        ))}
      </>
    );
  };

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">Warehouse · Find a rack</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">Racks</div>
        </div>
      </header>

      <div
        className="hz-scroll"
        style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}
      >
        {/* `.searchbar` carries `flex: 1` for the usual horizontal header row.
            In this vertical column that makes it GROW into any free space, so a
            search that leaves one rack stretched the box ~200px tall (seen in a
            real 375px render). `flex: none` pins it to its content height. */}
        <div className="searchbar" style={{ flex: "none" }}>
          <input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Rack, item, customer or document"
            aria-label="Search racks"
          />
        </div>

        {/* `flex: none` is load-bearing. `.chips` scrolls sideways (overflow-x),
            which drops its flex min-height to 0, and this column is a shrinking
            flex container — so without it the chip row collapses to a 2px
            sliver. Seen in a real 375px render; jsdom cannot show it. */}
        <div className="chips" style={{ flex: "none" }}>
          {STATUS_CHIPS.map((c) => (
            <button
              key={c.key || "all"}
              className={`chip${filters.status === c.key ? " on" : ""}`}
              aria-pressed={filters.status === c.key}
              onClick={() => setFilters((f) => ({ ...f, status: c.key }))}
            >
              {c.label}
            </button>
          ))}
        </div>

        {(companyOptions.length > 1 || warehouseOptions.length > 1) && (
          <div style={{ display: "flex", gap: 8 }}>
            {companyOptions.length > 1 && (
              <select
                className="cal-sel"
                aria-label="Company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              >
                <option value="">All companies</option>
                {companyOptions.map((c) => (
                  <option key={c.id} value={c.code ?? ""}>{c.code ?? "—"}</option>
                ))}
              </select>
            )}
            {warehouseOptions.length > 1 && (
              <select
                className="cal-sel"
                aria-label="Warehouse"
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value)}
              >
                <option value="">All warehouses</option>
                {warehouseOptions.map((w) => (
                  <option key={w.code} value={w.code}>{w.code}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {slots.length > 0 && !query.isError && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            <Kpi label="Matched" value={rows.length} />
            <Kpi label="Occupied" value={counts.occupied} />
            <Kpi label="Empty" value={counts.empty} />
          </div>
        )}

        <div className="sc-sl"><span className="t">Racks</span><span className="ln" /></div>
        {body()}
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="sokpi">
      <div className="sokpi-l">{label}</div>
      <div className="sokpi-v">{value}</div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "18px 4px", fontSize: 12.5, color: "var(--mut)", textAlign: "center" }}>
      {children}
    </div>
  );
}

export default MobileRacks;
