import { useCallback, useEffect, useState } from "react";
import { Bot, Copy, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";
import { BriefEmails } from "./AiConnectorBrief";

type MyApp = { tokenId: string; app: string; connectedAt: string | null; lastUsedAt: string | null };
type Me = { allowed: boolean; isAdmin: boolean; pendingRequest: { id: string; createdAt: string | null } | null; connectorUrl: string; apps: MyApp[] };
type Person = { userId: number; name: string; position: string };
type Overview = {
  connectorUrl: string;
  actionsEnabled: boolean;
  actionSwitches?: { mailReply: boolean; note: boolean };
  limits?: { perMinute: number; perDay: number };
  stats: { connectedPeople: number; callsToday: number; refusedToday: number; waiting: number };
  requests: (Person & { id: string; reason: string; createdAt: string | null })[];
  connected: (Person & { tokenId: string; app: string; connectedAt: string | null; lastUsedAt: string | null })[];
  allowed: (Person & { approvedAt: string | null })[];
  calls: { id: string; userId: number; name: string; app: string; tool: string; target: string; status: number; ok: boolean; note: string; ms: number; at: string | null }[];
  staff: Person[];
  noGuide?: { tool: string; question: string; times: number; lastAt: string | null }[];
};
type LeakRow = { path: string; outcome: "opened" | "refused" | "error"; status: number; hidden: string[]; sensitive: string[] };

const CARD = "rounded-xl border border-border bg-surface";
const TH = "px-3 py-2 text-left text-xs font-semibold text-ink-secondary";
const TD = "px-3 py-2 align-top text-sm text-ink";

const when = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-MY", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

function Section({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={cn(CARD, "overflow-hidden")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {sub && <p className="text-[13px] text-ink-secondary">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-4 text-sm text-ink-muted sm:px-5">{children}</p>;
}

function ConnectorUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink">{url}</code>
      <Button
        variant="secondary"
        icon={<Copy size={14} />}
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            // eslint-disable-next-line houzs/no-imperative-timers -- a UI delay: the Copied label reverts after 1.5s
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function HowTo({ url }: { url: string }) {
  const [tab, setTab] = useState<"claude" | "chatgpt">("claude");
  const steps =
    tab === "claude"
      ? ["Open Claude: Settings > Connectors > Add custom connector.", "Name: Houzs ERP. URL: the connector address above.", "Press Connect, sign in to the ERP if asked, then press Allow.", "Ask a question in a new chat, e.g. \"How many sales orders did we get this week?\""]
      : ["Open ChatGPT: Settings > Apps & Connectors > Advanced > turn on Developer mode.", "Create a connector: name Houzs ERP, URL the connector address above, authentication OAuth.", "Sign in to the ERP when asked, then press Allow.", "In a new chat, choose the Houzs ERP connector and ask your question."];
  return (
    <Section title="How to connect" sub="Works with Claude and ChatGPT (and any app that supports remote MCP connectors).">
      <div className="px-4 pb-4 pt-3 sm:px-5">
        <div className="mb-3 flex gap-2" role="tablist">
          {(["claude", "chatgpt"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("rounded-lg px-3 py-1.5 text-sm", tab === t ? "bg-primary text-white" : "bg-surface-2 text-ink-secondary")}
            >
              {t === "claude" ? "Claude" : "ChatGPT"}
            </button>
          ))}
        </div>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-secondary">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <div className="mt-3">
          <ConnectorUrl url={url} />
        </div>
      </div>
    </Section>
  );
}

function LeakCheck({ people }: { people: Person[] }) {
  const [who, setWho] = useState("");
  const [rows, setRows] = useState<LeakRow[]>([]);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setRows([]);
    setProg(null);
    try {
      let offset = 0;
      const all: LeakRow[] = [];
      for (let guard = 0; guard < 300; guard++) {
        // eslint-disable-next-line no-await-in-loop -- one server page at a time, so progress shows and the Worker never runs the whole sweep at once
        const d = await api.post<{ total: number; next: number; done: boolean; rows: LeakRow[] }>("/api/mcp-admin/admin/leak-check", { userId: Number(who), offset });
        all.push(...d.rows);
        setRows([...all]);
        setProg({ done: d.next, total: d.total });
        if (d.done) break;
        offset = d.next;
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const opened = rows.filter((r) => r.outcome === "opened");
  const refused = rows.filter((r) => r.outcome === "refused").length;
  const errors = rows.filter((r) => r.outcome === "error").length;
  const withSensitive = opened.filter((r) => r.sensitive.length > 0);

  return (
    <Section
      title="Leak check"
      sub="Reads every module as one approved staff account, exactly as their AI would. Shows field names only, never values."
      right={
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="leakwho" className="sr-only">
            Account
          </label>
          <select id="leakwho" value={who} onChange={(e) => setWho(e.target.value)} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-ink">
            <option value="">Choose an approved staff account…</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name} · {p.position}
              </option>
            ))}
          </select>
          <Button disabled={!who || running} onClick={() => void run()}>
            {running ? "Checking…" : "Run check"}
          </Button>
        </div>
      }
    >
      {err && <p className="px-4 py-3 text-sm text-err sm:px-5">{err}</p>}
      {prog && (
        <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4 sm:px-5">
          {[
            ["Checked", `${prog.done} / ${prog.total}`, ""],
            ["Opened", String(opened.length), "this person may read"],
            ["Refused", String(refused), "no permission (correct)"],
            ["Money / people fields", String(withSensitive.length), "endpoints showing cost, salary, margin…"],
          ].map(([l, v, sub]) => (
            <div key={l} className="rounded-lg border border-border bg-surface-2 p-3">
              <div className="text-xs text-ink-muted">{l}</div>
              <div className="text-xl font-semibold text-ink">{v}</div>
              {sub && <div className="text-[11px] text-ink-muted">{sub}</div>}
            </div>
          ))}
          {errors > 0 && <div className="col-span-full text-xs text-ink-muted">{errors} endpoint(s) answered with an error (usually a required filter is missing). Not a leak.</div>}
        </div>
      )}
      {opened.length > 0 && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[720px] border-collapse">
            <thead className="bg-surface-2">
              <tr>
                <th className={TH}>Endpoint this person can open</th>
                <th className={TH}>Money / people fields in the reply</th>
              </tr>
            </thead>
            <tbody>
              {opened.map((r) => (
                <tr key={r.path} className="border-t border-border">
                  <td className={cn(TD, "font-mono text-[12px]")}>{r.path}</td>
                  <td className={cn(TD, r.sensitive.length ? "font-semibold text-err" : "text-ink-muted")}>{r.sensitive.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AdminView({ ov, reload }: { ov: Overview; reload: () => void }) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {err && (
        <div role="alert" className="rounded-lg border border-err/40 bg-err-bg p-3 text-sm text-err">
          {err}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Waiting for you", ov.stats.waiting],
          ["People connected", ov.stats.connectedPeople],
          ["Lookups (24 h)", ov.stats.callsToday],
          ["Refused (24 h)", ov.stats.refusedToday],
        ].map(([l, v]) => (
          <div key={l} className={cn(CARD, "p-4")}>
            <div className="text-xs text-ink-muted">{l}</div>
            <div className={cn("text-2xl font-semibold", l === "Waiting for you" && Number(v) > 0 ? "text-err" : "text-ink")}>{v}</div>
          </div>
        ))}
      </div>

      <Section title="Waiting for your approval" sub="Staff who pressed Request access.">
        {ov.requests.length === 0 ? (
          <Empty>No one is waiting.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {ov.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div>
                  <div className="font-medium text-ink">{r.name}</div>
                  <div className="text-xs text-ink-muted">
                    {r.position} · asked {when(r.createdAt)}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button disabled={busy !== null} onClick={() => void act(r.id, () => api.post(`/api/mcp-admin/admin/requests/${r.id}/approve`))}>
                    Approve
                  </Button>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void act(r.id, () => api.post(`/api/mcp-admin/admin/requests/${r.id}/reject`))}>
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-5">
          <label htmlFor="grant" className="text-sm text-ink-secondary">
            Turn on for someone:
          </label>
          <select id="grant" value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 min-w-[220px] rounded-lg border border-border bg-surface px-2 text-sm text-ink">
            <option value="">Choose a staff member…</option>
            {ov.staff.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name} · {p.position}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            disabled={!pick || busy !== null}
            onClick={() =>
              void act("grant", async () => {
                await api.post("/api/mcp-admin/admin/access", { userId: Number(pick) });
                setPick("");
              })
            }
          >
            Turn on
          </Button>
        </div>
      </Section>

      <Section title="Connected people" sub="Every AI app connected right now. Disconnect cuts it immediately.">
        {ov.connected.length === 0 ? (
          <Empty>No one is connected yet.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {ov.connected.map((r) => (
              <li key={r.tokenId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div>
                  <div className="font-medium text-ink">
                    {r.name} <span className="text-ink-muted">· {r.app}</span>
                  </div>
                  <div className="text-xs text-ink-muted">
                    {r.position} · connected {when(r.connectedAt)} · last used {when(r.lastUsedAt)}
                  </div>
                </div>
                <Button variant="danger" disabled={busy !== null} onClick={() => void act(r.tokenId, () => api.post("/api/mcp-admin/admin/revoke", { tokenId: r.tokenId }))}>
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Allowed to connect" sub="Remove takes away access and cuts their connections.">
        {ov.allowed.length === 0 ? (
          <Empty>Only admins so far.</Empty>
        ) : (
          <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
            {ov.allowed.map((p) => (
              <span key={p.userId} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1 text-sm text-ink">
                {p.name}
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  disabled={busy !== null}
                  onClick={() => void act(`rm${p.userId}`, () => api.del(`/api/mcp-admin/admin/access/${p.userId}`))}
                  className="rounded-full px-2 py-0.5 text-xs text-err hover:bg-err/10"
                >
                  Remove
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="AI actions"
        sub="Let a connected AI book a meeting, send an email, reply to a Mail Center email or add a service-case note for the person, only after they confirm the summary in their chat. Never orders, money, stock, prices, payroll, approvals or deletes. At most 30 actions per person a day; each one is listed under Recent lookups."
        right={
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={ov.actionsEnabled}
              disabled={busy !== null}
              onChange={(e) => {
                const enabled = e.target.checked;
                void act("actions", () => api.post("/api/mcp-admin/admin/actions", { enabled }));
              }}
            />
            Allow AI actions (meetings, email)
          </label>
        }
      >
        <Empty>{ov.actionsEnabled ? "On: connected AIs may propose meetings and emails; nothing happens until the person confirms." : "Off: connected AIs can only read."}</Empty>
        <div className="space-y-2 border-t border-border px-4 py-3 sm:px-5">
          <p className="text-[13px] text-ink-secondary">More actions, each off until you turn it on. They also need the switch above, and the person still needs the ERP permission for the same action.</p>
          {(
            [
              { kind: "mail_reply", label: "Reply to Mail Center emails", on: ov.actionSwitches?.mailReply === true },
              { kind: "note", label: "Add notes to service cases", on: ov.actionSwitches?.note === true },
            ] as const
          ).map((a) => (
            <label key={a.kind} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={a.on}
                disabled={busy !== null}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  void act(`actions-${a.kind}`, () => api.post("/api/mcp-admin/admin/actions", { kind: a.kind, enabled }));
                }}
              />
              {a.label}
            </label>
          ))}
        </div>
      </Section>

      {ov.limits && (
        <Section title="Limits" sub="Fixed for every person; the admin leak check is not counted.">
          <Empty>
            Each person may make up to {ov.limits.perMinute} AI lookups a minute and {ov.limits.perDay} a day. Over the limit the AI is told to wait a minute (or that the daily limit is reached); nothing breaks.
          </Empty>
        </Section>
      )}

      <LeakCheck people={ov.allowed} />

      <Section title="Questions with no guide yet" sub="How-to, glossary and error questions the AI found no guide for, most asked first. No names are kept.">
        {(ov.noGuide ?? []).length === 0 ? (
          <Empty>None so far.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <th className={TH}>Question</th>
                  <th className={TH}>Tool</th>
                  <th className={TH}>Times</th>
                  <th className={TH}>Last asked</th>
                </tr>
              </thead>
              <tbody>
                {(ov.noGuide ?? []).map((q) => (
                  <tr key={`${q.tool}:${q.question}`} className="border-t border-border">
                    <td className={TD}>{q.question}</td>
                    <td className={cn(TD, "font-mono text-[12px]")}>{q.tool}</td>
                    <td className={TD}>{q.times}</td>
                    <td className={cn(TD, "whitespace-nowrap text-ink-secondary")}>{when(q.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recent lookups" sub="The last 100 things an AI read or did, newest first.">
        {ov.calls.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <th className={TH}>When</th>
                  <th className={TH}>Who</th>
                  <th className={TH}>What</th>
                  <th className={TH}>Result</th>
                </tr>
              </thead>
              <tbody>
                {ov.calls.map((k) => (
                  <tr key={k.id} className="border-t border-border">
                    <td className={cn(TD, "whitespace-nowrap text-ink-secondary")}>{when(k.at)}</td>
                    <td className={TD}>
                      {k.name} <span className="text-ink-muted">· {k.app}</span>
                    </td>
                    <td className={cn(TD, "font-mono text-[12px]")}>
                      {k.tool}
                      {k.target ? ` ${k.target}` : ""}
                    </td>
                    <td className={cn(TD, k.ok ? "text-synced" : "text-err")}>{k.ok ? "OK" : k.note || `Refused (${k.status})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

export function AiConnector() {
  const [me, setMe] = useState<Me | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      try {
        const m = await api.get<Me>("/api/mcp-admin/me", { signal: ctl.signal });
        setMe(m);
        if (m.isAdmin) setOv(await api.get<Overview>("/api/mcp-admin/admin/overview", { signal: ctl.signal }));
      } catch (e) {
        if (!ctl.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctl.abort();
  }, [tick]);

  const request = async () => {
    setRequesting(true);
    try {
      await api.post("/api/mcp-admin/me/request", {});
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white" aria-hidden="true">
            <Bot size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink">AI Connector</h1>
            <p className="text-sm text-ink-secondary">Ask Claude or ChatGPT about the ERP: only what your own login can see. Booking a meeting or sending an email needs your admin's switch and your confirmation.</p>
          </div>
        </div>
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={reload}>
          Refresh
        </Button>
      </div>

      {err && (
        <div role="alert" className="rounded-lg border border-err/40 bg-err-bg p-3 text-sm text-err">
          {err}
        </div>
      )}
      {!me && !err && <p className="text-sm text-ink-muted">Loading…</p>}

      {me && (
        <Section title="Your connector address" sub={me.allowed ? "Paste it into your AI app (steps below)." : "AI Connector is not turned on for you yet."}>
          <div className="px-4 py-3 sm:px-5">
            {me.allowed ? (
              <ConnectorUrl url={me.connectorUrl} />
            ) : me.pendingRequest ? (
              <p className="text-sm text-ink-secondary">Request sent {when(me.pendingRequest.createdAt)}. You will be able to connect once it is approved.</p>
            ) : (
              <Button disabled={requesting} onClick={() => void request()}>
                Request access
              </Button>
            )}
          </div>
        </Section>
      )}

      {me && <BriefEmails key={tick} />}

      {me?.isAdmin && ov && <AdminView ov={ov} reload={reload} />}

      {me && me.apps.length > 0 && (
        <Section title="My connected apps">
          <ul className="divide-y divide-border">
            {me.apps.map((a) => (
              <li key={a.tokenId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div>
                  <div className="font-medium text-ink">{a.app}</div>
                  <div className="text-xs text-ink-muted">
                    connected {when(a.connectedAt)} · last used {when(a.lastUsedAt)}
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() =>
                    void api
                      .post("/api/mcp-admin/me/revoke", { tokenId: a.tokenId })
                      .then(reload)
                      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                  }
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {me?.allowed && <HowTo url={me.connectorUrl} />}
    </div>
  );
}
