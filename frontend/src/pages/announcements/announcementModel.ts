import type { AnnMediaLayout } from "../../components/AnnouncementMedia";
import {
  categoryOf,
  requiresAcknowledgement,
  type AnnouncementCategory,
} from "../../components/announcementCategory";
import { announcementStatus } from "../../lib/announcementStatus";

// ────────────────────────────────────────────────────────────────────────────
// announcementModel — the pure rules behind the Announcements page (Inbox +
// Manage), kept out of the React files so both modes, the tests and the
// dashboard read ONE definition of "pending for me", "archived", "ack-rate
// colour" and "which group does this notice sit in".
//
// Design handoff 2026-09-04 (design_handoff_announcements/README.md). Category
// colours, labels, CTA wording and the "which categories block" rule live in
// components/announcementCategory.ts (shared with the modal, the bell, the
// dashboard and the phone) and are re-exported here for the page's convenience.
// ────────────────────────────────────────────────────────────────────────────

export {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryOf,
  categoryRequiresAck,
  type AnnouncementCategory,
} from "../../components/announcementCategory";

export type Attachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

export type TargetType =
  | "ALL_USERS"
  | "DEPARTMENT_IDS"
  | "POSITION_IDS"
  | "USER_IDS"
  | "MIXED";

/** Mirrors backend/src/routes/announcements.ts toPublic(). Optional fields
 *  marked "mig 2026-09" arrive with the redesign's backend half; every
 *  consumer must cope with them absent (older payloads, the D1 test mirror). */
export type Announcement = {
  id: string;
  title: string;
  body: string;
  /** Canonical rich fragment or null for a plain notice (lib/announcementRichText). */
  bodyHtml?: string | null;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string | null;
  createdBy: number | null;
  /** Author's display name (mig 2026-09 — resolved server-side because
   *  readers cannot load /api/users). */
  createdByName?: string | null;
  remindedAt: string | null;
  updatedAt: string | null;
  attachments?: Attachment[];
  mediaLayout?: AnnMediaLayout;
  targetType?: TargetType;
  targetDeptIds?: number[];
  targetPositionIds?: number[];
  targetUserIds?: number[];
  targetCompanyIds?: number[];
  /** Divisions targeted on their own (mig 20260906T0639): {deptId, division}. */
  targetDivisions?: DivisionTarget[];
  /** People carved out of the audience (mig 20260906T0639). */
  excludedUserIds?: number[];
  /** Department names for targetDeptIds (mig 2026-09), same reason as above. */
  targetDeptNames?: string[];
  /** "Operation › Driver Team" per targetDivisions entry, server-resolved. */
  targetDivisionNames?: string[];
  category?: AnnouncementCategory;
  /** Per-notice "must acknowledge" flag (mig 2026-09). Absent = derive from
   *  the category, see requiresAck(). */
  requireAck?: boolean | null;
  /** Scheduled posting instant (mig 2026-09). Absent/null = posted at once. */
  scheduledAt?: string | null;
  /** When the overdue escalation ran — the cron or the drawer's click (mig
   *  20260906T0833). Absent/null = supervisors not notified yet. */
  escalatedAt?: string | null;
};

/** One targeted division: the department it sits in + the division text. */
export type DivisionTarget = { deptId: number; division: string };

export type Company = { id: number; code: string; name: string };

/** Does this notice demand an acknowledgement? See requiresAcknowledgement —
 *  the per-notice flag wins, the category rule stands in for legacy rows. */
export function requiresAck(
  a: Pick<Announcement, "category" | "requireAck">,
): boolean {
  return requiresAcknowledgement(a);
}

// ── Status ─────────────────────────────────────────────────────────────────

/** SOP never expires (permanent SOP Library); every other category is archived
 *  once hidden or past expiry and drops out of the default list. */
export function isArchived(
  a: Pick<Announcement, "isActive" | "expiresAt" | "category">,
  now: number = Date.now(),
): boolean {
  if (!a.isActive) return true;
  if (categoryOf(a) === "SOP") return false;
  return announcementStatus(a, now) === "expired";
}

/** Not yet reached its scheduled posting instant. */
export function isScheduled(
  a: Pick<Announcement, "scheduledAt">,
  now: number = Date.now(),
): boolean {
  const raw = a.scheduledAt;
  if (!raw) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > now;
}

// ── Ack-rate thresholds (README "Status colours") ─────────────────────────

export function ackPercent(acked: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((acked / total) * 100);
}

