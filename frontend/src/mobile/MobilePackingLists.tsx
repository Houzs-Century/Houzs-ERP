/* Phone twin of the Delivery Orders "Packing Lists" tab (owner 2026-11-27):
   pick a day, By lorry or By region, print them all in one PDF or one on its
   own. Same queries and same printer as desktop (usePackingLists /
   usePackingRegions / usePackingPrint). */
import { DateField } from "../vendor/scm/components/DateField";
import { useState } from "react";
import { usePackingLists, usePackingRegions } from "../vendor/scm/lib/packing-list-queries";
import { usePackingPrint } from "../vendor/scm/components/usePackingPrint";
import { regionLorrySummary, shiftIsoDate } from "../vendor/scm/lib/packing-list-model";
import { fmtDate, todayMY } from "../../../shared/src/vendor/shared/format";

const card = {
  border: "1px solid var(--hz-c-border, #d4d6d2)", borderRadius: 12, background: "var(--hz-c-surface)",
  padding: 12, marginBottom: 12,
} as const;
const btn = (on: boolean) => ({
  height: 36, borderRadius: 10, padding: "0 12px", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
  border: "1px solid var(--hz-c-primary)", cursor: "pointer",
  background: on ? "var(--hz-c-primary)" : "var(--hz-c-surface)", color: on ? "#fff" : "var(--hz-c-primary)",
}) as const;

export function MobilePackingLists() {
  const today = todayMY();
  const [date, setDate] = useState(today);
  const [byRegion, setByRegion] = useState(false);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const query = usePackingLists({ date, warehouseId: null });
  const lists = query.data?.lists ?? [];
  const regionQuery = usePackingRegions({ date, unassignedOnly, enabled: byRegion });
  const regions = regionQuery.data?.regions ?? [];
  const print = usePackingPrint(date);
  const n = lists.length;
  const nr = regions.length;
  const muted = { fontSize: 12, color: "var(--hz-c-ink-muted, #6b706c)", overflowWrap: "anywhere" } as const;
  const err = { fontSize: 12, margin: "8px 0 0", color: "var(--hz-c-err, #b42318)" } as const;

  return (
    <section style={card} aria-label="Packing lists">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>Packing lists</strong>
        <span style={{ fontSize: 12, color: "var(--hz-c-ink-muted, #6b706c)" }}>{fmtDate(date)}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {[["Yesterday", -1], ["Today", 0], ["Tomorrow", 1]].map(([label, d]) => {
          const iso = shiftIsoDate(today, d as number);
          return (
            <button key={label} type="button" style={btn(date === iso)} aria-pressed={date === iso} onClick={() => setDate(iso)}>
              {label}
            </button>
          );
        })}
        <div style={{ minWidth: 0, flex: "1 1 130px" }}>
          <DateField value={date} onChange={(iso) => { if (iso) setDate(iso); }} fullWidth aria-label="Delivery date" />
        </div>
      </div>
      <div role="group" aria-label="Kind of packing list" style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button type="button" style={{ ...btn(!byRegion), flex: 1 }} aria-pressed={!byRegion} onClick={() => setByRegion(false)}>By lorry</button>
        <button type="button" style={{ ...btn(byRegion), flex: 1 }} aria-pressed={byRegion} onClick={() => setByRegion(true)}>By region</button>
      </div>
      {byRegion && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={unassignedOnly} onChange={(e) => setUnassignedOnly(e.target.checked)} style={{ width: 18, height: 18 }} />
          Only DOs not on a lorry yet
        </label>
      )}
      {byRegion ? (
        <button
          type="button"
          disabled={print.busy || nr === 0}
          onClick={() => print.regions(regions, "preview")}
          style={{ ...btn(true), width: "100%", height: 44, marginTop: 10, opacity: print.busy || nr === 0 ? 0.5 : 1 }}
        >
          {print.busy ? "Preparing…" : `Print all ${nr} ${nr === 1 ? "region" : "regions"}`}
        </button>
      ) : (
        <button
          type="button"
          disabled={print.busy || n === 0}
          onClick={() => print.all(lists, "preview")}
          style={{ ...btn(true), width: "100%", height: 44, marginTop: 10, opacity: print.busy || n === 0 ? 0.5 : 1 }}
        >
          {print.busy ? "Preparing…" : `Print all ${n} ${n === 1 ? "lorry" : "lorries"}`}
        </button>
      )}
      {print.error && <p role="alert" style={err}>{print.error}</p>}
      {byRegion ? (
        <>
          {regionQuery.isLoading && <p style={{ fontSize: 12, margin: "8px 0 0" }}>Loading…</p>}
          {regionQuery.error && <p role="alert" style={err}>Could not load the delivery orders by region for this day.</p>}
          {regionQuery.data && nr === 0 && (
            <p style={{ fontSize: 12, margin: "8px 0 0" }}>
              {unassignedOnly ? "Every delivery order on this day is already on a lorry." : "No delivery orders are due for delivery on this day."}
            </p>
          )}
          {regions.map((r) => (
            <div key={r.region} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--hz-c-border, #ecedea)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{r.label}</div>
                <div style={muted}>{`${r.do_count} DO · ${r.customer_count} ${r.customer_count === 1 ? "customer" : "customers"} · ${r.units} ${r.units === 1 ? "unit" : "units"}`}</div>
                <div style={{ ...muted, fontFamily: "ui-monospace, monospace" }}>{regionLorrySummary(r)}</div>
              </div>
              <button type="button" style={btn(false)} disabled={print.busy} onClick={() => print.regions([r], "preview")}>Print</button>
            </div>
          ))}
        </>
      ) : (
        <>
      {query.isLoading && <p style={{ fontSize: 12, margin: "8px 0 0" }}>Loading…</p>}
      {query.error && <p role="alert" style={err}>Could not load the packing lists for this day.</p>}
      {query.data && n === 0 && <p style={{ fontSize: 12, margin: "8px 0 0" }}>No lorry has delivery orders on this day.</p>}
      {lists.map((l) => (
        <div key={l.trip_id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--hz-c-border, #ecedea)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{l.lorry_plate ?? "—"}</div>
            <div style={muted}>
              {[l.driver_name, `${l.stop_count} ${l.stop_count === 1 ? "customer" : "customers"}`, `${l.units} ${l.units === 1 ? "unit" : "units"}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button type="button" style={btn(false)} disabled={print.busy} onClick={() => print.one(l, "preview")}>Print</button>
        </div>
      ))}
        </>
      )}
    </section>
  );
}
