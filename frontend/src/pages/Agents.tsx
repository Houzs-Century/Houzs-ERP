import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Truck,
  FileSearch,
  Coins,
  Headset,
  Package,
  BarChart3,
  ClipboardCheck,
  TrendingUp,
  Play,
  Pause,
  Power,
  Check,
  X,
  Plus,
  Trash2,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { StatCard } from "../components/StatCard";
import { ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { cn, formatCurrency, relativeTime } from "../lib/utils";

// ── Types (mirror the /api/agents contract, docs/agent-console-api.md) ────────

type Family = "DELIVERY" | "DOCUMENT" | "COLLECTION" | "CS" | "PROCUREMENT" | "PMS" | "OF" | "SI";

interface RunRow {
  id: string;
  agent: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  summary: string | null;
  error: string | null;
}

interface AgentCard {
  id: Family;
  live: boolean;
  paused: boolean;
  autoApprove: boolean;
  /** Stored autonomy dial 1/2/3, and the per-agent ceiling it can't exceed. */
  stage: number;
  maxStage: number;
  tasks: { agent: string; nextRun: string; lastRun: RunRow | null }[];
  today: { runs: number };
  month: { runs: number; tokensIn: number; tokensOut: number; estCostMyr: number };
  pendingConfigProposals: number;
  recentErrors: RunRow[];
}

interface LlmFamilyUsage {
  family: string;
  estCostMyr: number;
  budgetMyr: number;
  pctOfBudget: number;
  allowed: boolean;
}

interface LlmUsage {
  estCostMyr: number;
  budgetMyrPerAgent: number;
  byFamily: LlmFamilyUsage[];
}

interface StatusResp {
  killAll: boolean;
  generatedAt: string;
  agents: AgentCard[];
  llm: LlmUsage | null;
}

interface EngineProposal {
  id: string;
  kind: string;
  key: string;
  status: string;
  payload: Record<string, unknown> | null;
  summary: string;
  createdAt: string | null;
}

interface Finding {
  id: string;
  kind: string;
  severity: string;
  docType?: string;
  docNo?: string | null;
  // Order-fulfilment (OF) findings are order-centric, not doc-centric.
  soDocNo?: string;
  readiness?: number;
  owner?: string | null;
  // Sales-intelligence (SI) findings are subject-centric (order / salesperson / venue).
  subject?: string;
  metric?: string | null;
  summary: string;
  status: string;
  createdAt: string | null;
}

interface Feedback {
  id: string;
  createdAt: string;
  agent: string;
  instruction: string;
  status: string;
}

interface ConfigProposal {
  id: string;
  paramKey: string;
  currentValue: string | null;
  proposedValue: string;
  reason: string;
  status: string;
}

interface BriefResp {
  id: string;
  brief: Record<string, unknown> | null;
  aiFocus?: string | null;
  createdAt?: string | null;
  generatedAt?: string | null;
}

interface ReviewFamily {
  family: Family;
  task: string;
  lastRunAt: string | null;
  runs: number;
  errors: number;
  proposals: { raised: number; pending: number; approved: number; rejected: number } | null;
  findings: { open: number; resolvedRecently: number } | null;
  decisions: { approved: number; rejected: number };
}

interface ReviewResp {
  windowDays: number;
  families: ReviewFamily[];
}

interface FamilyMeta {
  id: Family;
  label: string;
  base: string;
  icon: LucideIcon;
  /** Document works a findings list, not proposals. */
  findings?: boolean;
}

const FAMILIES: FamilyMeta[] = [
  { id: "DELIVERY", label: "Delivery", base: "delivery", icon: Truck },
  { id: "DOCUMENT", label: "Document", base: "document", icon: FileSearch, findings: true },
  { id: "COLLECTION", label: "Collection", base: "collection", icon: Coins },
  { id: "CS", label: "Customer service", base: "cs", icon: Headset },
  { id: "PROCUREMENT", label: "Procurement", base: "procurement", icon: Package },
  { id: "PMS", label: "Roadshow / PMS", base: "pms", icon: BarChart3 },
  { id: "OF", label: "Order fulfilment", base: "of", icon: ClipboardCheck, findings: true },
  { id: "SI", label: "Sales intelligence", base: "si", icon: TrendingUp, findings: true },
];

const CARD = "relative overflow-hidden rounded-md border border-border bg-surface p-6 shadow-stone";

function severityTone(sev: string): "error" | "warning" | "neutral" {
  return sev === "CRIT" ? "error" : sev === "WARN" ? "warning" : "neutral";
}

// The /api/agents routes all return the house `{ success, data }` envelope,
// and api.get does NOT unwrap it — pull `.data` out so callers get the payload.
function getData<T>(path: string): Promise<T> {
  return api.get<{ success: boolean; data: T }>(path).then((r) => r.data);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function Agents() {
  const toast = useToast();
  const dialog = useDialog();
  const status = useQuery<StatusResp>("/api/agents/status", () => getData("/api/agents/status"));
  const [selected, setSelected] = useState<Family>("DELIVERY");
  const [view, setView] = useState<"console" | "scorecard">("console");
  const [busy, setBusy] = useState<string | null>(null);

  const meta = FAMILIES.find((f) => f.id === selected)!;

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      status.reload();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : "Something went wrong."}`);
    } finally {
      setBusy(null);
    }
  }

  const data = status.data;
  const killAll = data?.killAll === true;
  const liveCount = (data?.agents ?? []).filter((a) => a.live).length;
  const monthSpend = data?.llm?.estCostMyr ?? 0;
  const pendingConfig = (data?.agents ?? []).reduce((s, a) => s + (a.pendingConfigProposals ?? 0), 0);

  async function toggleKill() {
    const turningOn = !killAll;
    if (turningOn) {
      const ok = await dialog.confirm({
        title: "Stop every agent",
        message:
          "The global kill switch halts all agents, including manual runs, until you turn it off. Continue?",
        tone: "danger",
        confirmLabel: "Kill all",
      });
      if (!ok) return;
    }
    await act(
      "kill",
      () => api.post("/api/agents/kill-all", { on: turningOn }),
      turningOn ? "Kill switch on — all agents stopped" : "Kill switch lifted",
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="Agent console"
        description="Owner only. The agents propose; you decide."
        primaryAction={
          <Button
            variant={killAll ? "primary" : "danger"}
            icon={<Power size={16} />}
            onClick={toggleKill}
            disabled={busy === "kill"}
          >
            {killAll ? "Resume all" : "Kill all"}
          </Button>
        }
      />

      {status.loading && !data ? (
        <ListSkeleton />
      ) : status.error ? (
        <div className={CARD}>
          <EmptyState
            icon={<Bot size={28} />}
            message="Couldn't load the agent console"
            description={status.error}
          />
        </div>
      ) : !data ? null : (
        <div className="flex flex-col gap-6">
          {killAll && (
            <div className="flex items-center gap-2 rounded-md border border-err/40 bg-err/5 px-4 py-2.5 text-[13px] text-err">
              <Power size={16} />
              Global kill switch is on. No agent will run until you resume.
            </div>
          )}

          {/* View tabs */}
          <div className="flex gap-1 border-b border-border">
            <TabBtn active={view === "console"} onClick={() => setView("console")}>
              Console
            </TabBtn>
            <TabBtn active={view === "scorecard"} onClick={() => setView("scorecard")}>
              Scorecard
            </TabBtn>
          </div>

          {view === "scorecard" ? (
            <Scorecard />
          ) : (
          <>
          {/* Metrics */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Families live" value={`${liveCount} / ${FAMILIES.length}`} />
            <StatCard
              label="LLM spend this month"
              value={formatCurrency(monthSpend)}
              subtitle={
                data.llm ? `Budget ${formatCurrency(data.llm.budgetMyrPerAgent)} per agent` : undefined
              }
            />
            <StatCard
              label="Config tuning pending"
              value={pendingConfig}
              tone={pendingConfig > 0 ? "warning" : "default"}
            />
          </div>

          {/* Family grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FAMILIES.map((f) => {
              const card = data.agents.find((a) => a.id === f.id);
              const usage = data.llm?.byFamily.find((u) => u.family === f.id);
              return (
                <FamilyTile
                  key={f.id}
                  meta={f}
                  card={card}
                  usage={usage}
                  selected={selected === f.id}
                  busy={busy}
                  onSelect={() => setSelected(f.id)}
                  onPause={(paused) =>
                    act(
                      `pause:${f.id}`,
                      () => api.post("/api/agents/pause", { agent: f.id, paused }),
                      paused ? `${f.label} paused` : `${f.label} resumed`,
                    )
                  }
                  onGate={(stage) =>
                    act(
                      `gate:${f.id}`,
                      () => api.post("/api/agents/gate", { agent: f.id, stage }),
                      `${f.label} autonomy stage ${stage}`,
                    )
                  }
                  onRun={() =>
                    act(
                      `run:${f.id}`,
                      () => api.post("/api/agents/run-now", { task: `${f.base}-run` }),
                      `${f.label} run started`,
                    )
                  }
                />
              );
            })}
          </div>

          {/* Working surface for the selected family */}
          <WorkingSurface meta={meta} card={data.agents.find((a) => a.id === selected)} />
          </>
          )}
        </div>
      )}
    </div>
  );
}

// ── View tab button ──────────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "border-primary text-ink"
          : "border-transparent text-ink-secondary hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

// ── Family tile ──────────────────────────────────────────────────────────────

function FamilyTile({
  meta,
  card,
  usage,
  selected,
  busy,
  onSelect,
  onPause,
  onGate,
  onRun,
}: {
  meta: FamilyMeta;
  card: AgentCard | undefined;
  usage: LlmFamilyUsage | undefined;
  selected: boolean;
  busy: string | null;
  onSelect: () => void;
  onPause: (paused: boolean) => void;
  onGate: (stage: number) => void;
  onRun: () => void;
}) {
  const Icon = meta.icon;
  const paused = card?.paused === true;
  const stage = card?.stage ?? 1;
  const maxStage = card?.maxStage ?? 2;
  const dot = paused ? "bg-warning-text" : card?.live ? "bg-synced" : "bg-ink-muted";
  const last = card?.tasks?.[0]?.lastRun ?? null;
  const pct = Math.min(100, Math.round(usage?.pctOfBudget ?? 0));

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
      className={cn(
        "cursor-pointer rounded-lg border bg-surface p-4 text-left shadow-stone transition-all duration-150 hover:-translate-y-px hover:shadow-slab",
        selected ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className={cn("inline-block h-2 w-2 rounded-full", dot)} />
        <Icon size={16} className="text-ink-secondary" />
        <span className="text-[13px] font-semibold text-ink">{meta.label}</span>
        {stage >= 2 && (
          <Badge tone="accent" caseless className="ml-auto">
            {stage >= 3 ? "Full-auto" : "Auto-tune"}
          </Badge>
        )}
      </div>

      <div className="mb-2 text-[11px] text-ink-secondary">
        {card ? `${card.today.runs} run${card.today.runs === 1 ? "" : "s"} today` : "not registered"}
        {last?.startedAt ? ` · last ${relativeTime(last.startedAt)}` : ""}
        {card && card.pendingConfigProposals > 0 ? ` · ${card.pendingConfigProposals} tuning` : ""}
      </div>

      {usage && usage.estCostMyr > 0 && (
        <div className="mb-3">
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-dim">
            <span
              className={cn("block h-full rounded-full", pct >= 100 ? "bg-err" : "bg-primary")}
              style={{ width: `${Math.max(3, pct)}%` }}
            />
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            {formatCurrency(usage.estCostMyr)} of {formatCurrency(usage.budgetMyr)} this month
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        <MiniBtn
          label={paused ? "Resume" : "Pause"}
          icon={paused ? <Play size={13} /> : <Pause size={13} />}
          onClick={() => onPause(!paused)}
          disabled={busy === `pause:${meta.id}`}
        />
        <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label="Autonomy stage">
          {[1, 2, 3].map((s) => {
            const over = s > maxStage;
            const on = stage === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => !over && onGate(s)}
                disabled={over || busy === `gate:${meta.id}`}
                title={
                  over
                    ? "Above this agent's ceiling"
                    : s === 1
                      ? "Propose only — a human approves"
                      : s === 2
                        ? "Auto-tune config + self-approve reversible actions within policy"
                        : "Full auto (closed-loop)"
                }
                className={cn(
                  "px-2 py-1 text-[11px] font-medium",
                  on ? "bg-primary text-white" : "bg-surface text-ink-secondary hover:bg-surface-dim",
                  over ? "cursor-not-allowed opacity-35" : "",
                  s > 1 ? "border-l border-border" : "",
                )}
              >
                {`S${s}`}
              </button>
            );
          })}
        </div>
        <MiniBtn
          label="Run now"
          icon={<Play size={13} />}
          onClick={onRun}
          disabled={busy === `run:${meta.id}` || !card?.live}
        />
      </div>
    </div>
  );
}

function MiniBtn({
  label,
  icon,
  onClick,
  active,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40",
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-border bg-surface text-ink-secondary hover:border-border-strong hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Working surface (proposals / findings + brief + config + notebook) ───────

function WorkingSurface({ meta, card }: { meta: FamilyMeta; card: AgentCard | undefined }) {
  const Icon = meta.icon;
  return (
    <div className={CARD}>
      <div className="mb-4 flex items-center gap-2">
        <Icon size={18} className="text-primary" />
        <h2 className="text-[15px] font-semibold text-ink">{meta.label}</h2>
        <span className="ml-auto text-[11px] text-ink-secondary">
          Approving marks it ready for the office — the agent never edits a document itself.
        </span>
      </div>

      <AiFocus meta={meta} />

      <RecentErrors errors={card?.recentErrors ?? []} />

      <div className="mt-4">
        {meta.findings ? <FindingsPanel meta={meta} /> : <ProposalsPanel meta={meta} />}
      </div>

      <ConfigPanel family={meta.id} />
      <RunHistory meta={meta} />
      <FeedbackPanel meta={meta} />
    </div>
  );
}

// ── Recent errors (from /status → card.recentErrors) ─────────────────────────

function RecentErrors({ errors }: { errors: RunRow[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-err/40 bg-err/5 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-err">
        <X size={14} />
        Recent errors ({errors.length})
      </div>
      <ul className="flex flex-col gap-1">
        {errors.map((e) => (
          <li key={e.id} className="text-[12px] leading-snug text-ink-secondary">
            <span className="text-ink-muted">
              {e.startedAt ? relativeTime(e.startedAt) : "—"}
            </span>{" "}
            {e.error ?? e.summary ?? "Run failed"}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Run history drawer (read-only, from /history?family=) ────────────────────

function RunHistory({ meta }: { meta: FamilyMeta }) {
  const [open, setOpen] = useState(false);
  const q = useQuery<RunRow[]>("/api/agents/history?family=:&limit=20",
    () => (open ? getData(`/api/agents/history?family=${meta.id}&limit=20`) : Promise.resolve([])),
    [meta.id, open],
  );
  const rows = q.data ?? [];

  return (
    <div className="mt-5 border-t border-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-muted transition-colors hover:text-ink"
      >
        <RefreshCw size={13} />
        Run history
        <span className="text-ink-muted/70">{open ? "(hide)" : "(show)"}</span>
      </button>
      {open &&
        (q.loading && !q.data ? (
          <ListSkeleton />
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">No runs recorded yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="mb-0.5 flex flex-wrap items-center gap-2">
                    <Badge tone={r.status === "error" ? "error" : "neutral"} caseless>
                      {r.status}
                    </Badge>
                    {r.startedAt && (
                      <span className="text-[11px] text-ink-muted">{relativeTime(r.startedAt)}</span>
                    )}
                  </div>
                  <p className="text-[13px] leading-snug text-ink">
                    {r.error ?? r.summary ?? "—"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function AiFocus({ meta }: { meta: FamilyMeta }) {
  const brief = useQuery<BriefResp | null>("/api/agents/:/brief", () => getData(`/api/agents/${meta.base}/brief`), [meta.base]);
  const focus = brief.data?.aiFocus;
  if (!focus) return null;
  return (
    <div className="flex gap-2 rounded-md border border-border bg-surface-dim/60 px-3 py-2.5">
      <Sparkles size={15} className="mt-0.5 shrink-0 text-accent" />
      <p className="text-[13px] leading-snug text-ink-secondary">{focus}</p>
    </div>
  );
}

function ProposalsPanel({ meta }: { meta: FamilyMeta }) {
  const toast = useToast();
  const dialog = useDialog();
  const q = useQuery<EngineProposal[]>("/api/agents/:/proposals?status=PENDING",
    () => getData(`/api/agents/${meta.base}/proposals?status=PENDING`),
    [meta.base],
  );
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, action: "approve" | "reject") {
    if (action === "reject") {
      const ok = await dialog.confirm({ message: "Reject this proposal?", tone: "danger", confirmLabel: "Reject" });
      if (!ok) return;
    }
    setBusy(id);
    try {
      await api.post(`/api/agents/${meta.base}/proposals/decide`, { ids: [id], action });
      toast.success(action === "approve" ? "Approved" : "Rejected");
      q.reload();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : "Something went wrong."}`);
    } finally {
      setBusy(null);
    }
  }

  if (q.loading && !q.data) return <ListSkeleton />;
  const rows = q.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Check size={26} />}
        message="Nothing waiting"
        description="No pending proposals for this agent right now."
      />
    );
  }

  return (
    <div className="divide-y divide-border">
      {rows.map((p) => {
        const sev = typeof p.payload?.severity === "string" ? (p.payload.severity as string) : null;
        return (
          <div key={p.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge tone="neutral" caseless>
                  {p.kind.replace(/_/g, " ").toLowerCase()}
                </Badge>
                {sev && (
                  <Badge tone={severityTone(sev)}>{sev}</Badge>
                )}
                {p.createdAt && (
                  <span className="text-[11px] text-ink-muted">{relativeTime(p.createdAt)}</span>
                )}
              </div>
              <p className="text-[13px] leading-snug text-ink">{p.summary}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <IconAction
                title="Approve"
                icon={<Check size={15} />}
                tone="success"
                onClick={() => decide(p.id, "approve")}
                disabled={busy === p.id}
              />
              <IconAction
                title="Reject"
                icon={<X size={15} />}
                onClick={() => decide(p.id, "reject")}
                disabled={busy === p.id}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FindingsPanel({ meta }: { meta: FamilyMeta }) {
  const toast = useToast();
  const q = useQuery<Finding[]>("/api/agents/:/findings?status=OPEN",
    () => getData(`/api/agents/${meta.base}/findings?status=OPEN`),
    [meta.base],
  );
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(id: string) {
    setBusy(id);
    try {
      await api.post(`/api/agents/${meta.base}/findings/resolve`, { ids: [id] });
      toast.success("Dismissed");
      q.reload();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : "Something went wrong."}`);
    } finally {
      setBusy(null);
    }
  }

  if (q.loading && !q.data) return <ListSkeleton />;
  const rows = q.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Check size={26} />}
        message="All clear"
        description="No open findings from the last patrol."
      />
    );
  }

  return (
    <div className="divide-y divide-border">
      {rows.map((f) => (
        <div key={f.id} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
              <Badge tone="neutral" caseless>
                {f.kind.replace(/_/g, " ").toLowerCase()}
              </Badge>
              {(f.docNo || f.soDocNo || f.subject) && <span className="text-[11px] font-medium text-ink-secondary">{f.docNo || f.soDocNo || f.subject}</span>}
              {f.metric && <span className="text-[11px] font-semibold text-ink-secondary">{f.metric}</span>}
              {f.owner && <Badge tone="neutral" caseless>{f.owner.toLowerCase()}</Badge>}
              {typeof f.readiness === "number" && (
                <span className="text-[11px] text-ink-muted">ready {f.readiness}%</span>
              )}
              {f.createdAt && <span className="text-[11px] text-ink-muted">{relativeTime(f.createdAt)}</span>}
            </div>
            <p className="text-[13px] leading-snug text-ink">{f.summary}</p>
          </div>
          <IconAction
            title="Dismiss"
            icon={<Check size={15} />}
            onClick={() => resolve(f.id)}
            disabled={busy === f.id}
          />
        </div>
      ))}
    </div>
  );
}

function ConfigPanel({ family }: { family: Family }) {
  const toast = useToast();
  const q = useQuery<ConfigProposal[]>("/api/agents/config-proposals?status=PENDING", () => getData("/api/agents/config-proposals?status=PENDING"));
  const [busy, setBusy] = useState<string | null>(null);
  const prefix = `${family.toLowerCase()}.`;
  const rows = (q.data ?? []).filter((p) => p.paramKey.startsWith(prefix));

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id);
    try {
      await api.post("/api/agents/config-proposals/decide", { ids: [id], action });
      toast.success(action === "approve" ? "Applied" : "Rejected");
      q.reload();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : "Something went wrong."}`);
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return null;
  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
        Learned tuning ({rows.length})
      </div>
      <div className="divide-y divide-border">
        {rows.map((p) => (
          <div key={p.id} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                <span className="font-mono text-[12px] text-ink-secondary">{p.paramKey}</span>{" "}
                {p.currentValue ?? "—"} <span className="text-ink-muted">to</span> {p.proposedValue}
              </p>
              <p className="text-[12px] leading-snug text-ink-secondary">{p.reason}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <IconAction
                title="Apply"
                icon={<Check size={15} />}
                tone="success"
                onClick={() => decide(p.id, "approve")}
                disabled={busy === p.id}
              />
              <IconAction
                title="Reject"
                icon={<X size={15} />}
                onClick={() => decide(p.id, "reject")}
                disabled={busy === p.id}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeedbackPanel({ meta }: { meta: FamilyMeta }) {
  const toast = useToast();
  const q = useQuery<Feedback[]>("/api/agents/feedback?agent=:&status=ACTIVE",
    () => getData(`/api/agents/feedback?agent=${meta.id}&status=ACTIVE`),
    [meta.id],
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = q.data ?? [];

  async function add() {
    const instruction = text.trim();
    if (!instruction) return;
    setBusy(true);
    try {
      await api.post("/api/agents/feedback", { agent: meta.id, instruction });
      setText("");
      toast.success("Saved to the agent's notebook");
      q.reload();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : "Something went wrong."}`);
    } finally {
      setBusy(false);
    }
  }

  async function retire(id: string) {
    try {
      await api.post(`/api/agents/feedback/${id}/retire`, {});
      q.reload();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : "Something went wrong."}`);
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
        Teach this agent
      </div>
      {rows.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-start justify-between gap-2 rounded-md bg-surface-dim/50 px-3 py-2"
            >
              <span className="text-[13px] leading-snug text-ink-secondary">{r.instruction}</span>
              <button
                type="button"
                title="Retire"
                onClick={() => retire(r.id)}
                className="shrink-0 text-ink-muted transition-colors hover:text-err"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="Chase Sunway venue debtors first — they settle fast"
          className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary"
        />
        <Button variant="secondary" icon={<Plus size={15} />} onClick={add} disabled={busy || !text.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

// ── Scorecard (read-only per-family performance, from /review) ───────────────

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function Scorecard() {
  const q = useQuery<ReviewResp>("/api/agents/review", () => getData("/api/agents/review"));

  if (q.loading && !q.data) return <ListSkeleton />;
  if (q.error) {
    return (
      <div className={CARD}>
        <EmptyState icon={<BarChart3 size={26} />} message="Couldn't load the scorecard" description={q.error} />
      </div>
    );
  }
  const data = q.data;
  if (!data) return null;

  return (
    <div className={CARD}>
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 size={18} className="text-primary" />
        <h2 className="text-[15px] font-semibold text-ink">Fleet scorecard</h2>
        <span className="ml-auto text-[11px] text-ink-secondary">
          Last {data.windowDays} days · outcomes only, read-only
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.families.map((f) => {
          const fm = FAMILIES.find((x) => x.id === f.family);
          const Icon = fm?.icon ?? Bot;
          const approvalRate = f.proposals ? pct(f.proposals.approved, f.proposals.approved + f.proposals.rejected) : null;
          return (
            <div key={f.family} className="rounded-lg border border-border bg-surface p-4 shadow-stone">
              <div className="mb-2 flex items-center gap-2">
                <Icon size={16} className="text-ink-secondary" />
                <span className="text-[13px] font-semibold text-ink">{fm?.label ?? f.family}</span>
                {f.errors > 0 && (
                  <Badge tone="error" className="ml-auto">
                    {f.errors} err
                  </Badge>
                )}
              </div>

              <div className="mb-3 text-[11px] text-ink-secondary">
                {f.runs} run{f.runs === 1 ? "" : "s"}
                {f.lastRunAt ? ` · last ${relativeTime(f.lastRunAt)}` : " · never run"}
              </div>

              <dl className="flex flex-col gap-1.5 text-[12px]">
                {f.proposals ? (
                  <>
                    <ScoreRow label="Proposals raised" value={String(f.proposals.raised)} />
                    <ScoreRow
                      label="Approved / rejected"
                      value={`${f.proposals.approved} / ${f.proposals.rejected}`}
                    />
                    <ScoreRow
                      label="Approval rate"
                      value={approvalRate == null ? "—" : `${approvalRate}%`}
                    />
                    <ScoreRow label="Pending" value={String(f.proposals.pending)} />
                  </>
                ) : f.findings ? (
                  <>
                    <ScoreRow label="Open findings" value={String(f.findings.open)} />
                    <ScoreRow label="Resolved (window)" value={String(f.findings.resolvedRecently)} />
                  </>
                ) : (
                  <ScoreRow label="Proposals" value="—" />
                )}
                <ScoreRow
                  label="Tuning approved / rejected"
                  value={`${f.decisions.approved} / ${f.decisions.rejected}`}
                />
              </dl>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function IconAction({
  title,
  icon,
  onClick,
  tone,
  disabled,
}: {
  title: string;
  icon: ReactNode;
  onClick: () => void;
  tone?: "success";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:opacity-40",
        tone === "success"
          ? "border-synced/40 text-synced hover:bg-synced/5 hover:border-synced"
          : "border-border text-ink-secondary hover:border-border-strong hover:text-ink",
      )}
    >
      {icon}
    </button>
  );
}
