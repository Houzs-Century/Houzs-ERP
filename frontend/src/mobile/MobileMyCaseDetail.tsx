// ----------------------------------------------------------------------------
// MobileMyCaseDetail — what a SALES REP sees when they open a service case on a
// phone. The mobile half of `/my-cases/:id`.
//
// THE RULE THIS EXISTS FOR. Owner, 2026-07-23: 「sales agent 不应该有 edit case
// 功能」. Desktop has enforced it since that day — `SalesRepCaseDetailRoute`
// (`App.tsx`) redirects a non-director Sales rep off the editable `/assr/:id`
// onto the read-only `/my-cases/:id`, and `permissionDivergence.test.ts` pins
// it. **Mobile never enforced it at all.** The Service tab admits Sales staff
// (its own gate comment says so) and then mounted the full editable
// `MobileServiceCase` detail: stage select, Advance, Close, Archive, item
// quantity edits, attachment visibility. The only sales-aware suppression on
// that screen was the supplier card.
//
// WHAT WAS ACTUALLY HAPPENING IN PRODUCTION, because "one of two things is true"
// is not a finding. Read on 2026-08-20 by the read-only census
// (`backend/scripts/census-service-case-visibility.mjs` §5, dispatched via
// `census-service-case-visibility.yml`, run 32395787958):
//
//     active non-director Sales staff = 32
//     reps holding service_cases.write  = 0
//     reps holding service_cases.manage = 0
//
// All 32 sit on one role, "Sales Person", carrying `service_cases.read` alone.
// So this was NOT an authorisation hole: every one of those controls answered
// 403. The ruling was in fact being enforced — by the permission matrix, which
// simply never granted the key — and what shipped on the phone was a screen of
// buttons that could not work. A rep who tried to help got an error, and the
// two things they are genuinely entitled to do (comment, nudge ops) had no
// mobile home at all, because there is no mobile `/my-cases`.
//
// So this screen is the second half of the desktop rule, not a new one: the
// read-only view PLUS the sales-comment / sales-nudge thread. Both of those
// endpoints are gated on `requireServiceCaseAccess()` — the read-level gate, not
// `service_cases.write` — so a rep has always been allowed to use them.
//
// The cohort test is IMPORTED (`isSalesNonDirector`), never re-derived. Every
// defect this module has produced is a second copy of an answer.
// ----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatDate, formatDateTime } from "../lib/utils";
import { formatPhone } from "../vendor/shared/phone";
import { ASSR_STAGE_LABEL } from "../vendor/scm/lib/assr-stage-labels";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import "./mobile.css";

/* No `any` here, deliberately: this is a new file and the linter's ceiling for
   it is zero. `/api/assr/:id` returns loose rows (the Postgres driver camelCases
   result columns, so the same field arrives either way depending on the path),
   so the honest type is an index of `unknown` plus readers that narrow. */
type Row = Record<string, unknown>;
interface CaseDetailResponse {
  case?: Row;
  items?: Row[];
  activity?: Row[];
}

const INK = "#11140f";
const INK_SEC = "#3f463a";
const MUTED = "#767b6e";
const TEAL = "#16695f";
const BROWN_SOFT = "#f6efd9";
const BROWN_FG = "#8a6a2e";
const GREY = "#9aa093";
const LINE_SOFT = "rgba(34,31,32,0.10)";

/** Dual-read camelCase / snake_case — the Postgres driver camelCases result
 *  columns, so the same field arrives either way depending on the path. Same
 *  reader MobileServiceCase uses, restated rather than exported from a
 *  3,400-line screen this file must not import. */