/** Bar fill: >= 95% synced, >= 70% primary, otherwise warning. */
export function ackRateBarCls(pct: number): string {
  if (pct >= 95) return "bg-synced";
  if (pct >= 70) return "bg-primary";
  return "bg-warning-text";
}

export type ManageStatus = "awaiting" | "escalated" | "complete" | "archived";

export const MANAGE_STATUS_META: Record<ManageStatus, { label: string; cls: string }> = {
  awaiting: { label: "Awaiting you", cls: "bg-err-bg text-err" },
  escalated: { label: "Escalated", cls: "bg-warning-bg text-warning-text" },
  complete: { label: "Complete", cls: "bg-synced-bg text-synced" },
  archived: {
    label: "Archived",
    cls: "bg-surface-dim border border-border text-ink-muted",
  },
};

/** Manage-table status: pending for the current user outranks everything;
 *  then archived; then the ack rate decides Escalated (< 70%) vs Complete.
 *  Pass `pct: null` while the rate is still loading — the row then reads
 *  Complete only by default, and the caller should render a dash for the rate
 *  itself rather than a number it cannot vouch for. */
export function manageStatus(
  a: Pick<Announcement, "isActive" | "expiresAt" | "category">,
  opts: { pendingForMe: boolean; pct: number | null },
  now: number = Date.now(),
): ManageStatus {
  if (opts.pendingForMe) return "awaiting";
  if (isArchived(a, now)) return "archived";
  if (opts.pct != null && opts.pct < 70) return "escalated";
  return "complete";
}

// ── Inbox grouping ─────────────────────────────────────────────────────────

export type InboxFilter =
  | "pending"
  | "all"
  | "WARNING"
  | "SOP"
  | "LEARNING"
  | "GENERAL"
  | "mine";

export const INBOX_FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: "pending", label: "Needs you" },
  { id: "all", label: "All" },
  { id: "WARNING", label: "Warning" },
  { id: "SOP", label: "SOP" },
  { id: "LEARNING", label: "Learning" },
  { id: "GENERAL", label: "Notice" },
  { id: "mine", label: "Posted by me" },
];

export function matchesSearch(a: Announcement, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    a.title.toLowerCase().includes(q) ||
    a.body.toLowerCase().includes(q) ||
    (a.createdByName ?? "").toLowerCase().includes(q)
  );
}

export type InboxBuckets = {
  /** Mandatory, addressed to me, not yet acknowledged — pinned on top. */
  pending: Announcement[];
  /** Everything else that is live and not an SOP, after the filter. */
  recent: Announcement[];
  /** The permanent SOP Library, grouped by department (first target dept). */
  sopGroups: Array<{ dept: string; items: Announcement[] }>;
  /** Count of SOP notices across the groups. */
  sopCount: number;
};

export type InboxInput = {
  items: Announcement[];
  /** Ids of notices ADDRESSED to me (the /banner human slice). A notice
   *  outside this set is one I can read as a manager but never have to ack. */
  addressedIds: ReadonlySet<string>;
  /** Ids I have acknowledged (server + this session). */
  ackedIds: ReadonlySet<string>;
  currentUserId: number | null;
  filter: InboxFilter;
  search: string;
  /** Name lookups (writers only) — used for the SOP Library's department headings. */
  lookups?: NameLookups;
  now?: number;
};

/** Pending for me = mandatory + addressed to me + live + not acked. */
export function isPendingForMe(
  a: Announcement,
  addressedIds: ReadonlySet<string>,
  ackedIds: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  return (
    requiresAck(a) &&
    addressedIds.has(a.id) &&
    !ackedIds.has(a.id) &&
    !isArchived(a, now) &&
    !isScheduled(a, now)
  );
}

/** The SOP Library's department heading: the first targeted department's
 *  name (server-resolved, else from a writer's lookups), "All departments"
 *  for a company-wide SOP, "General" when the name cannot be resolved. */
export function sopDepartmentLabel(a: Announcement, lookups: NameLookups = {}): string {
  const name = a.targetDeptNames?.[0];
  if (name) return name;
  const firstId = a.targetDeptIds?.[0] ?? a.targetDivisions?.[0]?.deptId;
  if (firstId != null) {
    const looked = lookups.departments?.get(firstId);
    if (looked) return looked;
  }
  // A division-only SOP files under its department (the label's first part).
  const divisionLabel = a.targetDivisionNames?.[0];
  if (divisionLabel) return divisionLabel.split(" › ")[0];
  if (a.targetType === "ALL_USERS" || !a.targetType) return "All departments";
  return "General";
}

