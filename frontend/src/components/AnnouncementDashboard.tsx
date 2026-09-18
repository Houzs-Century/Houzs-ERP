import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { cn, relativeTime } from "../lib/utils";
import {
  CATEGORY_META,
  categoryOf,
  requiresAcknowledgement,
  type AnnouncementCategory,
} from "./announcementCategory";
import { useAnnouncementBanner, type BannerAnnouncement } from "./useAnnouncementBanner";
import { ackRateBarCls } from "../pages/announcements/announcementModel";
import { fmtDate } from "../vendor/shared/format";

// ────────────────────────────────────────────────────────────────────────────
// AnnouncementDashboard — the Overview's two announcement pieces (design
// handoff 2026-09-04, screen 5):
//
//   · AnnouncementBannerStack — up to three unacknowledged notices at login
//     without a modal wall: the first expanded, the rest collapsed, anything
//     beyond behind an "n more notices collapsed · Expand" row. Reads the SAME
//     hook the modal reads, so acknowledging here settles the modal and the
//     inbox too.
//   · TeamPendingCard — the supervisor's gap: direct reports who have not
//     acknowledged a mandatory notice (GET /api/announcements/team-pending).
//     Renders only for a user with direct reports. "Remind all" re-pops each
//     notice for its pending people; it needs announcements.write (the remind
//     route is write-gated), so a supervisor without it sees the list only.
// ────────────────────────────────────────────────────────────────────────────

const EYEBROW = "font-mono text-[10px] font-bold uppercase tracking-wider";
const MAX_VISIBLE = 3;

function firstLine(body: string): string {
  const s = body.trim().split(/\n+/)[0] ?? "";
  return s;
}

function secondaryLabel(category: AnnouncementCategory): string {
  return category === "SOP" ? "Read SOP" : "View details";
}

