import { useState, useEffect, useRef } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel, PanelSection } from "../../components/Panel";
import { useToast } from "../../hooks/useToast";
import { api, humanHttpMessage, tokenStore } from "../../api/client";
import { companyHeader } from "../../lib/activeCompany";
import { consumeCorrelated, correlateError, correlatedFetch, requestIdFromError, requestIdFromResponse } from "../../lib/requestCorrelation";
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";

/** Generic multi-select filter (owner 2026-08-07: "add multiple choice for all
 *  dropdown also"). A native <select multiple> is unusable in a filter bar
 *  (ctrl-click, fixed height), so every project-list filter uses this button +
 *  checkbox popover instead. Closes on outside click / Escape. Options may be
 *  grouped (the task filter groups by checklist section); pass one group with a
 *  null name for a flat list. Selection is a string[] the caller comma-joins
 *  into the URL. */
// Date-range filter (owner 2026-08-11) — a From/To picker chip that replaces the
// old year + month dropdowns. Two native date inputs; the list scopes to events
// overlapping the window (start <= to AND end >= from).
export function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  /* Was a month-NAME array — the exact thing utils.ts says the owner ruled
     out ("no 'Jun'/'Jul' month names anywhere on the desktop app"). */
  const fmt = (d: string) => (d ? fmtDate(d) : "…");
  const active = !!(from || to);
  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-md border bg-surface px-2 text-[12px]",
          active ? "border-accent font-semibold text-accent" : "border-border text-ink",
        )}
      >
        <Calendar size={13} className="shrink-0 opacity-70" />
        <span className="truncate">{active ? `${fmt(from)} – ${fmt(to)}` : "All dates"}</span>
        <ChevronDown size={13} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[250px] rounded-md border border-border bg-surface p-3 shadow-slab">
          <div className="mb-2 flex items-center justify-between border-b border-border-subtle pb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Date range</span>
            {active && (
              <button type="button" onClick={() => onChange("", "")} className="text-[10.5px] font-semibold text-ink-secondary hover:text-err">
                Clear
              </button>
            )}
          </div>
          <label className="mb-2 block text-[11px] font-semibold text-ink-secondary">
            From
            <DateField
              fullWidth
              value={from}
              max={to || undefined}
              onChange={(iso) => onChange(iso, to)}
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
            />
          </label>
          <label className="block text-[11px] font-semibold text-ink-secondary">
            To
            <DateField
              fullWidth
              value={to}
              min={from || undefined}
              onChange={(iso) => onChange(from, iso)}
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function MultiSelectFilter({
  placeholder,
  groups,
  selected,
  onChange,
  title,
  summary,
  panelWidth = "w-[280px]",
}: {
  placeholder: string;
  groups: { name: string | null; options: { value: string; label: string; count?: number }[] }[];
  selected: string[];
  onChange: (next: string[]) => void;
  title?: string;
  /** Label when >1 is ticked, e.g. "3 brands". Defaults to "n selected". */
  summary?: (n: number) => string;
  panelWidth?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const labelFor = (v: string) => {
    for (const g of groups) {
      const hit = g.options.find((o) => o.value === v);
      if (hit) return hit.label;
    }
    return v;
  };
  const label =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? labelFor(selected[0])
        : summary
          ? summary(selected.length)
          : `${selected.length} selected`;
  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title ?? placeholder}
        className={cn(
          "inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-md border bg-surface px-2 text-[12px]",
          selected.length ? "border-accent font-semibold text-accent" : "border-border text-ink",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={13} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute left-0 top-9 z-30 max-h-[420px] overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-slab",
            panelWidth,
          )}
        >
          <div className="mb-1.5 flex items-center justify-between border-b border-border-subtle pb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
              {placeholder}
            </span>
            {/* Untick-all is ALWAYS shown (owner 2026-08-11) so the affordance is
                visible even before anything is ticked — it just greys out and is
                disabled while the list is empty, then activates (with a count)
                once you tick something. */}
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              className={cn(
                "text-[10.5px] font-semibold",
                selected.length === 0
                  ? "cursor-default text-ink-muted/50"
                  : "text-ink-secondary hover:text-err",
              )}
            >
              {selected.length > 0 ? `Untick all (${selected.length})` : "Untick all"}
            </button>
          </div>
          {groups.map((g, gi) => (
            <div key={g.name ?? `g${gi}`} className="mb-1.5">
              {g.name && (
                <div className="px-1 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-ink-muted">
                  {g.name}
                </div>
              )}
              {g.options.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] hover:bg-primary-soft/40"
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={selected.includes(o.value)}
                    onChange={() => toggle(o.value)}
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {typeof o.count === "number" && (
                    <span className="shrink-0 tabular-nums text-[11px] text-ink-muted">
                      {o.count}
                    </span>
                  )}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-project task badges for the Status (section) filter (owner 2026-08-14).
// Reads the backend section_tasks_map ("title=status=due" joined by "|") and
// renders one pill per task in the chosen section: DONE (green), OVERDUE (red,
// with days late) or PENDING (amber). Overdue first, then pending, then done.
// Renders nothing unless a real section is picked (the map is absent otherwise),
// so the default project list is unchanged.
export function SectionTaskBadges({ map }: { map?: string | null }) {
  if (!map) return null;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const tasks = map
    .split("|")
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split("=");
      const title = parts[0] ?? "";
      const status = parts[1] ?? "";
      const due = parts[2] ?? "";
      let kind: "done" | "overdue" | "pending";
      let daysLate = 0;
      if (status === "done") kind = "done";
      else if (due && due < today) {
        kind = "overdue";
        daysLate = Math.max(1, Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000));
      } else kind = "pending";
      return { title, kind, daysLate };
    });
  if (!tasks.length) return null;
  const rank = { overdue: 0, pending: 1, done: 2 } as const;
  tasks.sort((a, b) => rank[a.kind] - rank[b.kind] || b.daysLate - a.daysLate);
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tasks.map((t, i) => (
        <span
          key={i}
          title={t.title}
          className={cn(
            "inline-flex max-w-[170px] items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold",
            t.kind === "done"
              ? "border border-synced/40 bg-synced/15 text-synced"
              : t.kind === "overdue"
                ? "border border-err/40 bg-err/15 text-err"
                : "border border-amber-500 bg-amber-100 text-amber-800",
          )}
        >
          <span className="truncate">{t.title}</span>
          {t.kind === "overdue" && <span className="shrink-0 font-mono">{t.daysLate}d</span>}
        </span>
      ))}
    </div>
  );
}

