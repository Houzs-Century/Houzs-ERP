import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowLeft, LifeBuoy, Paperclip, Plus, RotateCcw } from "lucide-react";
import { api } from "../api/client";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { formatDateTime, relativeTime } from "../lib/utils";
import {
  IT_ACCEPT as ACCEPT, IT_KINDS as KINDS, IT_MAX_FILES as MAX_FILES, IT_URGENCY as URGENCY,
  itAddFiles, itFresh as fresh, itMessage as message, itStatusText as statusText, itStatusTone as statusTone,
  itStepLine as stepLine, type ItDetail as Detail, type ItFileRef as FileRef, type ItRequestRow as RequestRow,
} from "../lib/itSupport";

/**
 * IT Support — report a problem with the system to IT, follow it, reply, and
 * confirm the fix. Every signed-in user has it and sees only their own
 * requests: the server reads WHO from the session (backend routes/itSupport.ts),
 * so there is no "whose requests?" control here to get wrong. The requests
 * themselves live in the Houzs IT Hub, not in this database.
 *
 * One page, three views, chosen by the URL so a link can open any of them:
 * the list, `?new=1` (with `&from=<path>` naming the page the problem is on),
 * and `?request=HC-0001`.
 *
 * A list we FAILED to load is not an empty list — the same rule the
 * Notifications page keeps. "Nothing sent yet" is drawn only when the server
 * actually answered with nothing.
 */

const CONTROL =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none";
const LABEL = "text-[11.5px] font-semibold text-ink-secondary";

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)} size="sm" caseless>{statusText(status)}</Badge>;
}

