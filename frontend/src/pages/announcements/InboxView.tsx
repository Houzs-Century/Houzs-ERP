import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Search } from "lucide-react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { AnnouncementMedia } from "../../components/AnnouncementMedia";
import { AnnouncementRichBody } from "../../components/AnnouncementRichBody";
import { cn, relativeTime } from "../../lib/utils";
import { fmtDateTime } from "../../vendor/shared/format";
import {
  CATEGORY_META,
  INBOX_FILTERS,
  MANAGE_ONLY_FILTERS,
  ackPercent,
  audienceLabel,
  bucketInbox,
  categoryOf,
  companyScopeLabel,
  docNo,
  isPendingForMe,
  type Announcement,
  type Company,
  type InboxFilter,
  type NameLookups,
} from "./announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// InboxView — the reader's default view of /announcements (design handoff
// 2026-09-04, screen 1): a list on the left — pinned "Needs your
// confirmation" group, Recent, and the permanent SOP Library grouped by
// department — and a reading pane on the right with the read-receipts card
// (writers only) and the sticky acknowledge bar (pending notices only).
//
// The list column is 396px by design and RESIZABLE by the reader (owner ask
// 2026-09-05: "可以自主调整大小"): a drag handle on its right edge, clamped
// to [LIST_WIDTH_MIN, LIST_WIDTH_MAX], double-click resets, remembered per
// user in localStorage. Rows never scroll sideways — a title that does not
// fit wraps onto the next line, whatever the width.
//
// Presentational: every fact (what is addressed to me, what I have acked, who
// may manage) arrives as props so the page owns the fetches and this file can
// be rendered in a test with plain data.
// ────────────────────────────────────────────────────────────────────────────

export type ReceiptsSummary = { total: number; ackedCount: number } | null;

export type InboxViewProps = {
  items: Announcement[];
  loading: boolean;
  /** Ids ADDRESSED to me (the /banner human slice) — only these can be pending. */
  addressedIds: ReadonlySet<string>;
  /** Ids I have acknowledged (server + this session). */
  ackedIds: ReadonlySet<string>;
  currentUserId: number | null;
  companies: Company[];
  lookups: NameLookups;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: InboxFilter;
  onFilter: (f: InboxFilter) => void;
  search: string;
  onSearch: (q: string) => void;
  /** May this reader manage the notice (receipts card, remind, hide)? */
  canManage: (a: Announcement) => boolean;
  /** Is "Remind later" still available for this notice? */
  canPostpone: (a: Announcement) => boolean;
  onAck: (a: Announcement) => void;
  onPostpone: (a: Announcement) => void;
  onOpenManage: (a: Announcement) => void;
  onRemindPending: (a: Announcement) => void;
  onHide: (a: Announcement) => void;
  /** Read receipts for the SELECTED notice (writers only). */
  receipts: ReceiptsSummary;
  receiptsLoading: boolean;
  className?: string;
};

/** The design's list width, and the range a reader may drag it to. */
export const LIST_WIDTH_DEFAULT = 396;
export const LIST_WIDTH_MIN = 260;
export const LIST_WIDTH_MAX = 640;

/** Any stored / dragged value → a width inside the allowed range. */
export function clampListWidth(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return LIST_WIDTH_DEFAULT;
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, Math.round(n)));
}

export function listWidthStorageKey(userId: number | null): string {
  return `announcements:inbox-width:u${userId ?? 0}`;
}

// Every list row: a 3px category rail + content that may SHRINK below its
// intrinsic width (minmax(0,1fr)), so long titles wrap instead of pushing the
// column into a horizontal scroll.
const ROW_GRID = "grid shrink-0 cursor-pointer grid-cols-[3px_minmax(0,1fr)] border-b border-border-subtle";

// Pill geometry shared by the list rows and the reading pane.
const PILL =
  "inline-flex items-center rounded-full px-[7px] py-[2px] text-[9.5px] font-bold uppercase tracking-[.06em]";
const EYEBROW = "font-mono text-[10px] font-bold uppercase tracking-wider";
const SECONDARY_BTN =
  "rounded-md border border-border bg-surface text-ink-secondary hover:bg-surface-dim hover:text-ink";

