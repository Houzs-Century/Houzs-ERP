/**
 * My Cases — a sales rep's view of the service cases they raised.
 *
 * Simpler than the staff /assr detail (no stage editing, no
 * assignment controls). Each card opens a Panel with case summary +
 * a two-way comment thread merging customer_portal, sales_portal and
 * staff notes so the rep can hold the conversation with ops + the
 * customer in one place.
 *
 * Scope: cases where LOWER(sales_agent) LIKE '%' || lower(user.name)
 * || '%' — the same rule /api/assr/my-cases uses on the backend.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Send, User, Package, MessageSquare, Search, X } from "lucide-react";
import { api } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { ASSR_STAGE_LABEL } from "../vendor/scm/lib/assr-stage-labels";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { PageHeader } from "../components/Layout";
import { Panel, PanelSection } from "../components/Panel";
import { Skeleton } from "../components/Skeleton";
import { Button } from "../components/Button";
import { formatDate, formatDateTime, cn } from "../lib/utils";
import type { AssrDetail, AssrStage } from "../types";

type MyCase = {
  id: number;
  assr_no: string;
  stage: AssrStage;
  status: string;
  priority: string;
  doc_no: string | null;
  ref_no: string | null;
  customer_name: string | null;
  phone: string | null;
  complained_date: string | null;
  deadline_at: string | null;
  complaint_issue: string | null;
  item_code: string | null;
  sales_agent: string | null;
};

const STAGE_LABEL: Record<string, string> = {
  pending_review: "Review",
  under_verification: "Verification",
  pending_solution: "Solution",
  pending_supplier_pickup: "Pickup / Return",
  pending_item_ready: "Pending Item Ready",
  pending_delivery_service: "Delivery / Service",
  completed: "Completed",
  // Read, not retyped. This exact string had six hand-written homes and the
  // customer portal's copy — the only one a customer reads — had none at all
  // and printed the raw slug. (The rows ABOVE are this screen's short pill
  // vocabulary, a different question, and still a hand-written copy shared
  // with the other pill screens — see BUG-HISTORY, not yet unified.)
  voided: ASSR_STAGE_LABEL.voided,
};

const STAGE_COLOR: Record<string, string> = {
  pending_review: "bg-ink-muted/10 text-ink-secondary border-ink-muted/20",
  under_verification: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  pending_solution: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  pending_supplier_pickup: "bg-violet-500/10 text-violet-700 border-violet-500/30",
  pending_item_ready: "bg-violet-500/10 text-violet-700 border-violet-500/30",
  pending_delivery_service: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  completed: "bg-synced/10 text-synced border-synced/30",
};

function StagePill({ stage }: { stage: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        STAGE_COLOR[stage] ?? STAGE_COLOR.pending_review,
      )}
    >
      {STAGE_LABEL[stage] ?? stage}
    </span>
  );
}

export function MyCases() {
  const nav = useNavigate();
  const listQ = useQuery<{ cases: MyCase[]; user_name?: string }>("/api/assr/my-cases",
    () => api.get("/api/assr/my-cases"),
    [],
  );
  const cases = listQ.data?.cases ?? [];
  const userName = listQ.data?.user_name ?? null;

  // Search + filter run CLIENT-SIDE: /api/assr/my-cases returns the rep's whole
  // set in one shot (≤200 rows, no pagination), so there's nothing to page
  // through — filtering the loaded array is exact and instant.
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState("all");

  // Count per stage + the stages actually present, in canonical pipeline order
  // (STAGE_LABEL is already ordered) so the filter row only offers stages the
  // rep has cases in.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of cases) m[c.stage] = (m[c.stage] ?? 0) + 1;
    return m;
  }, [cases]);
  const stagesPresent = useMemo(
    () => Object.keys(STAGE_LABEL).filter((s) => counts[s]),
    [counts],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return cases.filter((c) => {
      if (stageFilter !== "all" && c.stage !== stageFilter) return false;
      if (!term) return true;
      // Covers the same fields the card surfaces: case no / SO / Ref /
      // customer / issue text / item code / the matched sales-agent name.
      // Ref No included 2026-08-12 (Nico): reps identify a case by its
      // ref (HC…/ZNT…/PG…) more often than by anything else.
      return [c.assr_no, c.doc_no, c.ref_no, c.customer_name, c.complaint_issue, c.item_code, c.sales_agent]
        .some((f) => f && f.toLowerCase().includes(term));
    });
  }, [cases, q, stageFilter]);

  const hasActiveFilter = q.trim() !== "" || stageFilter !== "all";
  const clearFilters = () => { setQ(""); setStageFilter("all"); };

  return (
    <div className="w-full py-6 sm:py-8">
      <PageHeader
        eyebrow="Service Cases"
        title="My Cases"
        description={
          userName
            ? `Service cases where you're the sales agent (matched on "${userName}").`
            : "Service cases where you're the sales agent."
        }
      />

      {listQ.loading ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ) : listQ.error ? (
        <div className="mt-6 rounded-md border border-err/40 bg-err/5 px-3 py-2 text-sm text-err">
          {listQ.error || "Couldn't load cases"}
        </div>
      ) : cases.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-border bg-bg/40 p-8 text-center text-[13px] text-ink-muted">
          No cases matched your name on the sales_agent field yet. If a case
          you raised isn&rsquo;t showing here, tell IT the name spelling used
          on the sales order.
        </div>
      ) : (
        <>
          {/* Search + stage filter (client-side over the loaded set). */}
          <div className="mt-6 space-y-3">
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search case · SO · customer · issue · item"
                aria-label="Search my cases"
                className="w-full rounded-lg border border-border bg-surface py-2.5 pl-9 pr-9 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              {q && (
                <button
                  onClick={() => setQ("")}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-muted hover:bg-bg hover:text-ink"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <FilterChip
                label="All"
                count={cases.length}
                active={stageFilter === "all"}
                onClick={() => setStageFilter("all")}
              />
              {stagesPresent.map((s) => (
                <FilterChip
                  key={s}
                  label={STAGE_LABEL[s] ?? s}
                  count={counts[s]}
                  active={stageFilter === s}
                  onClick={() => setStageFilter(s)}
                />
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between px-0.5 text-[11px] text-ink-muted">
            <span>
              {filtered.length} of {cases.length} case{cases.length === 1 ? "" : "s"}
            </span>
            {hasActiveFilter && (
              <button onClick={clearFilters} className="font-medium text-accent hover:underline">
                Clear
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-border bg-bg/40 p-8 text-center text-[13px] text-ink-muted">
              No cases match your search or filter.
              <button onClick={clearFilters} className="ml-1 font-medium text-accent hover:underline">
                Clear
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => nav(`/my-cases/${c.id}`)}
                  className="block w-full rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/10"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-[13px] font-bold">{c.assr_no}</span>
                    <StagePill stage={c.stage} />
                    {c.doc_no && (
                      <span className="font-mono text-[11px] text-ink-muted">SO {c.doc_no}</span>
                    )}
                    {c.ref_no && (
                      <span className="font-mono text-[11px] text-ink-muted">Ref {c.ref_no}</span>
                    )}
                  </div>
                  {c.customer_name && (
                    <div className="mt-1 text-[13px] text-ink-secondary">{c.customer_name}</div>
                  )}
                  {c.complaint_issue && (
                    <div className="mt-1 line-clamp-2 text-[12px] text-ink-muted">
                      {c.complaint_issue}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-ink-muted">
                    Reported {formatDate(c.complained_date)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "border-accent bg-accent text-white"
          : "border-border bg-surface text-ink-secondary hover:border-accent/50",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px] font-semibold",
          active ? "bg-white/20 text-white" : "bg-bg text-ink-muted",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ── Detail (route target `/my-cases/:id`) ─────────────────────

export function MyCaseDetail() {
  const { id: idStr } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [nudging, setNudging] = useState(false);

  const detail = useQuery<AssrDetail>("/api/assr/:",
    () => api.get(`/api/assr/${id}`),
    [id],
  );

  const post = useCallback(async () => {
    const text = comment.trim();
    if (!text) return;
    setPosting(true);
    try {
      await api.post(`/api/assr/${id}/sales-comment`, { text });
      setComment("");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to post");
    } finally {
      setPosting(false);
    }
  }, [comment, id, detail, toast]);

  // "Nudge office" — one-tap ping that lands in the timeline so ops
  // sees the row bubble up. Server rate-limits to one nudge per hour
  // per case; on 429 we tell the rep it was already sent recently.
  const nudge = useCallback(async () => {
    setNudging(true);
    try {
      await api.post(`/api/assr/${id}/sales-nudge`, {});
      toast.success("Office nudged.");
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to nudge");
    } finally {
      setNudging(false);
    }
  }, [id, detail, toast]);

  const conversation = useMemo(() => {
    const rows = detail.data?.activity ?? [];
    return rows
      .filter(
        (a: any) =>
          a.action === "customer_comment" ||
          a.action === "sales_comment" ||
          a.action === "sales_nudge" ||
          (a.action === "note" && a.note),
      )
      .sort((a: any, b: any) =>
        String(a.created_at).localeCompare(String(b.created_at)),
      );
  }, [detail.data]);

  const c = detail.data?.case;
  const items = detail.data?.items ?? [];

  return (
    <Panel
      open
      onClose={() => nav("/my-cases")}
      title={c ? c.assr_no : "Case"}
      subtitle={c?.customer_name || undefined}
      width={520}
    >
      {isNaN(id) ? (
        <PanelSection title="Error">
          <div className="text-[12px] text-err">Invalid case id.</div>
        </PanelSection>
      ) : detail.loading ? (
        <PanelSection title="Loading">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="mt-3 h-40 w-full" />
        </PanelSection>
      ) : detail.error ? (
        <PanelSection title="Error">
          <div className="text-[12px] text-err">{detail.error}</div>
        </PanelSection>
      ) : c ? (
        <>
          <PanelSection title="Overview">
            <div className="flex flex-wrap items-center gap-2">
              <StagePill stage={c.stage} />
              <span className="text-[11px] text-ink-muted">
                Reported {formatDate(c.complained_date)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px]">
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  SO
                </div>
                <div className="font-mono text-ink">{c.doc_no || "—"}</div>
              </div>
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  PO
                </div>
                <div className="font-mono text-ink">{c.po_no || "—"}</div>
              </div>
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Priority
                </div>
                <div className="text-ink">{c.priority || "—"}</div>
              </div>
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  Location
                </div>
                <div className="text-ink">{c.location || "—"}</div>
              </div>
            </div>
          </PanelSection>

          <PanelSection title="Customer" icon={<User size={13} />}>
            <div className="text-[13px] font-medium text-ink">
              {c.customer_name || "—"}
            </div>
            <div className="text-[11.5px] text-ink-muted">{formatPhone(c.phone) || "—"}</div>
            {(c.addr1 || c.addr2 || c.addr3 || c.addr4) && (
              <div className="mt-1 text-[11.5px] text-ink-secondary">
                {[c.addr1, c.addr2, c.addr3, c.addr4].filter(Boolean).join(", ")}
              </div>
            )}
          </PanelSection>

          <PanelSection title={`Items (${items.length})`} icon={<Package size={13} />}>
            {items.length === 0 ? (
              <div className="text-[12px] text-ink-muted">No items</div>
            ) : (
              <ul className="space-y-1">
                {items.map((it: any) => (
                  <li key={it.id} className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-mono text-[11px]">{it.item_code}</span>
                    <span className="flex-1 truncate text-ink-secondary">
                      {it.item_description || ""}
                    </span>
                    {it.qty != null && (
                      <span className="text-[11px] text-ink-muted">× {it.qty}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </PanelSection>

          <PanelSection title="Reported issue">
            <div className="whitespace-pre-line text-[13px]">
              {c.complaint_issue || "—"}
            </div>
            {c.issue_category && (
              <div className="mt-1 text-[11px] text-ink-muted">
                Category: {c.issue_category}
              </div>
            )}
          </PanelSection>

          <PanelSection
            title={`Conversation (${conversation.length})`}
            icon={<MessageSquare size={13} />}
          >
            {conversation.length === 0 ? (
              <div className="text-[12px] text-ink-muted">
                No messages yet. Start the conversation below.
              </div>
            ) : (
              <ul className="space-y-3">
                {conversation.map((a: any) => (
                  <li
                    key={a.id}
                    className={cn(
                      "border-l-2 pl-3",
                      a.action === "customer_comment"
                        ? "border-blue-500/60"
                        : a.action === "sales_comment"
                        ? "border-accent"
                        : a.action === "sales_nudge"
                        ? "border-amber-500"
                        : "border-border",
                    )}
                  >
                    <div className="flex items-center gap-2 text-[10.5px] text-ink-muted">
                      <span className="font-semibold uppercase tracking-wider text-ink-secondary">
                        {a.action === "customer_comment"
                          ? "Customer"
                          : a.action === "sales_comment"
                          ? "You (sales)"
                          : a.action === "sales_nudge"
                          ? "You · Nudge"
                          : a.user_name || "Ops"}
                      </span>
                      <span>{formatDateTime(a.created_at)}</span>
                    </div>
                    {a.note && (
                      <div className="mt-1 whitespace-pre-line text-[12.5px]">
                        {a.note}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </PanelSection>

          <PanelSection title="Add a note">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Update ops / customer status, urgency, expectations…"
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-ink-muted" aria-live="polite">
                {comment.length}/2000
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={nudge}
                  disabled={nudging}
                  className="h-8 px-3 text-[11px]"
                  title="Ping ops to look at this case — capped at once per hour"
                >
                  {nudging ? "Nudging…" : "Nudge office"}
                </Button>
                <Button
                  variant="primary"
                  onClick={post}
                  disabled={!comment.trim() || posting}
                  icon={<Send size={12} />}
                  className="h-8 px-3 text-[11px]"
                >
                  {posting ? "Posting…" : "Post"}
                </Button>
              </div>
            </div>
          </PanelSection>
        </>
      ) : null}
    </Panel>
  );
}
