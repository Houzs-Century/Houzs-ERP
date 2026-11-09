import { assrStageLabel } from "../assr-stage-labels";
import { assrSubStatusLabelOf } from "../assr-sub-statuses";

export interface TimelineActivity {
  id: number;
  created_at: string;
  action: string;
  category?: string | null;
  source?: string | null;
  source_channel?: string | null;
  from_value?: string | null;
  to_value?: string | null;
  note?: string | null;
  user_name?: string | null;
}

export type TimelineRole = "service" | "customer" | "supplier" | "sales" | "system";
export type TimelineFilter = TimelineRole | "all";
export type TimelineTone = "blue" | "purple" | "green" | "amber" | "red" | "grey";

export interface TimelineStatus {
  label: string;
  tone: TimelineTone;
}

export interface TimelineUploadCount {
  photos: number;
  videos: number;
  files: number;
}

export interface TimelineRow {
  id: number;
  at: string;
  by: string;
  role: TimelineRole;
  status: TimelineStatus | null;
  remarks: string;
  upload: TimelineUploadCount | null;
  isArchivable: boolean;
  isEscalation: boolean;
}

export interface TimelineOptions {
  filter: TimelineFilter;
  shouldShowDetails: boolean;
  salesAgent: string | null;
  userNames: ReadonlyMap<string, string>;
}

export interface CaseTimeline {
  rows: TimelineRow[];
  hiddenCount: number;
}

const UPLOAD_ACTIONS: readonly string[] = ["attachment_added", "customer_upload", "sales_upload", "supplier_upload"];
const COMMENT_ACTIONS: readonly string[] = ["note", "customer_comment", "sales_comment"];
const PROGRESS_ACTIONS: readonly string[] = [
  "created",
  "stage_change",
  "sub_status_change",
  "approval",
  "po_generated",
  "escalated",
  "case_reopened",
  "survey_submitted",
  "supplier_return_opened",
];
const VIDEO_EXTENSIONS: readonly string[] = ["mov", "mp4", "webm", "m4v", "avi"];
const PHOTO_EXTENSIONS: readonly string[] = ["jpg", "jpeg", "png", "webp", "gif", "heic"];
const STORAGE_KEY_PATTERN = /\(?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.([a-z0-9]+))?\)?/gi;
const GOOGLE_FORM_PHOTO_PATTERN = /^Photo migrated from Google Form history(?::\s*(.*?))?\s*\[gdrive:[^\]]+\]$/;

const STAGE_TONES: Record<string, TimelineTone> = {
  pending_supplier_pickup: "purple",
  pending_item_ready: "purple",
  pending_delivery_service: "amber",
  completed: "green",
  voided: "red",
};

const COMMENT_STATUS_BY_ROLE: Record<TimelineRole, string> = {
  service: "Note",
  customer: "Customer Comment",
  supplier: "Supplier Note",
  sales: "Sales Comment",
  system: "Note",
};

function kindOfFile(fileName: string): keyof TimelineUploadCount {
  const extension = /\.([a-z0-9]+)\)?\s*$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
  if (VIDEO_EXTENSIONS.includes(extension)) return "videos";
  if (PHOTO_EXTENSIONS.includes(extension)) return "photos";
  return "files";
}

export function prettifyStorageKeys(text: string): string {
  return text.replace(STORAGE_KEY_PATTERN, (_match, extension: string | undefined) => {
    const kind = kindOfFile(`x.${extension ?? ""}`);
    if (kind === "videos") return "(video)";
    if (kind === "photos") return "(photo)";
    return "(file)";
  });
}

const TIMELINE_ROLES: readonly TimelineRole[] = ["service", "customer", "supplier", "sales", "system"];

function isTimelineRole(value: string): value is TimelineRole {
  return TIMELINE_ROLES.some((role) => role === value);
}

export function roleOfActivity(activity: TimelineActivity): TimelineRole {
  const category = String(activity.category ?? "").toLowerCase();
  if (category === "purchasing") return "service";
  if (isTimelineRole(category)) return category;
  if (activity.source === "sales" || activity.action === "sales_comment" || activity.action === "sales_upload") return "sales";
  if (activity.source_channel === "customer_portal" || activity.source === "customer" || activity.action === "customer_comment") return "customer";
  if (activity.source_channel === "supplier_portal") return "supplier";
  return "service";
}

function authorOf(activity: TimelineActivity, salesAgent: string | null): string {
  if (activity.source === "customer") return "Customer";
  if (activity.source === "sales") return salesAgent ?? "Sales";
  if (activity.user_name) return activity.user_name;
  if (activity.source_channel === "supplier_portal") return "Supplier";
  return "System";
}

function uploadedFileName(activity: TimelineActivity): string | null {
  if (UPLOAD_ACTIONS.includes(activity.action)) return activity.to_value ?? activity.note ?? "";
  const googleFormMatch = GOOGLE_FORM_PHOTO_PATTERN.exec(String(activity.note ?? "").trim());
  return googleFormMatch ? `${googleFormMatch[1] || "photo"}.jpg` : null;
}