/** Split the list into the inbox's three groups. A postponed notice STAYS
 *  pinned — "Remind later" only stops the modal nagging this session; the
 *  notice is still waiting on the reader and the group must say so. */
export function bucketInbox(input: InboxInput): InboxBuckets {
  const now = input.now ?? Date.now();
  const searched = input.items.filter((a) => matchesSearch(a, input.search));

  const pending: Announcement[] = [];
  const recent: Announcement[] = [];
  const sops: Announcement[] = [];
  for (const a of searched) {
    if (isScheduled(a, now)) continue;
    if (isPendingForMe(a, input.addressedIds, input.ackedIds, now)) {
      pending.push(a);
      continue;
    }
    if (categoryOf(a) === "SOP") {
      if (a.isActive) sops.push(a);
      continue;
    }
    if (isArchived(a, now)) continue;
    recent.push(a);
  }

  const f = input.filter;
  const filteredRecent =
    f === "pending"
      ? []
      : f === "mine"
        ? recent.filter(
            (a) => input.currentUserId != null && a.createdBy === input.currentUserId,
          )
        : f === "all"
          ? recent
          : recent.filter((a) => categoryOf(a) === f);

  const groups = new Map<string, Announcement[]>();
  for (const a of sops) {
    const key = sopDepartmentLabel(a, input.lookups);
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const sopGroups = Array.from(groups.entries())
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([dept, items]) => ({ dept, items }));

  return { pending, recent: filteredRecent, sopGroups, sopCount: sops.length };
}

// ── Manage mode ────────────────────────────────────────────────────────────

/** GET /api/announcements/:id/acks (extended 2026-09). */
export type AckPerson = {
  id: number;
  name: string;
  email: string;
  departmentId?: number | null;
  departmentName?: string | null;
  positionName?: string | null;
  managerId?: number | null;
};
export type PendingState = "pending" | "reminded" | "overdue";
export type AcksData = {
  total: number;
  ackedCount: number;
  acked: Array<AckPerson & { ackedAt: string | null }>;
  pending: Array<AckPerson & { state?: PendingState }>;
  byDepartment?: Array<{
    id: number | null;
    name: string;
    total: number;
    acked: number;
    pending: number;
  }>;
  remindedAt?: string | null;
  overdueAfterHours?: number;
};

/** GET /api/announcements/ack-summary — { id → { total, acked } }. */
export type AckSummary = Record<string, { total: number; acked: number }>;

export const PERSON_STATE_META: Record<
  PendingState | "confirmed",
  { label: string; cls: string }
> = {
  confirmed: { label: "confirmed", cls: "bg-synced-bg text-synced" },
  overdue: { label: "overdue", cls: "bg-err-bg text-err" },
  reminded: { label: "reminded", cls: "bg-warning-bg text-warning-text" },
  pending: { label: "pending", cls: "bg-surface-dim border border-border text-ink-muted" },
};

/** Department bucket key — null department is its own bucket. */
export function deptKey(id: number | null | undefined): string {
  return id == null ? "none" : String(id);
}

/** The Manage table's rows: every notice the caller may see (archived
 *  included — that is the point of Manage), scheduled ones too, through the
 *  same filter pills as the inbox. "Needs you" = pending for me. */
export function filterManageRows(input: Omit<InboxInput, "lookups">): Announcement[] {
  const now = input.now ?? Date.now();
  const searched = input.items.filter((a) => matchesSearch(a, input.search));
  const f = input.filter;
  if (f === "all") return searched;
  if (f === "pending") {
    return searched.filter((a) => isPendingForMe(a, input.addressedIds, input.ackedIds, now));
  }
  if (f === "mine") {
    return searched.filter(
      (a) => input.currentUserId != null && a.createdBy === input.currentUserId,
    );
  }
  return searched.filter((a) => categoryOf(a) === f);
}

export type ManageStats = {
  awaitingYou: number;
  liveNotices: number;
  /** Mean ack percentage over live notices with a known audience; null = unknown yet. */
  avgAckRate: number | null;
  /** Live notices below the 70% threshold. */
  escalated: number;
};

