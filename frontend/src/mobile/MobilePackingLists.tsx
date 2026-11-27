/* Phone twin of the Delivery Orders "Packing Lists" tab (owner 2026-11-27):
   pick a day, print every lorry in one PDF, or one lorry on its own. Same
   query and same printer as desktop (usePackingLists / usePackingPrint). */
import { useState } from "react";
import { usePackingLists } from "../vendor/scm/lib/packing-list-queries";
import { usePackingPrint } from "../vendor/scm/components/usePackingPrint";
import { shiftIsoDate } from "../vendor/scm/lib/packing-list-model";
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
  const query = usePackingLists({ date, warehouseId: null });
  const lists = query.data?.lists ?? [];
  const print = usePackingPrint(date);
  const n = lists.length;

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
        <input
          type="date"
          aria-label="Delivery date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          style={{ height: 36, borderRadius: 10, border: "1px solid var(--hz-c-border, #c8cbc6)", padding: "0 8px", fontFamily: "inherit", fontSize: 13, minWidth: 0, flex: "1 1 130px" }}
        />
      </div>
      <button
        type="button"
        disabled={print.busy || n === 0}
        onClick={() => print.all(lists, "preview")}
        style={{ ...btn(true), width: "100%", height: 44, marginTop: 10, opacity: print.busy || n === 0 ? 0.5 : 1 }}
      >
        {print.busy ? "Preparing…" : `Print all ${n} ${n === 1 ? "lorry" : "lorries"}`}
      </button>
      {query.isLoading && <p style={{ fontSize: 12, margin: "8px 0 0" }}>Loading…</p>}
      {query.error && <p role="alert" style={{ fontSize: 12, margin: "8px 0 0", color: "var(--hz-c-err, #b42318)" }}>Could not load the packing lists for this day.</p>}
      {print.error && <p role="alert" style={{ fontSize: 12, margin: "8px 0 0", color: "var(--hz-c-err, #b42318)" }}>{print.error}</p>}
      {query.data && n === 0 && <p style={{ fontSize: 12, margin: "8px 0 0" }}>No lorry has delivery orders on this day.</p>}
      {lists.map((l) => (
        <div key={l.trip_id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--hz-c-border, #ecedea)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{l.lorry_plate ?? "—"}</div>
            <div style={{ fontSize: 12, color: "var(--hz-c-ink-muted, #6b706c)", overflowWrap: "anywhere" }}>
              {[l.driver_name, `${l.stop_count} ${l.stop_count === 1 ? "customer" : "customers"}`, `${l.units} ${l.units === 1 ? "unit" : "units"}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <button type="button" style={btn(false)} disabled={print.busy} onClick={() => print.one(l, "preview")}>Print</button>
        </div>
      ))}
    </section>
  );
}