function Files({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const add = (list: FileList | null) => {
    const r = itAddFiles(files, list);
    if ("refused" in r) return setRefused(r.refused);
    setRefused(null);
    onChange(r.files);
  };
  return (
    <div className="flex flex-col gap-2">
      <input ref={input} type="file" multiple accept={ACCEPT} className="hidden"
        onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <Paperclip size={13} />
          <span className="min-w-0 truncate">{f.name}</span>
          <button type="button" className="text-[11.5px] font-semibold text-primary hover:underline"
            onClick={() => onChange(files.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      {files.length < MAX_FILES && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" icon={<Paperclip size={14} />} onClick={() => input.current?.click()}>
            Add a screenshot or file
          </Button>
          <span className="text-[11.5px] text-ink-muted">Pictures, MP4 or MOV video, or PDF. Up to 5 files, 10 MB each.</span>
        </div>
      )}
      {refused && <p className="text-[12px] text-err" role="alert">{refused}</p>}
    </div>
  );
}

function NewRequest({ from, onSent, onCancel }: { from: string; onSent: (code: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState("bug");
  const [urgency, setUrgency] = useState("medium");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) return setError("Say in a few words what the problem is.");
    setError(null);
    setBusy(true);
    const form = new FormData();
    form.set("title", title.trim());
    form.set("description", description.trim());
    form.set("type", kind);
    form.set("priority", urgency);
    if (from) form.set("page_url", from);
    for (const f of files) form.append("files", f, f.name);
    try {
      const r = await api.postForm<{ code: string }>("/api/it-support/tickets", form);
      onSent(r.code);
    } catch (err) {
      setError(message(err, "That was not sent. Please try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-stone">
      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>What is the problem?</span>
        <input className={CONTROL} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)}
          placeholder="The delivery order will not save" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>Details</span>
        <textarea className={`${CONTROL} min-h-32 resize-y`} value={description} maxLength={10000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What you did, what you expected, and what happened instead." />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Kind of request</span>
          <select className={CONTROL} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>How urgent</span>
          <select className={CONTROL} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            {URGENCY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Screenshots</span>
        <Files files={files} onChange={setFiles} />
      </div>
      {error && <p className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-ink" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send to IT"}</Button>
      </div>
    </form>
  );
}

function OneRequest({ code }: { code: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<"" | "reply" | "confirm" | "file">("");
  const [error, setError] = useState<string | null>(null);
  const path = `/api/it-support/tickets/${encodeURIComponent(code)}`;

  const load = useCallback(async () => {
    try {
      setDetail(await fresh<Detail>(path));
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err, "This IT request could not be opened."));
    }
  }, [path]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!detail) {
    return loadError ? (
      <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-10 text-center shadow-stone">
        <p className="text-[12.5px] font-semibold text-ink">We couldn't open this IT request.</p>
        <p className="mt-1 text-[11.5px] text-ink-muted">{loadError}</p>
        <Button className="mt-3" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => void load()}>Retry</Button>
      </div>
    ) : (
      <div className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-[12px] text-ink-muted shadow-stone">Loading…</div>
    );
  }

  const t = detail.ticket;
  const closed = t.status === "closed" || t.status === "rejected";

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!reply.trim() && files.length === 0) return setError("Write a reply or attach a file.");
    setError(null);
    setBusy("reply");
    const form = new FormData();
    if (reply.trim()) form.set("body", reply.trim());
    for (const f of files) form.append("files", f, f.name);
    try {
      await api.postForm(`${path}/replies`, form);
      setReply("");
      setFiles([]);
      await load();
    } catch (err) {
      setError(message(err, "Your reply was not sent. Please try again in a moment."));
    } finally {
      setBusy("");
    }
  };
  const confirmFixed = async () => {
    if (busy) return;
    setError(null);
    setBusy("confirm");
    try {
      await api.post(`${path}/confirm`);
      await load();
    } catch (err) {
      setError(message(err, "That was not saved. Please try again in a moment."));
    } finally {
      setBusy("");
    }
  };
  /* The download needs the Authorization header, which a plain link cannot send. */
  const openFile = async (a: FileRef) => {
    if (busy) return;
    setError(null);
    setBusy("file");
    try {
      const url = await api.fetchBlobUrl(`/api/it-support/attachments/${a.id}`, a.mime);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(message(err, "That file could not be opened."));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      {loadError && (
        <p className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-ink" role="alert">
          Showing what was last loaded. {loadError}
        </p>
      )}
      <section className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4 shadow-stone">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px] font-semibold text-ink">{t.code}</span>
          <StatusBadge status={t.status} />
          <span className="text-[11.5px] text-ink-muted">
            {t.assignee_name ? `Handled by ${t.assignee_name}` : "Not picked up yet"}
          </span>
        </div>
        <h2 className="text-[15px] font-bold text-ink [overflow-wrap:anywhere]">{t.title}</h2>
        {t.description && <p className="whitespace-pre-wrap text-[12.5px] text-ink-secondary [overflow-wrap:anywhere]">{t.description}</p>}
        {t.status === "resolved" && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg/40 px-3 py-2.5">
            <span className="min-w-[220px] flex-1 text-[12.5px] text-ink">
              IT has marked this as done. If it is fixed, confirm to close it. If not, reply below and it goes back to IT.
            </span>
            <Button onClick={() => void confirmFixed()} disabled={busy !== ""}>
              {busy === "confirm" ? "Closing…" : "Yes, it is fixed"}
            </Button>
          </div>
        )}
      </section>

      <ul className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-stone">
        {detail.events.map((s) => (
          <li key={s.id} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[12.5px] font-semibold text-ink">{s.author_kind === "reporter" ? "You" : s.author_name}</span>
              <span className="text-[12px] text-ink-secondary">{stepLine(s)}</span>
              <span className="font-mono text-[9.5px] text-ink-muted" title={formatDateTime(s.created_at)}>{relativeTime(s.created_at)}</span>
            </div>
            {s.body && (
              <p className="whitespace-pre-wrap rounded-md border border-border bg-bg/40 px-3 py-2 text-[12.5px] text-ink [overflow-wrap:anywhere]">{s.body}</p>
            )}
            {s.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {s.attachments.map((a) => (
                  <button key={a.id} type="button" onClick={() => void openFile(a)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] text-ink-secondary hover:border-accent/40 hover:text-ink">
                    <Paperclip size={12} /> {a.filename}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {closed ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-3 text-[12.5px] text-ink-muted shadow-stone">
          This request is closed. If the problem is back, report it again.
        </p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-stone">
          <textarea className={`${CONTROL} min-h-24 resize-y`} value={reply} maxLength={10000} aria-label="Reply to IT"
            placeholder="Reply to IT" onChange={(e) => setReply(e.target.value)} />
          <Files files={files} onChange={setFiles} />
          <div className="flex justify-end">
            <Button type="submit" disabled={busy !== ""}>{busy === "reply" ? "Sending…" : "Send reply"}</Button>
          </div>
        </form>
      )}
      {error && <p className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-ink" role="alert">{error}</p>}
    </>
  );
}

function RequestList({ onOpen, onNew }: { onOpen: (code: string) => void; onNew: () => void }) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await fresh<{ tickets: RequestRow[] }>("/api/it-support/tickets")).tickets);
      setError(null);
    } catch (err) {
      setError(message(err, "Your IT requests could not load."));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!rows) {
    return error ? (
      <div className="rounded-lg border border-err/30 bg-err/5 px-4 py-12 text-center shadow-stone">
        <p className="text-[12.5px] font-semibold text-ink">We couldn't load your IT requests.</p>
        <p className="mt-1 text-[11.5px] text-ink-muted">{error}</p>
        <Button className="mt-3" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => void load()}>Retry</Button>
      </div>
    ) : (
      <div className="rounded-lg border border-border bg-surface px-4 py-12 text-center text-[12px] text-ink-muted shadow-stone">Loading…</div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-4 py-12 text-center shadow-stone">
        <p className="text-[12.5px] font-semibold text-ink">Nothing sent to IT yet.</p>
        <p className="mt-1 text-[11.5px] text-ink-muted">
          When something in the system is not working, or you need a change, report it here. IT replies on this page.
        </p>
        <Button className="mt-3" icon={<Plus size={14} />} onClick={onNew}>Report a problem</Button>
      </div>
    );
  }
  return (
    <>
      {error && (
        <p className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-ink" role="alert">
          Showing what was last loaded. {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.code}>
            <button type="button" onClick={() => onOpen(r.code)}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2.5 text-left shadow-stone transition-colors hover:border-accent/40 hover:bg-bg/40">
              <span className="w-[76px] shrink-0 font-mono text-[11px] text-ink-muted">{r.code}</span>
              <span className={`min-w-[180px] flex-1 text-[12.5px] text-ink [overflow-wrap:anywhere] ${r.unread ? "font-bold" : ""}`}>{r.title}</span>
              {r.unread && <Badge tone="accent" variant="solid" size="sm" caseless>New reply</Badge>}
              <StatusBadge status={r.status} />
              <span className="w-[130px] shrink-0 truncate text-[11.5px] text-ink-muted">{r.assignee_name ?? "Not picked up yet"}</span>
              <span className="w-[70px] shrink-0 text-right font-mono text-[9.5px] text-ink-muted" title={formatDateTime(r.updated_at)}>{relativeTime(r.updated_at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ItSupport() {
  const [params, setParams] = useSearchParams();
  const code = params.get("request") ?? "";
  const isNew = params.get("new") === "1";
  const go = (next: Record<string, string>) => setParams(next);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-accent-soft/60 text-accent">
            <LifeBuoy size={17} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="font-display text-[18px] font-extrabold leading-tight text-ink">
              {isNew ? "Report a problem" : code ? "IT request" : "IT Support"}
            </h1>
            <p className="text-[11.5px] text-ink-muted">
              {isNew ? "Goes straight to IT. Their reply appears on this page."
                : code ? "What IT has said, and your replies."
                  : "Report a problem with the system or ask for a change, and follow what IT is doing about it."}
            </p>
          </div>
        </div>
        {isNew || code ? (
          <Button variant="secondary" icon={<ArrowLeft size={14} />} onClick={() => go({})}>All my requests</Button>
        ) : (
          <Button icon={<Plus size={14} />} onClick={() => go({ new: "1" })}>Report a problem</Button>
        )}
      </header>

      {isNew ? (
        <NewRequest from={params.get("from") ?? ""} onCancel={() => go({})} onSent={(c) => go({ request: c })} />
      ) : code ? (
        <OneRequest key={code} code={code} />
      ) : (
        <RequestList onOpen={(c) => go({ request: c })} onNew={() => go({ new: "1" })} />
      )}
    </div>
  );
}