export function manageStats(
  items: Announcement[],
  summary: AckSummary | null,
  addressedIds: ReadonlySet<string>,
  ackedIds: ReadonlySet<string>,
  now: number = Date.now(),
): ManageStats {
  let awaitingYou = 0;
  let liveNotices = 0;
  let escalated = 0;
  let pctSum = 0;
  let pctCount = 0;
  for (const a of items) {
    if (isPendingForMe(a, addressedIds, ackedIds, now)) awaitingYou += 1;
    if (isArchived(a, now) || isScheduled(a, now)) continue;
    liveNotices += 1;
    const s = summary?.[a.id];
    if (!s || s.total <= 0) continue;
    const pct = ackPercent(s.acked, s.total);
    pctSum += pct;
    pctCount += 1;
    if (pct < 70) escalated += 1;
  }
  return {
    awaitingYou,
    liveNotices,
    avgAckRate: summary && pctCount > 0 ? Math.round(pctSum / pctCount) : null,
    escalated,
  };
}

/** Rows for a CSV export of one notice's read receipts. */
export function receiptsCsv(a: Announcement, acks: AcksData): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Notice", "Doc no", "Name", "Email", "Department", "Position", "Status", "Acknowledged at"].map(esc).join(","),
  ];
  for (const p of acks.acked) {
    lines.push(
      [a.title, docNo(a), p.name, p.email, p.departmentName ?? "", p.positionName ?? "", "confirmed", p.ackedAt ?? ""]
        .map(esc)
        .join(","),
    );
  }
  for (const p of acks.pending) {
    lines.push(
      [a.title, docNo(a), p.name, p.email, p.departmentName ?? "", p.positionName ?? "", p.state ?? "pending", ""]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

// ── Labels ─────────────────────────────────────────────────────────────────

/** Doc-number style id for the mono chips. */
export function docNo(a: Pick<Announcement, "id">): string {
  return a.id.toUpperCase();
}

/** Resolve the company-scope of a notice to a compact chip label. Empty target
 *  (or one covering every company) = "Both"/"All"; a subset lists the codes. */
export function companyScopeLabel(
  ids: number[] | undefined,
  companies: Company[],
): string {
  const list = ids ?? [];
  if (companies.length === 0) return "";
  if (list.length === 0 || list.length >= companies.length) {
    return companies.length === 2 ? "Both" : "All companies";
  }
  return list
    .map((id) => companies.find((co) => co.id === id)?.code ?? `#${id}`)
    .join(" / ");
}

export type NameLookups = {
  departments?: ReadonlyMap<number, string>;
  positions?: ReadonlyMap<number, string>;
  users?: ReadonlyMap<number, string>;
};

/** "All staff" / "Operation + Warehouse" / "Sales Executive" / "3 people". A
 *  reader without the lookups (they sit behind users.read) still gets an
 *  honest label from the server-resolved department names or the counts. */
export function audienceLabel(a: Announcement, lookups: NameLookups = {}): string {
  const t = a.targetType ?? "ALL_USERS";
  if (t === "ALL_USERS") return "All staff";
  const parts: string[] = [];
  const deptIds = a.targetDeptIds ?? [];
  if (deptIds.length) {
    const names =
      a.targetDeptNames && a.targetDeptNames.length === deptIds.length
        ? a.targetDeptNames
        : deptIds.map((id) => lookups.departments?.get(id) ?? `Dept #${id}`);
    parts.push(names.join(" + "));
  }
  const divisions = a.targetDivisions ?? [];
  if (divisions.length) {
    const labels =
      a.targetDivisionNames && a.targetDivisionNames.length === divisions.length
        ? a.targetDivisionNames
        : divisions.map(
            (d) => `${lookups.departments?.get(d.deptId) ?? `Dept #${d.deptId}`} › ${d.division}`,
          );
    parts.push(labels.join(" + "));
  }
  const posIds = a.targetPositionIds ?? [];
  if (posIds.length) {
    parts.push(
      posIds.map((id) => lookups.positions?.get(id) ?? `Position #${id}`).join(" + "),
    );
  }
  const userIds = a.targetUserIds ?? [];
  if (userIds.length) {
    const named = userIds.map((id) => lookups.users?.get(id));
    parts.push(
      named.every(Boolean)
        ? (named as string[]).join(", ")
        : `${userIds.length} ${userIds.length === 1 ? "person" : "people"}`,
    );
  }
  const excluded = a.excludedUserIds ?? [];
  if (excluded.length) parts.push(`${excluded.length} unticked`);
  return parts.length ? parts.join(" · ") : "—";
}