function isDetailActivity(activity: TimelineActivity): boolean {
  return !PROGRESS_ACTIONS.includes(activity.action) && !COMMENT_ACTIONS.includes(activity.action) && uploadedFileName(activity) === null;
}

function userName(userNames: ReadonlyMap<string, string>, userId: string | null | undefined): string {
  return userNames.get(String(userId ?? "")) ?? `user #${userId ?? "?"}`;
}

function describeActivity(activity: TimelineActivity, role: TimelineRole, userNames: ReadonlyMap<string, string>): Pick<TimelineRow, "status" | "remarks"> {
  const note = activity.note ?? "";
  const target = activity.to_value ?? "";
  switch (activity.action) {
    case "created":
      return { status: { label: "Case Created", tone: "blue" }, remarks: note };
    case "stage_change":
      return { status: { label: assrStageLabel(target), tone: STAGE_TONES[target] ?? "blue" }, remarks: note };
    case "sub_status_change":
      return { status: { label: assrSubStatusLabelOf(target) ?? target, tone: "purple" }, remarks: note };
    case "approval":
      return { status: { label: target === "passed" ? "QC Passed" : "QC Reviewed", tone: "green" }, remarks: note };
    case "po_generated":
      return { status: { label: "PO Generated", tone: "blue" }, remarks: [`PO: ${target}`, note].filter(Boolean).join(" | ") };
    case "escalated":
      return { status: { label: "Escalated", tone: "red" }, remarks: note || "SLA breached over 24h" };
    case "case_reopened":
      return { status: { label: "Reopened", tone: "amber" }, remarks: note };
    case "survey_submitted":
      return { status: { label: `Rated ${target}/5`, tone: "green" }, remarks: note };
    case "supplier_return_opened":
      return { status: { label: "Sent to Supplier", tone: "purple" }, remarks: note };
    case "assignment":
      return { status: null, remarks: `Assigned to ${userName(userNames, target)}` };
    case "assignment_2":
      return { status: null, remarks: target ? `Co-assignee set to ${userName(userNames, target)}` : "Co-assignee cleared" };
    default:
      if (COMMENT_ACTIONS.includes(activity.action)) {
        return { status: { label: COMMENT_STATUS_BY_ROLE[role], tone: "grey" }, remarks: note };
      }
      return { status: null, remarks: note || activity.action.replace(/_/g, " ") };
  }
}

function emptyUploadCount(): TimelineUploadCount {
  return { photos: 0, videos: 0, files: 0 };
}

export function describeUploadCount({ photos, videos, files }: TimelineUploadCount): string {
  const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [
    photos > 0 ? plural(photos, "photo") : null,
    videos > 0 ? plural(videos, "video") : null,
    files > 0 ? plural(files, "file") : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function uploadStatus({ photos, videos, files }: TimelineUploadCount): TimelineStatus {
  if (photos === 0 && files === 0) return { label: videos === 1 ? "Video Uploaded" : "Videos Uploaded", tone: "blue" };
  if (videos === 0 && files === 0) return { label: photos === 1 ? "Photo Uploaded" : "Photos Uploaded", tone: "blue" };
  return { label: "Files Uploaded", tone: "blue" };
}

function isSameLocalDay(first: string, second: string): boolean {
  return new Date(first).toDateString() === new Date(second).toDateString();
}

function compareOldestFirst(first: TimelineActivity, second: TimelineActivity): number {
  return first.created_at.localeCompare(second.created_at) || first.id - second.id;
}

export function buildCaseTimeline(activity: readonly TimelineActivity[], options: TimelineOptions): CaseTimeline {
  const { filter, shouldShowDetails, salesAgent, userNames } = options;
  const inAudience = activity.filter((entry) => filter === "all" || roleOfActivity(entry) === filter);
  const visible = shouldShowDetails ? inAudience : inAudience.filter((entry) => !isDetailActivity(entry));
  const rows: TimelineRow[] = [];
  for (const entry of [...visible].sort(compareOldestFirst)) {
    const role = roleOfActivity(entry);
    const by = authorOf(entry, salesAgent);
    const fileName = uploadedFileName(entry);
    if (fileName !== null) {
      const previous = rows.at(-1);
      const target = previous?.upload && previous.by === by && isSameLocalDay(previous.at, entry.created_at) ? previous : null;
      const upload = target?.upload ?? emptyUploadCount();
      upload[kindOfFile(fileName)] += 1;
      const groupedRow: TimelineRow = {
        id: target?.id ?? entry.id,
        at: target?.at ?? entry.created_at,
        by,
        role,
        status: uploadStatus(upload),
        remarks: `${describeUploadCount(upload)} uploaded`,
        upload,
        isArchivable: false,
        isEscalation: false,
      };
      if (target) rows[rows.length - 1] = groupedRow;
      else rows.push(groupedRow);
      continue;
    }
    const { status, remarks } = describeActivity(entry, role, userNames);
    rows.push({
      id: entry.id,
      at: entry.created_at,
      by,
      role,
      status,
      remarks: prettifyStorageKeys(remarks),
      upload: null,
      isArchivable: COMMENT_ACTIONS.includes(entry.action),
      isEscalation: entry.action === "escalated",
    });
  }
  return { rows, hiddenCount: inAudience.length - visible.length };
}