const read = (r: Row, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
/** First present key, as display text. "" when absent — callers pick the dash. */
const field = (r: Row, ...keys: string[]): string => {
  const v = read(r, ...keys);
  return v === undefined ? "" : String(v);
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Read, never retyped — including `voided`, which the ordered stepper
 *  correctly has no row for. */
const stageLabel = (stage: string) =>
  ASSR_STAGE_LABEL[stage] ?? (cap(stage.replace(/_/g, " ")) || "—");

/** The rows a SALES rep is holding a conversation through: the customer's own
 *  portal comments, their replies, their nudges, and ops' notes. Auto-emitted
 *  events (stage_change, assignment, escalation) are ops' internal record and
 *  are deliberately not in the thread — same filter as the desktop
 *  `MyCaseDetail`. */
const CONVERSATION_ACTIONS = new Set(["customer_comment", "sales_comment", "sales_nudge"]);
const AUTHOR: Record<string, string> = {
  customer_comment: "Customer",
  sales_comment: "You (sales)",
  sales_nudge: "You · Nudge",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${LINE_SOFT}`, borderRadius: 13, padding: "12px 14px", marginBottom: 10 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: MUTED, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="fld-l">{label}</div>
      <div style={{ fontSize: 12.5, color: INK, marginTop: 2 }}>{value ?? "—"}</div>
    </div>
  );
}

export function MobileMyCaseDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const [comment, setComment] = useState("");

  /* Same query key as the editable detail so the two views share one cache
     entry — a rep and an admin opening the same case do not fetch twice, and an
     invalidation from either reaches both. */
  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-assr-detail", id],
    queryFn: () => api.get<CaseDetailResponse>(`/api/assr/${id}`),
    staleTime: 15_000,
  });
  /* `void`: the invalidation is fire-and-forget by design — the screen re-reads
     when it lands and there is nothing to await. Explicit so no-floating-promises
     sees a decision rather than an oversight. */
  const refetch = () => void qc.invalidateQueries({ queryKey: ["mobile-assr-detail", id] });

  const c: Row = data?.case ?? {};
  const items: Row[] = data?.items ?? [];
  const conversation = useMemo(() => {
    const rows: Row[] = data?.activity ?? [];
    return rows
      .filter((a) => CONVERSATION_ACTIONS.has(String(a.action)) || (a.action === "note" && !!a.note))
      .sort((a, b) => field(a, "created_at", "createdAt").localeCompare(field(b, "created_at", "createdAt")));
  }, [data]);

  /* Both mutations render their refusal. A write that fails silently is the bug
     class at the top of CLAUDE.md — the owner reports it as "the button does
     nothing" — and the nudge in particular has a REAL expected failure: the
     server rate-limits to one per hour per case and answers 429, which the rep
     must be told about rather than left to press again. */
  const postComment = useMutation({
    mutationFn: (text: string) => api.post<Row>(`/api/assr/${id}/sales-comment`, { text }),
    onSuccess: () => {
      setComment("");
      refetch();
    },
    onError: (e: Error) =>
      notify({ title: "Couldn't post", body: e.message || "Please try again.", tone: "error" }),
  });
  const nudge = useMutation({
    mutationFn: () => api.post<Row>(`/api/assr/${id}/sales-nudge`, {}),
    onSuccess: () => {
      void notify({ title: "Office nudged", body: "Ops will see this case bubble up.", tone: "info" });
      refetch();
    },
    onError: (e: Error) =>
      notify({
        title: "Couldn't nudge",
        body: e.message || "A nudge is capped at once an hour per case.",
        tone: "error",
      }),
  });

  const busy = postComment.isPending || nudge.isPending;
  const address = [c.addr1, c.addr2, c.addr3, c.addr4].filter(Boolean).map(String).join(", ");

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Back
          </button>
          <span style={{ padding: "3px 10px", borderRadius: 999, background: BROWN_SOFT, color: BROWN_FG, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
            {stageLabel(field(c, "stage"))}
          </span>
        </div>
        <div className="money" style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          {field(c, "assrNo", "assr_no") || "—"}
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>
          {field(c, "customerName", "customer_name") || "—"}
        </div>
        {/* Says why the edit controls are absent. A screen that is quietly
            smaller than the one a colleague is using reads as a fault. */}
        <div style={{ fontSize: 10.5, color: GREY, marginTop: 4 }}>
          Read-only — ops handle the workflow. Comment or nudge them below.
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {isLoading && (
          <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>
        )}
        {error && (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>
            Couldn&rsquo;t load this case.
          </div>
        )}
        {!isLoading && !error && (
          <>
            <Section title="Overview">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" }}>
                <Field label="SO" value={field(c, "docNo", "doc_no")} />
                <Field label="Ref" value={field(c, "refNo", "ref_no")} />
                <Field label="Priority" value={cap(field(c, "priority") || "normal")} />
                <Field label="Reported" value={formatDate(field(c, "complainedDate", "complained_date"))} />
              </div>
            </Section>

            <Section title="Customer">
              <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
                {field(c, "customerName", "customer_name") || "—"}
              </div>
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 1 }}>
                {formatPhone(field(c, "phone")) || "—"}
              </div>
              {address && (
                <div style={{ fontSize: 11.5, color: INK_SEC, marginTop: 4 }}>{address}</div>
              )}
            </Section>

            <Section title={`Items (${items.length})`}>
              {items.length === 0 ? (
                <div style={{ fontSize: 12, color: MUTED }}>No items</div>
              ) : (
                items.map((it) => (
                  <div key={String(it.id)} style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 5 }}>
                    <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: INK }}>
                      {field(it, "itemCode", "item_code") || "—"}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: INK_SEC, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {field(it, "itemDescription", "item_description")}
                    </span>
                    {it.qty != null && <span style={{ fontSize: 11, color: MUTED }}>× {String(it.qty)}</span>}
                  </div>
                ))
              )}
            </Section>

            <Section title="Reported issue">
              <div style={{ fontSize: 12.5, color: INK, whiteSpace: "pre-line" }}>
                {field(c, "complaintIssue", "complaint_issue") || "—"}
              </div>
              {field(c, "issueCategory", "issue_category") && (
                <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
                  Category: {field(c, "issueCategory", "issue_category")}
                </div>
              )}
            </Section>

            <Section title={`Conversation (${conversation.length})`}>
              {conversation.length === 0 ? (
                <div style={{ fontSize: 12, color: MUTED }}>No messages yet. Start it below.</div>
              ) : (
                conversation.map((a) => (
                  <div key={String(a.id)} style={{ borderLeft: `2px solid ${a.action === "sales_comment" ? TEAL : LINE_SOFT}`, paddingLeft: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: MUTED }}>
                      <span style={{ fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: INK_SEC }}>
                        {AUTHOR[String(a.action)] ?? (field(a, "user_name", "userName") || "Ops")}
                      </span>{" "}
                      {formatDateTime(field(a, "created_at", "createdAt"))}
                    </div>
                    {!!a.note && (
                      <div style={{ fontSize: 12.5, color: INK, marginTop: 3, whiteSpace: "pre-line" }}>{String(a.note)}</div>
                    )}
                  </div>
                ))
              )}
            </Section>

            <Section title="Add a note">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Update ops — status, urgency, what the customer expects…"
                className="fld-i"
                style={{ resize: "none", width: "100%", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 10, color: GREY }} aria-live="polite">
                  {comment.length}/2000
                </span>
                <span style={{ display: "flex", gap: 7 }}>
                  <button
                    className="sochip"
                    onClick={() => nudge.mutate()}
                    disabled={busy}
                    style={{ opacity: busy ? 0.5 : 1 }}
                    title="Ping ops to look at this case — capped at once an hour"
                  >
                    {nudge.isPending ? "Nudging…" : "Nudge office"}
                  </button>
                  <button
                    className="sochip on"
                    onClick={() => comment.trim() && postComment.mutate(comment.trim())}
                    disabled={busy || !comment.trim()}
                    style={{ opacity: busy || !comment.trim() ? 0.5 : 1 }}
                  >
                    {postComment.isPending ? "Posting…" : "Post"}
                  </button>
                </span>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
