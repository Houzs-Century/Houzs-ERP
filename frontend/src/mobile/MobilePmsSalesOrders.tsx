// The Sales Orders written at this exhibition, inside the mobile project's
// Sales panel — the phone half of pages/projects/ProjectSalesOrdersBlock.tsx
// (owner 2026-10-13). Same read (GET /api/project-sales-orders/:projectId),
// same arithmetic (projectSalesOrders.ts), the panel's own compact styling.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatCurrency, formatDate } from "../lib/utils";
import { fmtSen } from "../vendor/shared/format";
import {
  normalizeProjectSalesOrders,
  soStatusLabel,
  summarizeProjectSalesOrders,
} from "../pages/projects/projectSalesOrders";

const LABEL: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093",
};
const MUTED: React.CSSProperties = { fontSize: 12, color: "#9aa093" };

export function MobilePmsSalesOrders({
  projectId,
  finalTotalRm,
}: {
  projectId: number;
  /** project_finance.total_sales (RM) — the lump sum typed into Total Sales. */
  finalTotalRm: number | null;
}) {
  const { data, isPending, error } = useQuery({
    queryKey: ["mobile-pms-sales-orders", projectId],
    queryFn: () => api.get<unknown>(`/api/project-sales-orders/${projectId}`).then(normalizeProjectSalesOrders),
    staleTime: 15_000,
  });
  const rows = data?.data ?? [];
  const s = data ? summarizeProjectSalesOrders(data.totals, finalTotalRm) : null;

  let gap: { text: string; color: string } | null = null;
  if (s?.notOpenedRm != null) {
    const pct = s.notOpenedPct != null ? ` (${Math.abs(s.notOpenedPct)}%)` : "";
    if (s.notOpenedRm > 0) gap = { text: `Not yet opened ${formatCurrency(s.notOpenedRm)}${pct}`, color: "#8a4e0e" };
    else if (s.notOpenedRm < 0) gap = { text: `Orders exceed final total by ${formatCurrency(-s.notOpenedRm)}${pct}`, color: "#0b6b8f" };
    else gap = { text: "Opened orders match the final total", color: "#16695f" };
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" }}>
        <span style={LABEL}>Sales orders (SO module)</span>
        {s && (
          <span className="money" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#414539" }}>
            {s.count} · {formatCurrency(s.openedRm)}
          </span>
        )}
      </div>
      {s && s.finalTotalRm != null && (
        <div style={{ fontSize: 11, color: "#414539", margin: "0 0 6px" }}>
          Final total {formatCurrency(s.finalTotalRm)}
          {gap && <span style={{ color: gap.color, fontWeight: 700 }}> · {gap.text}</span>}
        </div>
      )}
      {s && (s.draftCount > 0 || data?.scoped) && (
        <div style={{ ...MUTED, fontSize: 11, margin: "0 0 6px" }}>
          {s.draftCount > 0 && <span>{s.draftCount} still draft</span>}
          {s.draftCount > 0 && data?.scoped && <span> · </span>}
          {data?.scoped && <span>your orders only</span>}
        </div>
      )}
      {isPending ? (
        <div style={MUTED}>Loading sales orders…</div>
      ) : error ? (
        <div style={{ fontSize: 12, color: "#b42318" }}>{error instanceof Error ? error.message : "Could not load sales orders."}</div>
      ) : rows.length === 0 ? (
        <div style={MUTED}>No sales orders linked to this event were found in the SO module.</div>
      ) : (
        <div style={{ border: "1px solid #eceee9", borderRadius: 10, overflow: "hidden" }}>
          {rows.map((r, i) => (
            <div
              key={r.doc_no}
              style={{ padding: "9px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Link
                  to={`/scm/sales-orders/${encodeURIComponent(r.doc_no)}`}
                  style={{ fontSize: 12, fontWeight: 700, color: "#16695f", textDecoration: "none" }}
                >
                  {r.doc_no}
                </Link>
                <span style={{ flex: 1, minWidth: 80, fontSize: 12, color: "#414539" }}>{r.customer_name || "—"}</span>
                <span className="money" style={{ fontSize: 12, fontWeight: 700, color: "#2f8a5b" }}>{fmtSen(r.amount_sen)}</span>
              </div>
              <div style={{ ...MUTED, fontSize: 11, marginTop: 2 }}>
                {r.so_date ? formatDate(r.so_date) : "—"} · {r.ref || "no ref"} · {r.salesperson_name || "—"} · {soStatusLabel(r.status)}
                {r.balance_sen > 0 && <span style={{ color: "#8a4e0e" }}> · balance {fmtSen(r.balance_sen)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