export function InboxView(p: InboxViewProps) {
  const buckets = useMemo(
    () =>
      bucketInbox({
        items: p.items,
        addressedIds: p.addressedIds,
        ackedIds: p.ackedIds,
        currentUserId: p.currentUserId,
        filter: p.filter,
        search: p.search,
        lookups: p.lookups,
      }),
    [p.items, p.addressedIds, p.ackedIds, p.currentUserId, p.filter, p.search, p.lookups],
  );

  const selected = p.selectedId
    ? p.items.find((a) => a.id === p.selectedId) ?? null
    : null;

  // ── Resizable list column ──────────────────────────────────────────────
  const [listWidth, setListWidth] = useLocalStorage<number>(
    listWidthStorageKey(p.currentUserId),
    LIST_WIDTH_DEFAULT,
    undefined,
    clampListWidth,
  );
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setListWidth(clampListWidth(d.startW + (e.clientX - d.startX)));
    },
    [setListWidth],
  );
  const endDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", endDrag);
  }, [onDragMove]);
  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: listWidth };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", endDrag);
    },
    [listWidth, onDragMove, endDrag],
  );
  useEffect(() => endDrag, [endDrag]);
  const nudge = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 40 : 16;
      if (e.key === "ArrowLeft") setListWidth((w) => clampListWidth(w - step));
      else if (e.key === "ArrowRight") setListWidth((w) => clampListWidth(w + step));
      else if (e.key === "Home") setListWidth(LIST_WIDTH_DEFAULT);
      else return;
      e.preventDefault();
    },
    [setListWidth],
  );

  return (
    <div
      className={cn("grid min-h-0", p.className)}
      style={{ gridTemplateColumns: `${listWidth}px 7px minmax(0,1fr)` }}
    >
      {/* ── Left list ──────────────────────────────────────────────────── */}
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden bg-surface"
        data-testid="inbox-list"
      >
        <div className="flex shrink-0 flex-col gap-2.5 px-3.5 py-3">
          <label className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2">
            <Search size={13} className="shrink-0 text-ink-muted" />
            <input
              type="search"
              value={p.search}
              onChange={(e) => p.onSearch(e.target.value)}
              placeholder="Search title, body, author"
              aria-label="Search announcements"
              className="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-muted"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {INBOX_FILTERS.filter((f) => !MANAGE_ONLY_FILTERS.has(f.id)).map((f) => {
              const active = p.filter === f.id;
              const label =
                f.id === "pending" && buckets.pending.length > 0
                  ? `${f.label} ${buckets.pending.length}`
                  : f.label;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => p.onFilter(f.id)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] font-[650]",
                    active
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-surface text-ink-secondary hover:bg-surface-dim",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {p.loading && p.items.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[12px] text-ink-muted">Loading…</div>
        ) : (
          <>
            {buckets.pending.length > 0 && (
              <>
                <GroupHeader
                  label="Needs your confirmation"
                  count={buckets.pending.length}
                  cls="bg-err-bg text-err"
                />
                {buckets.pending.map((a) => (
                  <PinnedRow
                    key={a.id}
                    a={a}
                    selected={a.id === p.selectedId}
                    lookups={p.lookups}
                    onSelect={() => p.onSelect(a.id)}
                  />
                ))}
              </>
            )}

            <GroupHeader
              label="Recent"
              count={buckets.recent.length}
              cls="bg-surface-2 text-ink-secondary"
              countCls="text-ink-muted"
            />
            {buckets.recent.length === 0 ? (
              <div className="shrink-0 px-3.5 py-4 text-[11.5px] text-ink-muted">
                {p.filter === "pending" ? "Only pending notices are shown." : "Nothing here."}
              </div>
            ) : (
              buckets.recent.map((a) => (
                <RecentRow
                  key={a.id}
                  a={a}
                  selected={a.id === p.selectedId}
                  addressed={p.addressedIds.has(a.id)}
                  acked={p.ackedIds.has(a.id)}
                  lookups={p.lookups}
                  onSelect={() => p.onSelect(a.id)}
                />
              ))
            )}

            <GroupHeader
              label="SOP Library · never expires"
              count={buckets.sopCount}
              cls="bg-accent-soft text-accent"
            />
            {buckets.sopGroups.length === 0 ? (
              <div className="shrink-0 px-3.5 py-4 text-[11.5px] text-ink-muted">No SOPs yet.</div>
            ) : (
              buckets.sopGroups.map((g) => (
                <div key={g.dept} className="shrink-0">
                  <div className="bg-surface-2 px-3.5 py-1">
                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-ink-muted">
                      {g.dept}
                    </span>
                  </div>
                  {g.items.map((a) => (
                    <SopRow
                      key={a.id}
                      a={a}
                      selected={a.id === p.selectedId}
                      onSelect={() => p.onSelect(a.id)}
                    />
                  ))}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* ── Drag handle: the list's right edge ─────────────────────────── */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the notice list"
        aria-valuemin={LIST_WIDTH_MIN}
        aria-valuemax={LIST_WIDTH_MAX}
        aria-valuenow={listWidth}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={() => setListWidth(LIST_WIDTH_DEFAULT)}
        onKeyDown={nudge}
        className="group relative z-10 -ml-px flex cursor-col-resize items-center justify-center border-l border-border bg-surface outline-none hover:bg-primary/10 focus-visible:bg-primary/10 active:bg-primary/20"
      >
        <span
          aria-hidden
          className="h-8 w-[3px] rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary/60"
        />
      </div>

      {/* ── Reading pane ───────────────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-col bg-bg">
        {selected ? (
          <ReadingPane
            a={selected}
            pending={isPendingForMe(selected, p.addressedIds, p.ackedIds)}
            companies={p.companies}
            lookups={p.lookups}
            canManage={p.canManage(selected)}
            canPostpone={p.canPostpone(selected)}
            receipts={p.receipts}
            receiptsLoading={p.receiptsLoading}
            onAck={() => p.onAck(selected)}
            onPostpone={() => p.onPostpone(selected)}
            onOpenManage={() => p.onOpenManage(selected)}
            onRemindPending={() => p.onRemindPending(selected)}
            onHide={() => p.onHide(selected)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-[12.5px] text-ink-muted">
            {p.loading ? "Loading…" : "Select a notice to read it."}
          </div>
        )}
      </div>
    </div>
  );
}

// ── List pieces ────────────────────────────────────────────────────────────

function GroupHeader({
  label,
  count,
  cls,
  countCls,
}: {
  label: string;
  count: number;
  cls: string;
  countCls?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between border-y border-border px-3.5 py-1.5",
        cls,
      )}
    >
      <span className={EYEBROW}>{label}</span>
      <span className={cn("font-money text-[11px] font-bold", countCls)}>{count}</span>
    </div>
  );
}

// `author · audience`; just the audience while the author's name is unknown
// (older payloads without createdByName) — never a placeholder dash.
function byLine(a: Announcement, lookups: NameLookups): string {
  const who = a.createdByName?.trim();
  const audience = audienceLabel(a, lookups);
  return who ? `${who} · ${audience}` : audience;
}

function PinnedRow({
  a,
  selected,
  lookups,
  onSelect,
}: {
  a: Announcement;
  selected: boolean;
  lookups: NameLookups;
  onSelect: () => void;
}) {
  const meta = CATEGORY_META[categoryOf(a)];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      className={cn(ROW_GRID, selected ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim")}
    >
      <div className={meta.railCls} />
      <div className="flex flex-col gap-[5px] px-3.5 py-[11px]">
        <div className="flex items-center gap-1.5">
          <span className={cn(PILL, meta.pillCls)}>{meta.label}</span>
          <span className="ml-auto font-mono text-[10px] text-ink-muted">
            {relativeTime(a.createdAt)}
          </span>
        </div>
        <span className="break-words text-[13.5px] font-[680] leading-[1.35] text-ink">{a.title}</span>
        {a.body && (
          <span className="line-clamp-2 text-[11.5px] leading-[1.45] text-ink-secondary">
            {a.body}
          </span>
        )}
        <span className="text-[11px] text-ink-muted">{byLine(a, lookups)}</span>
      </div>
    </div>
  );
}

function RecentRow({
  a,
  selected,
  addressed,
  acked,
  lookups,
  onSelect,
}: {
  a: Announcement;
  selected: boolean;
  addressed: boolean;
  acked: boolean;
  lookups: NameLookups;
  onSelect: () => void;
}) {
  const meta = CATEGORY_META[categoryOf(a)];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      className={cn(ROW_GRID, selected ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim")}
    >
      <div />
      <div className="flex flex-col gap-1 px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className={cn(PILL, meta.pillCls)}>{meta.label}</span>
          {/* Confirmed / Unread only for a notice addressed to ME — a manager
              reading someone else's audience has nothing to confirm. */}
          {addressed && (
            <span
              className={cn(
                "rounded-full px-[7px] py-[2px] text-[9.5px] font-bold",
                acked ? "bg-synced-bg text-synced" : "bg-err-bg text-err",
              )}
            >
              {acked ? "Confirmed" : "Unread"}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-ink-muted">
            {relativeTime(a.createdAt)}
          </span>
        </div>
        <span className="break-words text-[13px] font-semibold leading-[1.35] text-ink-secondary">
          {a.title}
        </span>
        <span className="text-[11px] text-ink-muted">{byLine(a, lookups)}</span>
      </div>
    </div>
  );
}

function SopRow({
  a,
  selected,
  onSelect,
}: {
  a: Announcement;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={selected}
      className={cn(ROW_GRID, selected ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim")}
    >
      <div className="bg-accent" />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 py-[9px]">
        <span className="min-w-0 flex-1 basis-[12ch] break-words text-[12.5px] font-semibold leading-[1.35] text-ink-secondary">
          {a.title}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-muted">{docNo(a)}</span>
      </div>
    </div>
  );
}

// ── Reading pane ───────────────────────────────────────────────────────────

function ReadingPane({
  a,
  pending,
  companies,
  lookups,
  canManage,
  canPostpone,
  receipts,
  receiptsLoading,
  onAck,
  onPostpone,
  onOpenManage,
  onRemindPending,
  onHide,
}: {
  a: Announcement;
  pending: boolean;
  companies: Company[];
  lookups: NameLookups;
  canManage: boolean;
  canPostpone: boolean;
  receipts: ReceiptsSummary;
  receiptsLoading: boolean;
  onAck: () => void;
  onPostpone: () => void;
  onOpenManage: () => void;
  onRemindPending: () => void;
  onHide: () => void;
}) {
  const meta = CATEGORY_META[categoryOf(a)];
  const scope = companyScopeLabel(a.targetCompanyIds, companies);
  const pct = receipts ? ackPercent(receipts.ackedCount, receipts.total) : 0;
  const atts = a.attachments ?? [];

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-8 py-6">
        <div className="flex max-w-[720px] flex-col gap-[18px]">
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-[9px] py-[3px] text-[10.5px] font-bold uppercase tracking-[.06em]",
                  meta.pillCls,
                )}
              >
                {meta.label}
                {pending && " · must acknowledge"}
              </span>
              <span className="rounded-full border border-border bg-surface-dim px-[9px] py-[3px] font-mono text-[10.5px] text-ink-secondary">
                {docNo(a)}
              </span>
              {companies.length > 1 && scope && (
                <span className="rounded-full border border-border bg-surface-dim px-[9px] py-[3px] font-mono text-[10.5px] text-ink-secondary">
                  {scope}
                </span>
              )}
            </div>
            <h1 className="m-0 text-pretty text-[26px] font-[680] leading-[1.25] text-ink">
              {a.title}
            </h1>
            <div className="flex flex-wrap gap-3.5 text-[12px] text-ink-muted">
              {a.createdByName?.trim() && <span>{a.createdByName.trim()}</span>}
              <span className="font-mono">{fmtDateTime(a.createdAt)}</span>
              <span>To: {audienceLabel(a, lookups)}</span>
            </div>
          </div>

          <div className="border-t border-border" />

          <AnnouncementRichBody
            html={a.bodyHtml}
            text={a.body}
            annId={a.id}
            className="text-[14px] leading-[1.75] text-ink-secondary"
          />

          {atts.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className={cn(EYEBROW, "text-ink-muted")}>Attachments</span>
              <AnnouncementMedia
                annId={a.id}
                attachments={atts}
                layout={a.mediaLayout ?? null}
              />
            </div>
          )}

          {canManage && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3.5 shadow-stone">
              <div className="flex items-baseline justify-between">
                <span className={cn(EYEBROW, "text-ink-secondary")}>Read receipts</span>
                <span className="font-money text-[12.5px] font-[650] text-ink">
                  {receiptsLoading && !receipts
                    ? "…"
                    : receipts
                      ? `${receipts.ackedCount} / ${receipts.total} confirmed`
                      : "—"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-dim">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onOpenManage}
                  className={cn(SECONDARY_BTN, "px-[11px] py-1.5 text-[11.5px] font-[650]")}
                >
                  Open in Manage
                </button>
                <button
                  type="button"
                  onClick={onRemindPending}
                  disabled={!receipts || receipts.ackedCount >= receipts.total}
                  className={cn(
                    SECONDARY_BTN,
                    "px-[11px] py-1.5 text-[11.5px] font-[650] disabled:opacity-50",
                  )}
                >
                  Remind pending
                </button>
                <button
                  type="button"
                  onClick={onHide}
                  className={cn(SECONDARY_BTN, "px-[11px] py-1.5 text-[11.5px] font-[650]")}
                >
                  {a.isActive ? "Hide" : "Show"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {pending && (
        <div className="flex shrink-0 items-center gap-3.5 border-t border-border bg-surface px-8 py-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-[650] text-ink">
              This notice requires acknowledgement
            </span>
            <span className="text-[11.5px] text-ink-muted">
              Your name and timestamp are recorded for the poster.
            </span>
          </div>
          <div className="ml-auto flex gap-2">
            {canPostpone && (
              <button
                type="button"
                onClick={onPostpone}
                className={cn(SECONDARY_BTN, "px-3.5 py-[9px] text-[12.5px] font-[650]")}
              >
                Remind later
              </button>
            )}
            <button
              type="button"
              onClick={onAck}
              className={cn(
                "rounded-md px-[18px] py-[9px] text-[12.5px] font-bold",
                meta.solidCls,
              )}
            >
              {meta.ctaLabel}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