// ── Import CSV panel ─────────────────────────────────────────

export function ImportCsvPanel({
  onClose,
  onDone,
  toast,
}: {
  onClose: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: string[]; total_rows: number } | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      // Raw text body (POST text/csv) — api helpers all assume JSON, so
      // we call the correlated raw-body transport. Auth token is the same one api uses — read it
      // THROUGH tokenStore, not from localStorage: a session-only login (Remember
      // me unchecked, or the owner's view-as) keeps the token in sessionStorage,
      // and the old inline read sent `Bearer ` and 401'd.
      // No timeout here would hang the dialog forever on a stalled cold-start;
      // cap it with an upload-length AbortSignal and surface a retryable error.
      const token = tokenStore.get();
      let signal: AbortSignal | undefined;
      try { signal = AbortSignal.timeout(120_000); } catch { signal = undefined; }
      let resp: Response;
      try {
        resp = await correlatedFetch(`${api.baseUrl}/api/projects/import/csv`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/csv",
            // Without X-Company-Id the backend stamps the hostname-default company
            // (HOUZS), so importing while "2990" is active would write to the wrong
            // company. Mirror lib/branding.ts.
            ...companyHeader(),
          },
          body: text,
          signal,
        });
      } catch (err) {
        if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw correlateError(
            new Error("The server took too long to respond. Please check your connection and try again."),
            requestIdFromError(err),
          );
        }
        throw err;
      }
      if (!resp.ok) throw correlateError(
        new Error(humanHttpMessage(resp.status, await resp.text().catch(() => ""))),
        requestIdFromResponse(resp),
      );
      const data = await consumeCorrelated(
        resp,
        () => resp.json() as Promise<{ imported: number; errors: string[]; total_rows: number }>,
      );
      setResult(data);
      if (data.imported > 0) toast.success(`Imported ${data.imported} of ${data.total_rows} row(s)`);
      onDone();
    } catch (e) {
      toast.error((e as { message?: string } | null)?.message || "Import failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="Import Projects from CSV"
      subtitle="Paste rows from the Google Sheet — header row recognised"
      width={560}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border bg-surface px-3 py-2 text-[12px]">
            Close
          </button>
          <Button variant="primary" onClick={submit} disabled={submitting || !text.trim()}>
            {submitting ? "Importing…" : "Import"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Columns">
        <div className="space-y-1.5 text-[11px] text-ink-secondary">
          <p>Supported header names (case-insensitive, use underscores or spaces):</p>
          <ul className="ml-4 list-disc space-y-0.5 font-mono text-[10.5px]">
            <li>name <span className="text-err">(required)</span></li>
            <li>brand · event_type · start_date · end_date</li>
            <li>venue · state · organizer · booth_no · size_sqm</li>
            <li>rental · total_sales · contractor_cost · license_fee</li>
            <li>notion_url</li>
          </ul>
          <p>Dates may be YYYY-MM-DD or DD/MM/YYYY. Unknown columns are ignored.</p>
        </div>
      </PanelSection>

      <PanelSection title="CSV">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"name,brand,event_type,start_date,end_date,venue,state\nPIKOM PC Fair 2026,AKEMI,exhibition,2026-05-10,2026-05-12,KLCC,Kuala Lumpur"}
          rows={14}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] outline-none focus:border-primary"
        />
      </PanelSection>

      {result && (
        <PanelSection title="Result" muted>
          <div className="text-[11px]">
            <span className="font-semibold text-synced">{result.imported}</span> imported,{" "}
            <span className="font-semibold text-ink-muted">{result.total_rows - result.imported}</span> skipped of{" "}
            {result.total_rows}
          </div>
          {result.errors.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-err/30 bg-err/5 p-2 text-[10px]">
              {result.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}
