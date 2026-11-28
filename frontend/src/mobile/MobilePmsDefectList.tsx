import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, buildQuery } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { fmtDateTime } from "../vendor/shared/format";
import { MediaLightbox, type MediaItem } from "../components/MediaLightbox";
import { DateField } from "../vendor/scm/components/DateField";
import { parseDefectCaption } from "../pages/projects/defectRemark";
import {
  canPurchaseDefect,
  canReviewDefect,
  defectActionLabel,
  defectStage,
  REVIEWER_DEFECT_ACTIONS,
  PURCHASER_DEFECT_ACTIONS,
  type DefectActionTone,
} from "../pages/projects/defectReviewer";
import "./mobile.css";

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
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  rows: DefectRow[];
}

function dateKey(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 10).replace(/\//g, "-");
}

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
    width: 76,
    height: 76,
    borderRadius: 9,
    overflow: "hidden",
    flex: "none",
    border: "1px solid var(--hz-c-border-subtle)",
    background: "var(--hz-c-surface)",
    padding: 0,
  };
  if (!isImage) {
    return (
      <button
        type="button"
        onClick={onOpen}
        style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "var(--hz-c-ink-soft)" }}
      >
        Open file
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} style={box} title="Open photo">
      {url ? (
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <div className="ph" style={{ width: "100%", height: "100%" }} />
      )}
    </button>
  );
}

function toneBorderFg(tone: DefectActionTone): { border: string; fg: string } {
  switch (tone) {
    case "done":
      return { border: "#bcdcd7", fg: "var(--hz-c-synced)" };
    case "escalate":
      return { border: "#e6bcbc", fg: "#b4362f" };
    case "progress":
      return { border: "#e6cfa0", fg: "#9a6b12" };
  }
}

function badgeTint(status: string | null): { bg: string; fg: string } {
  const stage = defectStage(status);
  if (stage === "resolved") return { bg: "var(--hz-c-synced-bg)", fg: "var(--hz-c-synced)" };
  if (stage === "fresh" || (status ?? "").toLowerCase() === "in_progress")
    return { bg: "var(--hz-c-warning-bg)", fg: "var(--hz-c-warning-text)" };
  return { bg: "#f7e3e3", fg: "#b4362f" };
}

