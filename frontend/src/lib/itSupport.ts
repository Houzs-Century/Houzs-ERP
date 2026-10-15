import { api } from "../api/client";

/**
 * IT Support logic shared by the desktop page (pages/ItSupport.tsx) and the
 * phone screen (mobile/MobileItSupport.tsx): the shapes the backend relays from
 * the Houzs IT Hub, how a reporter reads each state, and the upload limits the
 * hub enforces. The two screens differ only in layout.
 */

export type ItStatus =
  | "open" | "in_progress" | "on_hold" | "testing" | "waiting_reporter" | "resolved" | "closed" | "rejected";

export interface ItRequestRow {
  code: string; type: string; priority: string; status: ItStatus; title: string;
  created_at: string; updated_at: string; assignee_name: string | null; unread: boolean;
}
export interface ItFileRef { id: number; event_id: number; filename: string; mime: string; size: number }
export interface ItStep {
  id: number; kind: "created" | "comment" | "status" | "assign" | "priority" | "type";
  author_kind: "reporter" | "developer" | "system"; author_name: string;
  body: string | null; from_value: string | null; to_value: string | null; created_at: string;
  attachments: ItFileRef[];
}
export interface ItDetail {
  ticket: {
    code: string; type: string; priority: string; status: ItStatus; title: string; description: string;
    occurred_at?: string | null; page_url?: string | null;
    assignee_name: string | null; created_at: string; updated_at: string;
  };
  events: ItStep[];
}

/* How the person who SENT the request reads each state. `resolved` is IT saying
   it is fixed and asking them to check; `waiting_reporter` is IT waiting on them. */
const STATUS_TEXT: Record<ItStatus, string> = {
  open: "Sent",
  in_progress: "In progress",
  on_hold: "On hold",
  testing: "Being tested",
  waiting_reporter: "Waiting for you",
  resolved: "Done, please confirm",
  closed: "Closed",
  rejected: "Not going ahead",
};
export type ItTone = "neutral" | "accent" | "success" | "warning" | "error";
const STATUS_TONE: Record<ItStatus, ItTone> = {
  open: "neutral", in_progress: "accent", on_hold: "neutral", testing: "accent",
  waiting_reporter: "warning", resolved: "success", closed: "neutral", rejected: "error",
};
export const IT_KINDS = [["bug", "Something is not working"], ["development", "Ask for a change"]] as const;
export const IT_URGENCY = [["low", "Low"], ["medium", "Medium"], ["high", "High"]] as const;
/* IT may raise a request to urgent on the hub, so the list can show it even though the form does not offer it. */
const URGENCY_TEXT: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const URGENCY_ORDER = ["urgent", "high", "medium", "low"];
const KIND_TEXT: Record<string, string> = Object.fromEntries(IT_KINDS);
export const itUrgencyText = (p: string): string => URGENCY_TEXT[p] ?? p;
/** Most urgent first; an unknown level sorts last. */
export const itUrgencyRank = (p: string): number => (URGENCY_ORDER.includes(p) ? URGENCY_ORDER.indexOf(p) : URGENCY_ORDER.length);
export const itUrgencyTone = (p: string): ItTone => (p === "urgent" || p === "high" ? "error" : p === "medium" ? "warning" : "neutral");
export const itKindText = (k: string): string => KIND_TEXT[k] ?? k;

/* The list's three tabs. Done-please-confirm sits with Resolved: IT's part is
   over and the request waits only on the person's "Yes, it is fixed". */
export type ItTab = "all" | "active" | "resolved";
export const IT_TABS: readonly ItTab[] = ["all", "active", "resolved"];
const RESOLVED: ReadonlySet<string> = new Set(["resolved", "closed", "rejected"]);
export const itInTab = (status: string, tab: ItTab): boolean =>
  tab === "all" || (tab === "resolved") === RESOLVED.has(status);
export const isItTab = (s: string | null): s is ItTab => s !== null && (IT_TABS as readonly string[]).includes(s);

export const IT_MAX_FILES = 5;
export const IT_MAX_BYTES = 10 * 1024 * 1024;
export const IT_ACCEPT = "image/*,video/mp4,video/quicktime,application/pdf";

export const itMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
/** Bypasses the client's read cache: a list or a conversation IT may have just changed must come from the server. */
export const itFresh = <T,>(path: string) => api.get<T>(path, { signal: new AbortController().signal });

/* The hub may grow a state this build has never heard of; it is shown as the
   hub spelled it rather than as a blank pill. */
export const itStatusText = (s: string | null): string => (s && s in STATUS_TEXT ? STATUS_TEXT[s as ItStatus] : s || "a new state");
export const itStatusTone = (s: string): ItTone => (s in STATUS_TONE ? STATUS_TONE[s as ItStatus] : "neutral");

export function itStepLine(s: ItStep): string {
  if (s.kind === "created") return "sent this request";
  if (s.kind === "status") return `changed it to ${itStatusText(s.to_value)}`;
  if (s.kind === "assign") return s.to_value ? `gave it to ${s.to_value}` : "took it off the person handling it";
  return "replied";
}

/* IT_ACCEPT only filters the file browser; a dropped or pasted file is checked against it here. */
const itAccepted = (f: File) =>
  IT_ACCEPT.split(",").some((t) => (t.endsWith("/*") ? f.type.startsWith(t.slice(0, -1)) : f.type === t));

/** Adding files to an attachment list: the new list, or why it was refused. */
export function itAddFiles(current: File[], added: ArrayLike<File> | null): { files: File[] } | { refused: string } {
  const next = [...current, ...Array.from(added ?? [])];
  const odd = next.find((f) => !itAccepted(f));
  if (odd) return { refused: `${odd.name} is not a picture, MP4 or MOV video, or PDF.` };
  const big = next.find((f) => f.size > IT_MAX_BYTES);
  if (big) return { refused: `${big.name} is larger than 10 MB.` };
  if (next.length > IT_MAX_FILES) return { refused: `Attach at most ${IT_MAX_FILES} files.` };
  return { files: next };
}
