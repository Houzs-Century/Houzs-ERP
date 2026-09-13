// ---------------------------------------------------------------------------
// Venture Portal Feed — the live sales-order feed to the Venture Portal, and
// everything needed to run it, on one screen.
//
// THE ORDER OF THE PAGE IS THE ORDER OF THE QUESTION somebody arrives with:
// is it working (the verdict), is it on and for whom (the switch), is it wired
// up (the connection), and then the queue itself with the reason on the row.
// AutoCount Sync is built the same way and for the same reason.
//
// EVERY DECISION IS IN lib/venturePortalFeed.ts, not here. This file renders.
// The mobile screen renders the same verdicts and calls the same actions, so a
// rule cannot be fixed on one surface and missed on the other — the owner's
// standing rule, and a bug class this repo keeps paying for.
//
// WHAT IS DELIBERATELY NOT ON THIS PAGE: a box to type the key into. It is
// minted by the server, revealed once, and afterwards the API answers with its
// length, its last four characters and when it was set — so outside that one
// reveal there is no code path here that could render it. Also no payload viewer
// — a delivery carries a customer's name and every line's cost, and this screen
// is about whether the feed works, not a window onto the orders themselves.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ListSkeleton } from "../components/Skeleton";
import { cn } from "../lib/utils";
/* ONE DATE FORMAT, ONE PLACE THAT WRITES IT (owner 2026-08-18). A bare
   toLocaleString here would render the device's format, so a delivery stamped
   09/12 would read as 12 September on one machine and 9 December on another —
   and this page's whole job is telling somebody WHEN something last got
   through. backend/scripts/check-date-formatting.mjs gates it. */
import { fmtDateTime } from "../vendor/shared/format";
import {
  VP_DEFAULT_RECEIVER_URL,
  VP_KEY_PASTE_LINE,
  VP_ROW_STATUS_LABEL,
  VP_ROW_STATUS_TONE,
  useVpActions,
  useVpRows,
  useVpStatus,
  vpKeyLine,
  vpOutcomeLine,
  vpReceiverDraft,
  vpReceiverHint,
  vpRowTodo,
  vpScopeLabel,
  vpVerdict,
  type VpRow,
  type VpRowStatus,
  type VpTone,
} from "../lib/venturePortalFeed";

const BANNER_TONE: Record<VpTone, string> = {
  good: "border-synced/40 bg-synced/5 text-synced",
  bad: "border-err/40 bg-err/5 text-err",
  wait: "border-amber-500/40 bg-amber-500/5 text-warning-text",
  off: "border-border bg-surface text-ink-muted",
};

const PILL_TONE: Record<VpTone, string> = {
  good: "border-synced/40 bg-synced/10 text-synced",
  bad: "border-err/40 bg-err/10 text-err",
  wait: "border-amber-500/40 bg-amber-500/10 text-warning-text",
  off: "border-border bg-canvas text-ink-muted",
};

