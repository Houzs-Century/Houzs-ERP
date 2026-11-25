import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api, buildQuery } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../hooks/useToast";
import { cn, formatDate, formatDateTime } from "../../lib/utils";
import { PageHeader } from "../../components/Layout";
import { EmptyState } from "../../components/EmptyState";
import { MediaLightbox } from "../../components/MediaLightbox";
import { parseDefectCaption } from "./defectRemark";
import {
  canPurchaseDefect,
  canReviewDefect,
  defectActionLabel,
  defectStage,
  REVIEWER_DEFECT_ACTIONS,
  PURCHASER_DEFECT_ACTIONS,
  type DefectActionTone,
} from "./defectReviewer";

/** Outline-button Tailwind for a defect action tone (the list only shows idle
 *  buttons — the editor replaces them once one is picked). */
function defectListBtn(tone: DefectActionTone): string {
  switch (tone) {
    case "done":
      return "border-green-300 bg-surface text-green-600 hover:bg-green-50 dark:border-green-800 dark:text-green-300 dark:hover:bg-green-950/40";
    case "escalate":
      return "border-rose-300 bg-surface text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40";
    case "progress":
      return "border-amber-300 bg-surface text-amber-600 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40";
  }
}
/** Badge Tailwind for a stored status: resolved green, in-progress/fresh amber,
 *  escalated rose. */
function defectListBadge(status: string | null): string {
  const stage = defectStage(status);
  if (stage === "resolved") return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (stage === "fresh" || (status ?? "").toLowerCase() === "in_progress")
    return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300";
}

/**
 * Projects › Defect List (owner 2026-11-20).
 *
 * Every OPEN defect photo across the company in one page, so the service team
 * reviews defects without opening each project one by one. Feeds from
 * GET /api/projects/defect-list (gated projects.list). Open-only by default; the
 * "All" toggle shows resolved (Done) photos too.
 *
 * Acting on a defect reuses the SAME append-only route the project detail and
 * mobile cards use (POST /checklist/attachments/:id/actions). Who may act is the
 * one shared gate in defectReviewer.ts, keyed on EACH row's state — the region
 * split means a user is a reviewer for some events and not others.
 */

interface DefectRow {
  attachment_id: number;
  r2_key: string;
  file_name: string;
  content_type: string | null;
  caption: string | null;
  uploaded_at: string | null;
  uploader_name: string | null;
  item_id: number;
  item_title: string;
  item_status: string;
  project_id: number;
  code: string;
  name: string;
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  latest_status: string | null;
  latest_remark: string | null;
  latest_at: string | null;
  latest_user_name: string | null;
}

interface DefectResponse {
  rows: DefectRow[];
}

interface ProjectGroup {
  project_id: number;
  code: string;
  name: string;
  state: string | null;
  brand: string | null;
  organizer: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  rows: DefectRow[];
}

/** Group the flat feed by project, preserving the server's ordering (most
 *  recent event first, newest photo first within it). */
function groupByProject(rows: DefectRow[]): ProjectGroup[] {
  const order: number[] = [];
  const by = new Map<number, ProjectGroup>();
  for (const r of rows) {
    let g = by.get(r.project_id);
    if (!g) {
      g = {
        project_id: r.project_id,
        code: r.code,
        name: r.name,
        state: r.state,
        brand: r.brand,
        organizer: r.organizer,
        venue: r.venue,
        booth_no: r.booth_no,
        start_date: r.start_date,
        end_date: r.end_date,
        rows: [],
      };
      by.set(r.project_id, g);
      order.push(r.project_id);
    }
    g.rows.push(r);
  }
  return order.map((id) => by.get(id)!);
}

