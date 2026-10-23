// Mail Center left-rail pieces kept out of Inbox.tsx (at its size ceiling):
// the folder row, "My mailbox" (DEV-03 R3) and "What may I see" (R12).
import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, FileText, Inbox as InboxIcon, Send, User as UserIcon } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { cn } from "../../lib/utils";
import { LEVEL_LABEL, REACH_LABEL, type MailVisibility } from "./mail-personal";

const VISIBILITY_KEY = "/api/mail-center/visibility";

export function useMailVisibility(): MailVisibility | null {
  return useQuery<MailVisibility>(VISIBILITY_KEY, () => api.get(VISIBILITY_KEY), [], { staleTime: 60_000 }).data;
}

export type MyMailboxPick = "inbox" | "sentbyme" | "drafts";

/** The person's own address first: its inbox, what they sent, their drafts. */
export function MyMailboxNav({
  folder,
  mailbox,
  unread,
  drafts,
  onPick,
}: {
  folder: string;
  mailbox: string | null;
  unread: (address: string) => number;
  drafts: number;
  onPick: (pick: MyMailboxPick, address: string) => void;
}) {
  const vis = useMailVisibility();
  const mine = vis?.myAddress;
  if (!mine) return null;
  const active: MyMailboxPick | null =
    folder === "sentbyme" || folder === "drafts" ? folder : folder === "inbox" && mailbox?.toLowerCase() === mine ? "inbox" : null;
  return (
    <div className="space-y-0.5 border-b border-border/60 pb-2">
      <p className="flex items-center gap-1.5 px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70" title={mine}>
        <UserIcon className="h-3 w-3" />
        My mailbox
      </p>
      <FolderItem icon={InboxIcon} label="Inbox" active={active === "inbox"} badge={unread(mine)} onClick={() => onPick("inbox", mine)} />
      <FolderItem icon={Send} label="Sent by me" active={active === "sentbyme"} onClick={() => onPick("sentbyme", mine)} />
      <FolderItem icon={FileText} label="Drafts" active={active === "drafts"} badge={drafts} badgeTone="muted" onClick={() => onPick("drafts", mine)} />
    </div>
  );
}

/** Which mailboxes the person can read, how they reach each, and what they may send from. */
export function VisibilityPanel() {
  const vis = useMailVisibility();
  const [open, setOpen] = useState(false);
  if (!vis?.mailboxes) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-ink-muted/70 hover:text-ink"
      >
        <Eye className="h-3 w-3" />
        What may I see
        <Chevron className="ml-auto h-3 w-3" />
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-1 pt-1 text-[11.5px] text-ink-secondary">
          <p className="m-0">{LEVEL_LABEL[vis.level] ?? vis.level}{vis.manage ? "; you can also manage mailboxes." : "."}</p>
          {vis.mailboxes.length === 0 ? (
            <p className="m-0 text-ink-muted">No mailbox yet. Ask an admin to assign one.</p>
          ) : (
            <ul className="m-0 list-none space-y-1 p-0">
              {vis.mailboxes.map((m) => (
                <li key={m.address} className="leading-tight">
                  <span className="block truncate font-mono text-[11px] text-ink" title={m.address}>{m.address}</span>
                  <span className="text-[10.5px] text-ink-muted">{REACH_LABEL[m.reach]}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-[10.5px] text-ink-muted">
            You can send from {vis.sendFrom.length === 0 ? "no address yet" : vis.sendFrom.length === 1 ? vis.sendFrom[0] : `these ${vis.sendFrom.length} addresses`}.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Folder row ──────────────────────────────────────────────────────────────
export function FolderItem({
  icon: Icon,
  label,
  active,
  badge,
  badgeTone = "accent",
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  badge?: number;
  badgeTone?: "accent" | "muted";
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition",
        active ? "bg-accent-soft font-semibold text-primary-ink" : "text-ink/80 hover:bg-surface-dim",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-ink-muted/60")} />
        <span className="truncate">{label}</span>
      </span>
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            badgeTone === "accent"
              ? active
                ? "bg-primary/20 text-primary-ink"
                : "bg-accent-soft text-primary-ink"
              : active
                ? "bg-primary/20 text-primary-ink"
                : "bg-surface-dim text-ink-muted",
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