export function AnnouncementBannerStack() {
  const navigate = useNavigate();
  const { notices, ackedIds, ack } = useAnnouncementBanner({ scope: "human" });
  const pending = useMemo(() => notices.filter((a) => !ackedIds.has(a.id)), [notices, ackedIds]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (pending.length === 0) return null;
  const openId = expandedId && pending.some((a) => a.id === expandedId) ? expandedId : pending[0].id;
  const visible = showAll ? pending : pending.slice(0, MAX_VISIBLE);
  const hidden = pending.length - visible.length;

  const view = (a: BannerAnnouncement) => navigate(`/announcements?id=${encodeURIComponent(a.id)}`);

  return (
    <div className="flex flex-col gap-2.5" aria-label="Unacknowledged notices">
      {visible.map((a) => {
        const category = categoryOf(a);
        const meta = CATEGORY_META[category];
        const Icon = meta.Icon;
        const who = a.createdByName?.trim();
        const when = `${relativeTime(a.createdAt)}${who ? ` · ${who}` : ""}`;
        if (a.id === openId) {
          return (
            <div
              key={a.id}
              className={cn("relative overflow-hidden rounded-lg border bg-surface shadow-stone", meta.borderCls)}
            >
              <span className={cn("absolute left-0 top-0 h-full w-[3px]", meta.railCls)} />
              <div className="flex items-start gap-3.5 py-3.5 pl-5 pr-4">
                <div className={cn("grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full", meta.chipCls)}>
                  <Icon size={15} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-[5px]">
                  <div className="flex items-center gap-[7px]">
                    <span className={cn("text-[10px] font-bold uppercase tracking-[.08em]", meta.textCls)}>
                      {meta.label}
                    </span>
                    <span className="h-[3px] w-[3px] rounded-full bg-border" />
                    <span className="font-mono text-[10.5px] text-ink-secondary">{when}</span>
                    {requiresAcknowledgement(a) && (
                      <span className="text-[10px] text-ink-muted">· requires acknowledgement</span>
                    )}
                  </div>
                  <span className="text-[14.5px] font-[680] leading-[1.35] text-ink">{a.title}</span>
                  {a.body && (
                    <span className="line-clamp-2 text-[12.5px] leading-[1.6] text-ink-secondary">
                      {firstLine(a.body)}
                    </span>
                  )}
                </div>
                <div className="flex w-[150px] shrink-0 flex-col gap-[7px]">
                  <button
                    type="button"
                    onClick={() => void ack(a)}
                    className={cn("h-[34px] rounded-lg text-[12.5px] font-bold", meta.solidCls)}
                  >
                    {meta.ctaLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => view(a)}
                    className="h-8 rounded-lg border border-border bg-surface text-[11.5px] font-[650] text-ink-secondary hover:bg-surface-dim"
                  >
                    {secondaryLabel(category)}
                  </button>
                </div>
              </div>
            </div>
          );
        }
        return (
          <div
            key={a.id}
            className={cn("relative overflow-hidden rounded-lg border bg-surface", meta.borderCls)}
          >
            <span className={cn("absolute left-0 top-0 h-full w-[3px]", meta.railCls)} />
            <div className="flex items-center gap-3 py-[11px] pl-5 pr-4">
              <span className={cn("shrink-0 text-[10px] font-bold uppercase tracking-[.08em]", meta.textCls)}>
                {meta.label}
              </span>
              <button
                type="button"
                onClick={() => setExpandedId(a.id)}
                className="min-w-0 flex-1 truncate text-left text-[13px] font-[650] text-ink hover:text-primary"
              >
                {a.title}
              </button>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{relativeTime(a.createdAt)}</span>
              <button
                type="button"
                onClick={() => void ack(a)}
                className={cn("h-[30px] shrink-0 rounded-md px-3 text-[11.5px] font-bold", meta.solidCls)}
              >
                {meta.ctaLabel}
              </button>
              <button
                type="button"
                onClick={() => view(a)}
                className="h-[30px] shrink-0 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-[650] text-ink-secondary hover:bg-surface-dim"
              >
                {secondaryLabel(category)}
              </button>
            </div>
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-4 py-[9px]">
          <span className="text-[11.5px] text-ink-muted">
            {hidden} more {hidden === 1 ? "notice" : "notices"} collapsed
          </span>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11.5px] font-[650] text-primary hover:underline"
          >
            Expand
          </button>
        </div>
      )}
    </div>
  );
}

// ── My team's pending ──────────────────────────────────────────────────────

export type TeamPendingRow = {
  userId: number;
  name: string;
  positionName: string | null;
  announcementId: string;
  title: string;
  category: AnnouncementCategory;
  createdAt: string | null;
  state: "pending" | "reminded" | "overdue";
};
type TeamPendingResponse = {
  success?: boolean;
  data?: { reports: number; pending: TeamPendingRow[]; overdueAfterHours?: number };
};

const STATE_CLS: Record<TeamPendingRow["state"], string> = {
  overdue: "bg-err-bg text-err",
  reminded: "bg-warning-bg text-warning-text",
  pending: "bg-surface-dim border border-border text-ink-muted",
};

// ── "Ack rate · last 30 days" (design handoff 2026-09-04, screen 5; endpoint
// 2026-09-06): six 5-day bars from GET /api/announcements/ack-trend — the
// notices POSTED in each bucket, their summed audience, and how many of it
// acknowledged. Write-gated like the Manage table it mirrors, so it renders
// only for an announcer; a bucket with no notice is drawn empty, not as 0%.
type AckTrendBucket = {
  start: string;
  end: string;
  notices: number;
  total: number;
  acked: number;
  pct: number | null;
};
type AckTrendResponse = {
  success: boolean;
  data: {
    days: number;
    buckets: AckTrendBucket[];
    summary: { days: number; notices: number; total: number; acked: number; pct: number | null };
  };
};

export function AckTrendCard() {
  const { can } = useAuth();
  const enabled = can("announcements.write");
  const q = useQuery<AckTrendResponse | null>("/api/announcements/ack-trend", () =>
    enabled ? api.get<AckTrendResponse>("/api/announcements/ack-trend") : Promise.resolve(null),
  );
  const data = q.data?.data;
  if (!enabled || !data) return null;
  const s = data.summary;
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-[15px] shadow-stone"
      data-testid="ack-trend"
    >
      <div className="flex items-baseline justify-between">
        <span className={cn(EYEBROW, "text-ink-secondary")}>Ack rate · last {data.days} days</span>
        <span
          className={cn(
            "font-money text-[12.5px] font-bold",
            s.pct == null ? "text-ink-muted" : s.pct >= 95 ? "text-synced" : s.pct >= 70 ? "text-primary" : "text-warning-text",
          )}
        >
          {s.pct == null ? "—" : `${s.pct}%`}
        </span>
      </div>
      <div className="grid h-[120px] grid-cols-6 items-end gap-2" role="img" aria-label="Acknowledgement rate by 5-day period">
        {data.buckets.map((b) => (
          <div key={b.start} className="flex h-full flex-col items-center justify-end gap-1">
            <span className="font-money text-[10.5px] font-bold text-ink-secondary">
              {b.pct == null ? "—" : `${b.pct}%`}
            </span>
            <div className="flex w-full flex-1 items-end rounded-sm bg-surface-dim">
              <div
                className={cn("w-full rounded-sm", b.pct == null ? "bg-transparent" : ackRateBarCls(b.pct))}
                style={{ height: b.pct == null ? 0 : `${Math.max(b.pct, 3)}%` }}
                title={b.notices === 0 ? "No notice posted in these five days" : `${b.notices} notice${b.notices === 1 ? "" : "s"} · ${b.acked} of ${b.total} acknowledged`}
              />
            </div>
            <span className="font-mono text-[9px] text-ink-muted">{fmtDate(b.start)}</span>
          </div>
        ))}
      </div>
      <span className="text-[11.5px] leading-[1.5] text-ink-secondary">
        {s.notices === 0
          ? `No notice you can manage was posted in the last ${data.days} days — the bars fill as notices are posted.`
          : `${s.notices} notice${s.notices === 1 ? "" : "s"} posted · ${s.acked} of ${s.total} acknowledgements received (${s.pct ?? 0}%).`}
      </span>
    </div>
  );
}

export function TeamPendingCard() {
  const { can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<TeamPendingResponse>("/api/announcements/team-pending", () =>
    api.get("/api/announcements/team-pending"),
  );
  const [reminding, setReminding] = useState(false);
  const data = q.data?.data;
  if (!data || data.reports === 0) return null;

  const rows = data.pending;
  const people = new Set(rows.map((r) => r.userId)).size;
  const noticeIds = Array.from(new Set(rows.map((r) => r.announcementId)));
  const canRemind = can("announcements.write") && noticeIds.length > 0;

  async function remindAll() {
    const ok = await dialog.confirm({
      title: "Remind your team",
      message: `Re-pop ${noticeIds.length === 1 ? "the notice" : `${noticeIds.length} notices`} for everyone who has not acknowledged? People who already did are unaffected.`,
      confirmLabel: "Remind",
    });
    if (!ok) return;
    setReminding(true);
    let failed = 0;
    for (const id of noticeIds) {
      try {
        await api.post(`/api/announcements/${id}/remind`, { scope: "unacked" });
      } catch {
        failed += 1;
      }
    }
    setReminding(false);
    if (failed === 0) toast.success("Reminders sent");
    else toast.error(`${failed} of ${noticeIds.length} reminders failed`);
    q.reload();
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-[15px] shadow-stone">
      <div className="flex items-baseline justify-between">
        <span className={cn(EYEBROW, "text-ink-secondary")}>My team's pending</span>
        <span
          className={cn(
            "font-money text-[12.5px] font-bold",
            people > 0 ? "text-warning-text" : "text-synced",
          )}
        >
          {people} of {data.reports}
        </span>
      </div>
      <span className="text-[12px] leading-[1.55] text-ink-secondary">
        {people === 0
          ? `No unacknowledged mandatory notice found for your ${data.reports} direct ${data.reports === 1 ? "report" : "reports"} — checked against live notices addressed to them. If you expected one, confirm it is live and targets their department or them.`
          : `${data.reports} ${data.reports === 1 ? "person reports" : "people report"} to you. These have not acknowledged a mandatory notice.`}
      </span>
      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div
              key={`${r.userId}:${r.announcementId}`}
              className="flex items-center gap-2 border-t border-border-subtle pt-2"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-[12.5px] font-semibold text-ink">{r.name}</span>
                <span className="truncate text-[10.5px] text-ink-muted">
                  {r.positionName ? `${r.positionName} · ` : ""}
                  {r.title}
                </span>
              </div>
              <span
                className={cn(
                  "whitespace-nowrap rounded-full px-[7px] py-[2px] font-mono text-[9.5px] font-bold",
                  STATE_CLS[r.state],
                )}
              >
                {r.state}
              </span>
            </div>
          ))}
        </div>
      )}
      {canRemind && (
        <button
          type="button"
          onClick={() => void remindAll()}
          disabled={reminding}
          className="rounded-md bg-primary px-3 py-2 text-[12px] font-bold text-white hover:bg-primary/90 disabled:opacity-50"
        >
          {reminding ? "Reminding…" : `Remind all ${people}`}
        </button>
      )}
    </div>
  );
}