// A lazily-fetched thumbnail (same auth'd blob fetch the full viewer uses).
// Revoked on unmount; a non-image or a failed fetch leaves a hatched box.
function DefectThumb({
  r2Key,
  contentType,
  onOpen,
}: {
  r2Key: string;
  contentType: string | null;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = /^image\//i.test(contentType ?? "");
  useEffect(() => {
    if (!isImage) return;
    let live = true;
    let made: string | null = null;
    api
      .fetchBlobUrl(`/api/projects/attachments/${r2Key}`)
      .then((u) => {
        if (live) {
          made = u;
          setUrl(u);
        } else URL.revokeObjectURL(u);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [r2Key, isImage]);
  const box: CSSProperties = {
    width: 96,
    height: 96,
    borderRadius: 8,
    overflow: "hidden",
    flex: "none",
  };
  if (!isImage) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center justify-center rounded-lg border border-border bg-surface text-[10px] font-semibold text-ink-muted"
        style={box}
      >
        Open file
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} className="border border-border-subtle" style={box} title="Open photo">
      {url ? (
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <div className="ph h-full w-full" />
      )}
    </button>
  );
}

export function DefectListView() {
  const { user } = useAuth();
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // One action editor open at a time, keyed by attachment id.
  const [draft, setDraft] = useState<{ attId: number; status: string } | null>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);

  const q = useQuery<DefectResponse>(
    ["defect-list", showAll],
    (signal) =>
      api.get(`/api/projects/defect-list${buildQuery({ all: showAll ? "1" : undefined })}`, { signal }),
    [showAll],
    { keepPreviousData: true },
  );

  // Solo events only (owner 2026-11-24): the mall-management ("MALL MGMT")
  // events are handled elsewhere, so this list hides any event whose name
  // carries the MALL MGMT organizer and shows only the solo roadshows. Filtered
  // at the row level so the count, the grouping and the photo viewer all agree.
  const rows = useMemo(
    () => (q.data?.rows ?? []).filter((r) => !/mall\s*mgmt/i.test(r.name)),
    [q.data],
  );
  const groups = useMemo(() => groupByProject(rows), [rows]);
  const mediaItems = useMemo(
    () => rows.map((r) => ({ r2_key: r.r2_key, content_type: r.content_type, caption: r.caption })),
    [rows],
  );

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await api.post(`/api/projects/checklist/attachments/${draft.attId}/actions`, {
        status: draft.status,
        remark,
      });
      setDraft(null);
      setRemark("");
      toast.success(`Marked ${defectActionLabel(draft.status)}`);
      q.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save — please try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Operations · Projects"
        title="Defect List"
        description="Open defect photos across every project — review and action without opening each one."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className={cn(
              "px-3 py-1.5 text-xs font-semibold",
              !showAll ? "bg-ink text-white" : "bg-surface text-ink-secondary hover:bg-surface-2",
            )}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className={cn(
              "border-l border-border px-3 py-1.5 text-xs font-semibold",
              showAll ? "bg-ink text-white" : "bg-surface text-ink-secondary hover:bg-surface-2",
            )}
          >
            All
          </button>
        </div>
        <button
          type="button"
          onClick={() => q.reload()}
          disabled={q.fetching}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:border-accent/40 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", q.fetching && "animate-spin")} />
          Refresh
        </button>
        <span className="text-xs text-ink-muted">
          {rows.length} defect{rows.length === 1 ? "" : "s"} · {groups.length} project
          {groups.length === 1 ? "" : "s"}
        </span>
      </div>

      {q.error && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {q.error}
        </div>
      )}

      {q.loading && rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-ink-muted">Loading…</div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle size={28} />}
          message={showAll ? "No defects" : "No open defects"}
          description={
            showAll
              ? "No defect photos uploaded yet."
              : "Switch the toggle above to include defects that are already closed."
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.project_id} className="rounded-xl border border-border bg-surface">
              <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border-subtle px-4 py-2.5">
                <Link
                  to={`/projects/${g.project_id}`}
                  className="text-sm font-bold text-ink hover:text-accent hover:underline"
                >
                  {g.name}
                </Link>
                {g.start_date && (
                  <span className="text-xs font-medium text-ink-secondary">
                    · {formatDate(g.start_date)}
                    {g.end_date && g.end_date.slice(0, 10) !== g.start_date.slice(0, 10)
                      ? `–${formatDate(g.end_date)}`
                      : ""}
                  </span>
                )}
                {g.state && <span className="text-xs text-ink-muted">· {g.state}</span>}
                {g.booth_no && <span className="text-xs text-ink-muted">· Booth {g.booth_no}</span>}
                <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  {g.rows.length} defect{g.rows.length === 1 ? "" : "s"}
                </span>
              </header>
              <div className="divide-y divide-border-subtle">
                {g.rows.map((r) => {
                  const idx = rows.indexOf(r);
                  const { model, reason } = parseDefectCaption(r.caption);
                  const latest = r.latest_status;
                  const stage = defectStage(latest);
                  const canReview = canReviewDefect(user, r.state);
                  const canPurchase = canPurchaseDefect(user);
                  const editing = draft?.attId === r.attachment_id;
                  return (
                    <div key={r.attachment_id} className="flex gap-3 px-4 py-3">
                      <DefectThumb
                        r2Key={r.r2_key}
                        contentType={r.content_type}
                        onOpen={() => setLightbox(idx)}
                      />
                      <div className="min-w-0 flex-1">
                        {/* Model / Reason the uploader recorded. */}
                        {(model || reason) && (
                          <div className="rounded-md border-l-[3px] border-amber-400 bg-surface-2 px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-secondary">
                            {model && (
                              <div>
                                <b className="text-accent">Model:</b> {model}
                              </div>
                            )}
                            {reason && (
                              <div className="whitespace-pre-wrap break-words">
                                <b className="text-accent">Reason:</b> {reason}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-ink-muted">
                          <span className={cn("rounded px-1.5 py-0.5 font-bold", defectListBadge(latest))}>
                            {stage === "fresh" ? "New" : defectActionLabel(latest)}
                          </span>
                          {r.latest_at && (
                            <span>
                              {r.latest_user_name || "—"} · {formatDateTime(r.latest_at)}
                            </span>
                          )}
                          {r.uploader_name && stage === "fresh" && <span>Upload: {r.uploader_name}</span>}
                        </div>
                        {r.latest_remark && (
                          <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-ink-secondary">
                            {r.latest_remark}
                          </div>
                        )}

                        {/* Action buttons — same gate and route as the project
                            detail card. Fresh → reviewer (Done Clean / Exchange /
                            Service); escalated → purchaser (In Progress / Done).
                            Every button opens the remark editor before it saves. */}
                        {((stage === "fresh" && canReview) || (stage === "purchaser" && canPurchase)) &&
                          !editing && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {(stage === "fresh" ? REVIEWER_DEFECT_ACTIONS : PURCHASER_DEFECT_ACTIONS).map((a) => (
                                <button
                                  key={a.status}
                                  type="button"
                                  onClick={() => {
                                    setDraft({ attId: r.attachment_id, status: a.status });
                                    setRemark("");
                                  }}
                                  className={cn(
                                    "rounded-full border px-2.5 py-0.5 text-[10px] font-bold",
                                    defectListBtn(a.tone),
                                  )}
                                >
                                  {a.label}
                                </button>
                              ))}
                            </div>
                          )}
                        {editing && (
                          <div className="mt-1.5">
                            <textarea
                              value={remark}
                              onChange={(e) => setRemark(e.target.value)}
                              disabled={saving}
                              rows={2}
                              placeholder="Add a remark (optional)…"
                              className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1 text-[11px] leading-snug outline-none focus:border-primary disabled:opacity-60"
                            />
                            <div className="mt-1 flex items-center justify-end gap-1.5">
                              <span className="mr-auto text-[10.5px] font-semibold text-ink-muted">
                                Mark {defectActionLabel(draft.status)}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setDraft(null);
                                  setRemark("");
                                }}
                                disabled={saving}
                                className="rounded-md border border-border bg-surface px-2.5 py-1 text-[10px] font-semibold text-ink-secondary hover:border-accent/40"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void save()}
                                disabled={saving}
                                className="rounded-md bg-ink px-2.5 py-1 text-[10px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                              >
                                {saving ? "Saving…" : "Save"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {lightbox !== null && (
        <MediaLightbox
          items={mediaItems}
          index={lightbox}
          onChange={setLightbox}
          onClose={() => setLightbox(null)}
          baseUrl="/api/projects/attachments"
        />
      )}
    </div>
  );
}
