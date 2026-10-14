// The sales report a project keeps, in the mobile Sales panel — the phone
// half of pages/projects/ProjectSalesBillsBlock.tsx (owner 2026-10-14). Same
// read, same words; the phone only reads (the report is saved from the chat
// on the desktop). The red number beside each name under Sales Attending is
// derived from this same read in MobilePMS.tsx.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { formatDate } from "../lib/utils";
import { billStatusLabel, billsNeedingAction, fmtRmSen, normalizeProjectSalesBills, type ProjectSalesBillsResponse } from "../lib/projectSalesBills";

export type MobileProjectSalesBillsQuery = UseQueryResult<ProjectSalesBillsResponse>;

export function useMobileProjectSalesBills(projectId: number, enabled: boolean): MobileProjectSalesBillsQuery {
  return useQuery({
    queryKey: ["mobile-pms-sales-bills", projectId],
    queryFn: () => api.get<unknown>(`/api/project-sales-bills/${projectId}`).then(normalizeProjectSalesBills),
    staleTime: 15_000,
    enabled,
  });
}

const LABEL: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093",
};
const MUTED: React.CSSProperties = { fontSize: 12, color: "#9aa093" };
const TONE_COLOR = { red: "#b42318", green: "#2f8a5b", amber: "#8a4e0e", grey: "#9aa093" } as const;

export function MobilePmsSalesBills({ query }: { query: MobileProjectSalesBillsQuery }) {
  const data = query.data;
  const totals = data?.totals;
  /* Only the bills still to act on; an order opened under this event is in
     the Sales Orders list below (owner 2026-10-14). */
  const bills = billsNeedingAction(data?.bills ?? []);

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 6px" }}>
        <span style={LABEL}>Sales report (chat)</span>
        {totals && totals.count > 0 && (
          <span className="money" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "#414539" }}>
            {totals.count} · {fmtRmSen(totals.amount_sen)}
          </span>
        )}
      </div>
      {totals && totals.count > 0 && (
        <div style={{ fontSize: 11, color: "#414539", margin: "0 0 6px" }}>
          Opened {totals.opened_count} · {fmtRmSen(totals.opened_sen)}
          <span style={{ color: totals.not_opened_sen > 0 ? TONE_COLOR.red : TONE_COLOR.green, fontWeight: 700 }}>
            {" "}· Not opened {totals.not_opened_count} · {fmtRmSen(totals.not_opened_sen)}
          </span>
          {totals.other_event_count > 0 && (
            <span style={{ color: TONE_COLOR.amber, fontWeight: 700 }}> · {totals.other_event_count} under another event</span>
          )}
        </div>
      )}
      {data && data.persons.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "0 0 8px" }}>
          {data.persons.map((p) => (
            <span key={p.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e3e6e0", borderRadius: 999, padding: "3px 9px", fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: "#11140f" }}>{p.name}</span>
              {p.not_opened_sen > 0 ? (
                <span className="money" style={{ fontWeight: 700, color: TONE_COLOR.red }}>{fmtRmSen(p.not_opened_sen)}</span>
              ) : (
                <span style={{ fontSize: 9, textTransform: "uppercase", color: TONE_COLOR.green }}>all opened</span>
              )}
            </span>
          ))}
        </div>
      )}
      {query.isPending && query.fetchStatus !== "idle" ? (
        <div style={MUTED}>Loading sales report…</div>
      ) : query.error ? (
        <div style={{ fontSize: 12, color: TONE_COLOR.red }}>{query.error instanceof Error ? query.error.message : "Could not load the sales report."}</div>
      ) : data && totals && totals.count === 0 ? (
        <div style={MUTED}>No bills found in this event's chat. The report counts once the Owner, Ummu or Wei Siang posts it in the chat on the desktop.</div>
      ) : totals && bills.length === 0 ? (
        <div style={{ fontSize: 12, color: TONE_COLOR.green }}>All {totals.count} bill{totals.count === 1 ? "" : "s"} are opened as Sales Orders under this event — listed below.</div>
      ) : bills.length > 0 ? (
        <div style={{ border: "1px solid #eceee9", borderRadius: 10, overflow: "hidden" }}>
          {bills.map((b, i) => {
            const st = billStatusLabel(b.match);
            return (
              <div key={b.key} style={{ padding: "9px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="money" style={{ fontSize: 12, fontWeight: 700, color: "#11140f" }}>{b.ref_raw}</span>
                  <span style={{ flex: 1, minWidth: 60, fontSize: 12, color: "#414539" }}>{b.salesperson_name || "—"}</span>
                  <span className="money" style={{ fontSize: 12, fontWeight: 700, color: st.tone === "red" ? TONE_COLOR.red : "#2f8a5b" }}>{fmtRmSen(b.amount_sen)}</span>
                </div>
                <div style={{ ...MUTED, fontSize: 11, marginTop: 2 }}>
                  {b.report_date ? formatDate(b.report_date) : "—"} ·{" "}
                  <span style={{ color: TONE_COLOR[st.tone], fontWeight: 700 }}>{st.text}</span>
                  {b.match.so_doc_no && (
                    <>
                      {" "}·{" "}
                      <Link to={`/scm/sales-orders/${encodeURIComponent(b.match.so_doc_no)}`} style={{ color: "#16695f", fontWeight: 700, textDecoration: "underline" }}>
                        {b.match.so_doc_no}
                      </Link>
                    </>
                  )}
                  {b.other_event_name && <span style={{ color: TONE_COLOR.amber }}> · under {b.other_event_name}</span>}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
