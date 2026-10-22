// Mail Center: pick recipients from the org chart (DEV-03 / PRD T-011 P4, A5).
// Tabs come from GET /api/mail-center/directory. Ticked people are added to
// To or Cc; the parent merges them into its field. Shared by desktop
// Compose.tsx and the phone's MobileMailCenter.tsx.
import { useMemo, useState } from "react";
import { Search, Users, X } from "lucide-react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { cn } from "../../lib/utils";
import { parseRecipients } from "./mail-recipients";

export type DirectoryEntry = {
  key: string;
  userId: number | null;
  name: string;
  email: string;
  position: string;
  department: string;
};

export type MailDirectory = {
  me: DirectoryEntry | null;
  department: DirectoryEntry[];
  team: DirectoryEntry[];
  managers: DirectoryEntry[];
  everyone: DirectoryEntry[];
};

type Tab = "department" | "team" | "managers" | "everyone";

const TABS: Array<{ id: Tab; label: string; none: string }> = [
  { id: "department", label: "Department", none: "Nobody else is in your department on the org chart." },
  { id: "team", label: "My team", none: "No reports or peers on the org chart yet." },
  { id: "managers", label: "My managers", none: "No manager is set for you on the org chart." },
  { id: "everyone", label: "Everyone", none: "No one to pick yet." },
];

const DIRECTORY_KEY = "/api/mail-center/directory";

export function filterDirectory(list: DirectoryEntry[], q: string): DirectoryEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((p) =>
    [p.name, p.email, p.position, p.department].some((f) => f.toLowerCase().includes(needle)),
  );
}

export function RecipientPicker({
  open,
  onClose,
  onPick,
  already,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (addresses: string[], field: "to" | "cc") => void;
  /** The To / Cc / Bcc fields as typed; anyone on them shows ticked and locked. */
  already: string[];
}) {
  const { data, loading, error } = useQuery<MailDirectory>(
    DIRECTORY_KEY,
    () => api.get(DIRECTORY_KEY),
    [],
    { enabled: open, staleTime: 120_000 },
  );
  const [tab, setTab] = useState<Tab>("department");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const onMail = useMemo(
    () => new Set(already.flatMap((raw) => parseRecipients(raw)).map((a) => a.toLowerCase())),
    [already],
  );
  const rows = useMemo(() => filterDirectory(data ? data[tab] : [], q), [data, tab, q]);

  if (!open) return null;

  const close = () => {
    setPicked([]);
    setQ("");
    onClose();
  };
  const toggle = (email: string) =>
    setPicked((prev) => (prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]));
  const commit = (field: "to" | "cc") => {
    if (picked.length === 0) return;
    onPick(picked, field);
    close();
  };
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-ink/40 backdrop-blur-sm" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pick recipients from the org chart"
        className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface shadow-slab"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold text-ink">Pick from the org chart</h3>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-md p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border px-3" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-xs font-medium transition",
                tab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {t.label}
              <span className="ml-1 text-[10px] text-ink-muted/70">{data ? data[t.id].length : ""}</span>
            </button>
          ))}
        </div>

        <div className="px-4 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, address, position"
              aria-label="Search people"
              className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        <div className="min-h-[8rem] flex-1 overflow-y-auto px-4 py-2">
          {error && !data ? (
            <p className="py-6 text-center text-xs text-err">Could not load the org chart. Close and try again.</p>
          ) : loading && !data ? (
            <p className="py-6 text-center text-xs text-ink-muted">Loading the org chart…</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-muted">{q.trim() ? "No one matches." : current.none}</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {rows.map((p) => {
                const email = p.email.toLowerCase();
                const locked = onMail.has(email);
                return (
                  <li key={p.key}>
                    <label className={cn("flex items-center gap-3 py-2", locked ? "cursor-default opacity-60" : "cursor-pointer")}>
                      <input
                        type="checkbox"
                        checked={locked || picked.includes(email)}
                        disabled={locked}
                        onChange={() => toggle(email)}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-ink">
                          {p.name}
                          {p.position && <span className="ml-1.5 text-[11px] text-ink-muted">{p.position}</span>}
                        </span>
                        <span className="block truncate text-[11px] text-ink-muted">
                          {p.email}
                          {p.department ? ` · ${p.department}` : ""}
                          {locked ? " · already on this email" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-dim/50 px-4 py-3">
          <p className="text-[11px] text-ink-muted">
            {picked.length === 0 ? "Tick people to add." : `${picked.length} picked`}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-dim"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={() => commit("cc")}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-surface-dim disabled:opacity-50"
            >
              Add to Cc
            </button>
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={() => commit("to")}
              className="rounded-md border border-primary bg-primary px-3 py-1.5 text-[12px] font-bold text-white hover:bg-primary-ink disabled:opacity-50"
            >
              Add to To
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