const TABS: ReadonlyArray<{ id: VpRowStatus | "all"; label: string }> = [
  { id: "failed", label: "Not delivered" },
  { id: "pending", label: "Waiting" },
  { id: "sent", label: "Delivered" },
  { id: "skipped", label: "Out of scope" },
  { id: "all", label: "Everything" },
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-secondary">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink " +
  "placeholder:text-ink-muted focus:border-primary focus:outline-none disabled:opacity-60";

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-1 text-xs text-ink-muted">{description}</p> : null}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function RowCard({
  row,
  canManage,
  busy,
  onRequeue,
}: {
  row: VpRow;
  canManage: boolean;
  busy: string | null;
  onRequeue: (row: VpRow) => void;
}) {
  const tone = VP_ROW_STATUS_TONE[row.status];
  const outcome = vpOutcomeLine(row);
  const todo = vpRowTodo(row);
  const sending = busy === `row:${row.id}`;

  return (
    <div className={cn("rounded-md border p-3", tone === "bad" ? "border-err/25 bg-err/5" : "border-border bg-canvas")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm text-ink">{row.doc_no}</span>
        <span className={cn("rounded-full border px-2 py-0.5 text-xs", PILL_TONE[tone])}>
          {VP_ROW_STATUS_LABEL[row.status]}
        </span>
        {outcome ? <span className="text-xs text-ink-secondary">{outcome}</span> : null}
        <span className="text-xs text-ink-muted">{row.op}</span>
        {row.attempts > 1 ? <span className="text-xs text-ink-muted">tried {row.attempts}x</span> : null}
        {row.status === "failed" && canManage ? (
          <Button
            variant="secondary"
            className="ml-auto px-2 py-1 text-xs"
            disabled={sending}
            onClick={() => onRequeue(row)}
          >
            {sending ? "Sending" : "Send again"}
          </Button>
        ) : null}
      </div>
      {todo ? <p className="mt-2 text-xs text-ink">{todo}</p> : null}
      {row.last_error ? (
        <p className="mt-1 break-words font-mono text-xs text-ink-muted">{row.last_error}</p>
      ) : null}
    </div>
  );
}

export function VenturePortalFeed() {
  const status = useVpStatus();
  const [tab, setTab] = useState<VpRowStatus | "all">("failed");
  const rows = useVpRows(tab);

  const refresh = useCallback(() => {
    status.reload();
    rows.reload();
  }, [status, rows]);

  const actions = useVpActions(refresh);
  const s = status.data;
  const canManage = s?.canManage ?? false;
  const verdict = useMemo(() => vpVerdict(s), [s]);

  /* Draft state, seeded from the server on first load and then owned by the
     form. Deliberately NOT re-synced on every poll: overwriting a half-typed
     address every fifteen seconds is the classic version of this bug. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [sinceDraft, setSinceDraft] = useState<string | null>(null);
  const [companiesDraft, setCompaniesDraft] = useState<string | null>(null);
  const [everyCompany, setEveryCompany] = useState<boolean | null>(null);

  /* The receiver address arrives PRE-FILLED with the portal's own when nothing
     is stored, so the owner never types a URL. vpReceiverHint says plainly that
     it is only an offer until Save address is pressed. */
  const url = urlDraft ?? vpReceiverDraft(s);
  const since = sinceDraft ?? s?.connection.since ?? "";
  const scope = s?.feed.scope;
  const companies = companiesDraft ?? (Array.isArray(scope) ? scope.join(", ") : "");
  const allCompanies = everyCompany ?? scope === "all";

  const parsedCompanies = useMemo(
    () =>
      companies
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    [companies],
  );

  return (
    <div className="space-y-4 p-4">
      <PageHeader
        title="Venture Portal Feed"
        description="Every sales order, its lines, their costs and its cancellations, delivered to the Venture Portal from the save itself. The portal works out Revenue Department commission from these."
        primaryAction={
          <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={refresh}>
            Refresh
          </Button>
        }
      />

      {/* THE VERDICT. First, and in words rather than counts — a large waiting
          number is a busy queue and one order waiting since Tuesday is a feed
          that stopped, and those are the same number. */}
      <div className={cn("rounded-lg border p-4", BANNER_TONE[verdict.tone])}>
        <div className="flex items-start gap-2">
          {verdict.tone === "bad" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : null}
          <div>
            <p className="text-sm font-semibold">{verdict.headline}</p>
            {verdict.detail ? <p className="mt-1 text-xs opacity-90">{verdict.detail}</p> : null}
          </div>
        </div>
      </div>

      {actions.note ? (
        <div className={cn("rounded-md border px-3 py-2 text-sm", BANNER_TONE[actions.note.tone])}>
          {actions.note.text}
        </div>
      ) : null}

      {!s && status.loading ? <ListSkeleton /> : null}

      {s ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="Switch"
              description="Off means no sales order leaves this system. Nothing piles up waiting while it is off."
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className={cn("rounded-full border px-2 py-0.5 text-xs", PILL_TONE[s.feed.enabled ? "good" : "off"])}>
                  {s.feed.enabled ? "On" : "Off"}
                </span>
                <span className="text-xs text-ink-secondary">{vpScopeLabel(s)}</span>
              </div>

              <Field
                label="Companies"
                hint="Which companies' sales orders feed the portal. Houzs Century is 1. Nothing is sent for a company that is not listed here."
              >
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={allCompanies}
                      disabled={!canManage}
                      onChange={(e) => setEveryCompany(e.target.checked)}
                    />
                    Every company
                  </label>
                  <input
                    className={inputClass}
                    value={companies}
                    placeholder="1"
                    disabled={!canManage || allCompanies}
                    onChange={(e) => setCompaniesDraft(e.target.value)}
                  />
                </div>
              </Field>

              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={actions.busy === "scope" || (!allCompanies && parsedCompanies.length === 0)}
                    onClick={() => void actions.saveScope(true, allCompanies ? "all" : parsedCompanies)}
                  >
                    {actions.busy === "scope" ? "Saving" : s.feed.enabled ? "Save and keep on" : "Turn on"}
                  </Button>
                  {s.feed.enabled ? (
                    <Button
                      variant="danger"
                      disabled={actions.busy === "scope"}
                      onClick={() => void actions.saveScope(false, [])}
                    >
                      Turn off
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-ink-muted">You can see the feed but not change it.</p>
              )}
            </Card>

            <Card
              title="Connection"
              description="Where deliveries go, and the API key the portal checks. The key is generated here and shown once."
            >
              <Field label="Receiver address" hint={vpReceiverHint(s)}>
                <input
                  className={inputClass}
                  value={url}
                  placeholder={VP_DEFAULT_RECEIVER_URL}
                  disabled={!canManage}
                  onChange={(e) => setUrlDraft(e.target.value)}
                />
              </Field>

              <Field
                label="Do not send orders dated before"
                hint="Leave empty to send every order in scope, however old. Setting this keeps years of history out of somebody's commission."
              >
                <input
                  className={inputClass}
                  type="date"
                  value={since}
                  disabled={!canManage}
                  onChange={(e) => setSinceDraft(e.target.value)}
                />
              </Field>

              {canManage ? (
                <Button
                  variant="secondary"
                  disabled={actions.busy === "connection" || !url}
                  onClick={() => void actions.saveConnection(url, since)}
                >
                  {actions.busy === "connection" ? "Saving" : "Save address"}
                </Button>
              ) : null}

              {/* THE KEY. No input box: there is nothing here for anybody to
                  type, which is the change the owner asked for — 「我这边只需要
                  填那个 API key」, and the one place it is typed is the portal. */}
              <Field label="API key" hint={vpKeyLine(s)}>
                <div className="rounded-md border border-border bg-canvas px-3 py-2 font-mono text-sm text-ink-muted">
                  {s.connection.secret.set ? `····${s.connection.secret.tail}` : "not set"}
                </div>
              </Field>

              {/* THE ONE-TIME REVEAL. Shown only while the shared layer is
                  holding a freshly minted key; after Done it is gone from the
                  browser and the server will not answer it again. */}
              {actions.revealedKey ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <p className="text-xs font-semibold text-warning-text">Copy this now</p>
                  <p className="mt-2 select-all break-all rounded border border-border bg-surface px-2 py-2 font-mono text-sm text-ink">
                    {actions.revealedKey}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void actions.copyKey()}>
                      {actions.keyCopied ? "Copied" : "Copy"}
                    </Button>
                    <Button variant="secondary" className="px-2 py-1 text-xs" onClick={actions.dismissKey}>
                      Done
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-ink">{VP_KEY_PASTE_LINE}</p>
                </div>
              ) : null}

              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={s.connection.secret.set ? "secondary" : "primary"}
                    disabled={actions.busy === "generate"}
                    onClick={() => void actions.generateKey()}
                  >
                    {actions.busy === "generate"
                      ? "Generating"
                      : s.connection.secret.set
                        ? "Generate a new API key"
                        : "Generate API key"}
                  </Button>
                  <Button variant="secondary" disabled={actions.busy === "probe"} onClick={() => void actions.probe()}>
                    {actions.busy === "probe" ? "Testing" : "Test connection"}
                  </Button>
                </div>
              ) : null}
            </Card>
          </div>

          <Card
            title="The queue"
            description={`Waiting ${s.queue.pending} · delivered ${s.queue.sent} · not delivered ${s.queue.failed} · out of scope ${s.queue.skipped}. A save sends its own order; a sweep every five minutes collects anything left over, up to ${s.queue.batch} at a time.`}
          >
            {s.queue.lastSent ? (
              <p className="text-xs text-ink-muted">
                Last delivered: <span className="font-mono">{s.queue.lastSent.doc_no}</span> at{" "}
                {fmtDateTime(s.queue.lastSent.sent_at)}
              </p>
            ) : null}

            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={actions.busy === "queue"}
                  onClick={() => void actions.queueUndelivered(false)}
                >
                  {actions.busy === "queue" ? "Checking" : "Queue anything not delivered"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={actions.busy === "drain"}
                  onClick={() => void actions.sendNow(s.queue.batch)}
                >
                  {actions.busy === "drain" ? "Sending" : "Send now"}
                </Button>
              </div>
            ) : null}

            {/* Counts come from the SERVER's aggregate, not from the loaded
                page — the list is server-filtered and capped at 100, so
                counting what is on screen would understate a real backlog.
                FilterPills' own comment asks for exactly this. */}
            <FilterPills
              options={TABS.map((t) => ({
                value: t.id,
                label: t.label,
                count: t.id === "all" ? undefined : s.queue[t.id],
              }))}
              value={tab}
              onChange={(v) => setTab(v)}
            />

            {rows.loading && !rows.data ? (
              <ListSkeleton />
            ) : (rows.data?.rows.length ?? 0) === 0 ? (
              <p className="py-6 text-center text-sm text-ink-muted">
                {tab === "failed"
                  ? "Nothing has failed to deliver."
                  : tab === "pending"
                    ? "Nothing is waiting."
                    : "Nothing here."}
              </p>
            ) : (
              <div className="space-y-2">
                {(rows.data?.rows ?? []).map((row) => (
                  <RowCard
                    key={row.id}
                    row={row}
                    canManage={canManage}
                    busy={actions.busy}
                    onRequeue={(r) => void actions.requeueRow(r.id, r.doc_no)}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

export default VenturePortalFeed;
