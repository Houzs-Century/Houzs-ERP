// The Houzs POS bills of this event, inside the mobile project's Sales panel —
// the phone half of pages/projects/ProjectPosSalesSection.tsx (layout E9).
// Same read (GET /api/project-pos-sales/:projectId), same labels
// (lib/projectPosSales.ts), the panel's own compact styling. Read-only on the
// phone: Export and Total Sales stay on the desktop page.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDateTime } from "../lib/utils";
import { fmtSen } from "../vendor/shared/format";
import {
  EMPTY_POS_FILTER,
  normalizeProjectPosSales,
  posMethodLabel,
  posReceiptStatusLabel,
  posSalesFilterQuery,
  type ProjectPosSalesResponse,
} from "../lib/projectPosSales";

const LABEL: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093",
};
const MUTED: React.CSSProperties = { fontSize: 12, color: "#9aa093" };
const PILL: Record<"PAID" | "VOID" | "RETURN", React.CSSProperties> = {
  PAID: { background: "#d9f0e4", color: "#16695f" },
  VOID: { background: "#f9dede", color: "#9b2c2c" },
  RETURN: { background: "#dbeefb", color: "#0b6b8f" },
};

export function useMobileProjectPosSales(projectId: number, enabled: boolean) {
  return useQuery<ProjectPosSalesResponse>({
    queryKey: ["mobile-pms-pos-sales", projectId],
    queryFn: () => api.get<unknown>(`/api/project-pos-sales/${projectId}${posSalesFilterQuery(EMPTY_POS_FILTER)}`).then(normalizeProjectPosSales),
    staleTime: 15_000,
    enabled,
  });
}

export function MobilePmsPosSales({ query }: { query: ReturnType<typeof useMobileProjectPosSales> }) {
  const [open, setOpen] = useState<number | null>(null);
  const { data, isPending, error } = query;
  const rows = data?.data ?? [];
  const t = data?.totals;
  /* Off, not hide: nothing to say for an event that is neither Cash & Carry
     nor has any synced bill. */
  if (data && !data.pos_enabled && data.all_count === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" }}>
        <span style={LABEL}>POS sales</span>
        {t && (
          <span className="money" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#414539" }}>
            {t.paid_count} · {fmtSen(t.net_sen)}
          </span>
        )}
      </div>
      {t && Object.keys(t.by_method).length > 0 && (
        <div style={{ fontSize: 11, color: "#414539", margin: "0 0 6px" }}>
          {Object.entries(t.by_method).map(([m, sen]) => `${posMethodLabel(m)} ${fmtSen(sen)}`).join(" · ")}
          {t.void_count > 0 ? ` · ${t.void_count} void` : ""}
          {t.return_count > 0 ? ` · ${t.return_count} return` : ""}
        </div>
      )}
      {isPending && <div style={MUTED}>Loading POS sales…</div>}
      {error && <div style={{ ...MUTED, color: "#9b2c2c" }}>{error instanceof Error ? error.message : "Could not load POS sales."}</div>}
      {data && rows.length === 0 && <div style={MUTED}>No POS sales yet. Bills appear once a booth terminal syncs.</div>}
      {rows.map((r) => {
        const status = posReceiptStatusLabel(r);
        const isOpen = open === r.id;
        return (
          <div key={r.id} style={{ borderTop: "1px solid #e6e8e1", padding: "6px 0" }} onClick={() => setOpen(isOpen ? null : r.id)}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <span className="mono" style={{ fontWeight: 700, color: "#16695f" }}>{r.receipt_no}</span>
              <span style={{ ...PILL[status], fontSize: 9, fontWeight: 700, borderRadius: 999, padding: "1px 6px" }}>{status}</span>
              <span className="money" style={{ marginLeft: "auto", fontWeight: 700, textDecoration: status === "VOID" ? "line-through" : undefined }}>
                {r.type === "RETURN" && status !== "VOID" ? "-" : ""}{fmtSen(r.total_sen)}
              </span>
            </div>
            <div style={{ ...MUTED, fontSize: 11 }}>
              {formatDateTime(r.sold_at)} · {r.terminal_code}
              {r.cashier_name ? ` · ${r.cashier_name}` : ""}
              {r.salesman_name ? ` · ${r.salesman_name} (PT)` : ""}
              {r.methods.length > 0 ? ` · ${r.methods.map(posMethodLabel).join(" + ")}` : ""}
            </div>
            {isOpen && (
              <div style={{ marginTop: 4, fontSize: 11, color: "#414539" }}>
                {r.lines.map((l) => (
                  <div key={l.line_no} style={{ display: "flex", gap: 6 }}>
                    <span style={{ flex: 1 }}>
                      <span className="mono" style={{ color: "#9aa093" }}>{l.item_code}</span> {l.description}
                    </span>
                    <span className="mono">{l.qty} {l.uom}</span>
                    <span className="mono" style={{ color: l.disc_label !== "--" ? "#8a4e0e" : "#9aa093" }}>{l.disc_label}</span>
                    <span className="money">{fmtSen(l.amount_sen)}</span>
                  </div>
                ))}
                {status === "VOID" && <div style={{ color: "#9b2c2c" }}>Void: {r.void_reason || "no reason"}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