export function MobilePmsDefectList({
  onBack,
  onOpenProject,
}: {
  onBack?: () => void;
  onOpenProject?: (id: number) => void;
}) {
  const { user } = useAuth();
  const notify = useNotify();
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ attId: number; status: string } | null>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);

  const q = useQuery({
    queryKey: ["mobile-defect-list", showAll],
    queryFn: ({ signal }) =>
      api.get<DefectResponse>(
        `/api/projects/defect-list${buildQuery({ all: showAll ? "1" : undefined })}`,
        { signal },
      ),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  const allRows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const hasFilter = search.trim() !== "" || dateFrom !== "" || dateTo !== "";

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (term) {
        const hay = [r.name, r.code, r.brand, r.organizer, r.venue, r.booth_no, r.state]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (dateFrom || dateTo) {
        const start = dateKey(r.start_date);
        const end = dateKey(r.end_date) || start;
        if (!start && !end) return false;
        if (dateFrom && end && end < dateFrom) return false;
        if (dateTo && start && start > dateTo) return false;
      }
      return true;
    });
  }, [allRows, search, dateFrom, dateTo]);

  const groups = useMemo(() => groupByProject(rows), [rows]);
  const mediaItems: MediaItem[] = useMemo(
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
      await q.refetch();
    } catch (e) {
      await notify({
        title: "Not saved",
        body: e instanceof Error ? e.message : "Please try again.",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {onBack && (
              <span onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 22, lineHeight: 1, color: "var(--brand)", cursor: "pointer" }}>‹</span>
            )}
            <div>
              <div className="eyebrow">PMS</div>
              <div className="scr-title">Defect List</div>
            </div>
          </div>
          <button
            type="button"
            className="tinybtn"
            style={{ marginLeft: "auto" }}
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
          >
            {q.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        <div className="chips" style={{ marginTop: 11 }}>
          <button onClick={() => setShowAll(false)} className={!showAll ? "chip on" : "chip"}>Belum settle</button>
          <button onClick={() => setShowAll(true)} className={showAll ? "chip on" : "chip"}>Semua</button>
          <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 11, color: "var(--hz-c-ink-soft)" }}>
            {rows.length} defect{rows.length === 1 ? "" : "s"} · {groups.length} project{groups.length === 1 ? "" : "s"}
            {hasFilter && allRows.length !== rows.length ? ` (of ${allRows.length})` : ""}
          </span>
        </div>

        <div className="hdr-row" style={{ marginTop: 10 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search event · booth · organizer" />
          </div>
        </div>
        <div className="hdr-row" style={{ marginTop: 8, gap: 8, alignItems: "flex-end" }}>
          <label style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>
            From
            <DateField
              value={dateFrom}
              max={dateTo || undefined}
              onChange={setDateFrom}
              fullWidth
              aria-label="From date"
              style={{ marginTop: 2 }}
            />
          </label>
          <label style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>
            To
            <DateField
              value={dateTo}
              min={dateFrom || undefined}
              onChange={setDateTo}
              fullWidth
              aria-label="To date"
              style={{ marginTop: 2 }}
            />
          </label>
          {hasFilter && (
            <button
              type="button"
              className="tinybtn"
              style={{ flex: "none" }}
              onClick={() => { setSearch(""); setDateFrom(""); setDateTo(""); }}
            >
              Clear
            </button>
          )}
        </div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {q.isLoading && rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--hz-c-ink-soft)", fontSize: 12, padding: "26px 0" }}>Loading…</div>
        )}
        {q.error && (
          <div style={{ textAlign: "center", color: "var(--hz-c-err)", fontSize: 12, padding: "26px 0" }}>
            Couldn't load defects. Tap Refresh to retry.
          </div>
        )}
        {!q.isLoading && !q.error && groups.length === 0 && (
          <div className="empty">
            <div className="empty-t">{hasFilter ? "No matches" : showAll ? "No defects" : "No open defects"}</div>
            <div className="empty-s">
              {hasFilter
                ? "No defects match your search or date range. Tap Clear to see all."
                : showAll
                  ? "No defect photos have been uploaded on any project yet."
                  : "Every defect has been settled. Switch to Semua to see the closed ones."}
            </div>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.project_id} className="card" style={{ marginBottom: 12 }}>
            <div
              className="card-b"
              style={{ padding: "10px 12px", borderBottom: "1px solid #f0f1ed", display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}
            >
              <span
                role={onOpenProject ? "button" : undefined}
                onClick={onOpenProject ? () => onOpenProject(g.project_id) : undefined}
                style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", cursor: onOpenProject ? "pointer" : "default", lineHeight: 1.3 }}
              >
                {g.name}
              </span>
              {g.state && <span style={{ fontSize: 10.5, color: "var(--mut)" }}>· {g.state}</span>}
              {g.booth_no && <span style={{ fontSize: 10.5, color: "var(--mut)" }}>· Booth {g.booth_no}</span>}
              <span className="rbadge" style={{ marginLeft: "auto", background: "var(--hz-c-warning-bg)", color: "var(--hz-c-warning-text)" }}>
                {g.rows.length} defect{g.rows.length === 1 ? "" : "s"}
              </span>
            </div>

            <div>
              {g.rows.map((r) => {
                const idx = rows.indexOf(r);
                const { model, reason } = parseDefectCaption(r.caption);
                const latest = r.latest_status;
                const stage = defectStage(latest);
                const canReview = canReviewDefect(user, r.state);
                const canPurchase = canPurchaseDefect(user);
                const editing = draft?.attId === r.attachment_id;
                const tint = badgeTint(latest);
                return (
                  <div key={r.attachment_id} style={{ display: "flex", gap: 10, padding: "11px 12px", borderTop: "1px solid #f4f5f1" }}>
                    <DefectThumb r2Key={r.r2_key} contentType={r.content_type} onOpen={() => setLightbox(idx)} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      {(model || reason) && (
                        <div style={{ background: "var(--hz-dk-surface-2, #faf9f5)", borderLeft: "3px solid #d8a85a", borderRadius: 7, padding: "6px 9px", fontSize: 11.5, lineHeight: 1.45, color: "var(--hz-c-ink-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {model && <div><b style={{ color: "var(--hz-c-accent)" }}>Model:</b> {model}</div>}
                          {reason && <div><b style={{ color: "var(--hz-c-accent)" }}>Reason:</b> {reason}</div>}
                        </div>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 5 }}>
                        <span className="rbadge" style={{ background: tint.bg, color: tint.fg, fontWeight: 700 }}>
                          {stage === "fresh" ? "New" : defectActionLabel(latest)}
                        </span>
                        {r.latest_at && (
                          <span style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>
                            {r.latest_user_name || "—"} · {fmtDateTime(r.latest_at)}
                          </span>
                        )}
                        {r.uploader_name && stage === "fresh" && (
                          <span style={{ fontSize: 10.5, color: "var(--hz-c-ink-soft)" }}>Upload: {r.uploader_name}</span>
                        )}
                      </div>
                      {r.latest_remark && (
                        <div style={{ fontSize: 11.5, color: "#6b6f63", marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {r.latest_remark}
                        </div>
                      )}

                      {((stage === "fresh" && canReview) || (stage === "purchaser" && canPurchase)) && !editing && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
                          {(stage === "fresh" ? REVIEWER_DEFECT_ACTIONS : PURCHASER_DEFECT_ACTIONS).map((a) => {
                            const c = toneBorderFg(a.tone);
                            return (
                              <button
                                key={a.status}
                                className="tinybtn"
                                style={{ borderColor: c.border, color: c.fg, fontWeight: 700 }}
                                onClick={() => { setDraft({ attId: r.attachment_id, status: a.status }); setRemark(""); }}
                              >
                                {a.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {editing && (
                        <div style={{ marginTop: 7 }}>
                          <textarea
                            className="fld-i"
                            value={remark}
                            disabled={saving}
                            rows={2}
                            onChange={(e) => setRemark(e.target.value)}
                            placeholder="Add a remark (optional)…"
                            style={{ fontSize: 12, padding: "5px 8px", resize: "vertical" }}
                          />
                          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginTop: 4 }}>
                            <span style={{ marginRight: "auto", fontSize: 10.5, fontWeight: 700, color: "var(--hz-c-ink-soft)" }}>
                              Mark {defectActionLabel(draft.status)}
                            </span>
                            <button className="tinybtn" disabled={saving} onClick={() => { setDraft(null); setRemark(""); }}>Cancel</button>
                            <button className="tinybtn" disabled={saving} style={{ background: "#11140f", borderColor: "#11140f", color: "#fff" }} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

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
