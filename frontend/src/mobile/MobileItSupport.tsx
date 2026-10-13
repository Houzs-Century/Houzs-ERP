import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { LifeBuoy, Paperclip } from "lucide-react";
import { api } from "../api/client";
import { formatDateTime, relativeTime } from "../lib/utils";
import {
  IT_ACCEPT, IT_KINDS, IT_MAX_FILES, IT_URGENCY, itAddFiles, itFresh, itMessage, itStatusText, itStatusTone, itStepLine,
  type ItDetail, type ItFileRef, type ItRequestRow, type ItTone,
} from "../lib/itSupport";

/**
 * IT Support on a phone: the same requests, states and rules as the desktop
 * page (pages/ItSupport.tsx, shared logic in lib/itSupport.ts), laid out as one
 * mobile screen with three views: my requests, report a problem, one request.
 * Who is asking comes from the session on the server, never from this screen.
 */

const TONE_CLASS: Record<ItTone, string> = {
  neutral: "b-grey", accent: "b-brand", success: "b-green", warning: "b-amber", error: "b-red",
};
const TEXTAREA = { resize: "vertical" as const, minHeight: 96, padding: "9px 10px", fontSize: 14 };
const INPUT = { padding: "10px 10px", fontSize: 14 };
const ALERT = { border: "1px solid var(--red, #b23a3a)", borderRadius: 10, padding: 11, fontSize: 12.5, marginTop: 10 };

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${TONE_CLASS[itStatusTone(status)]}`}>{itStatusText(status)}</span>;
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input ref={input} type="file" multiple accept={IT_ACCEPT} style={{ display: "none" }}
        onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <Paperclip size={14} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
          <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))}
            style={{ background: "none", border: "none", color: "var(--brand)", fontWeight: 700, fontSize: 13, padding: 6 }}>
            Remove
          </button>
        </div>
      ))}
      {files.length < IT_MAX_FILES && (
        <button type="button" className="btn-ghost" onClick={() => input.current?.click()}>
          <Paperclip size={16} /> Add a screenshot or file
        </button>
      )}
      <div style={{ fontSize: 11.5, color: "var(--mut2)" }}>Pictures, MP4 or MOV video, or PDF. Up to 5 files, 10 MB each.</div>
      {refused && <div role="alert" style={{ fontSize: 12.5, color: "var(--red)" }}>{refused}</div>}
    </div>
  );
}

function NewRequest({ onSent }: { onSent: (code: string) => void }) {
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
    for (const f of files) form.append("files", f, f.name);
    try {
      const r = await api.postForm<{ code: string }>("/api/it-support/tickets", form);
      onSent(r.code);
    } catch (err) {
      setError(itMessage(err, "That was not sent. Please try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label className="fld">
        <span className="fld-l">What is the problem?</span>
        <input className="fld-i" style={INPUT} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)}
          placeholder="The delivery order will not save" />
      </label>
      <label className="fld">
        <span className="fld-l">Details</span>
        <textarea className="fld-i" style={TEXTAREA} value={description} maxLength={10000} rows={5}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What you did, what you expected, and what happened instead." />
      </label>
      <label className="fld">
        <span className="fld-l">Kind of request</span>
        <select className="fld-i" style={INPUT} value={kind} onChange={(e) => setKind(e.target.value)}>
          {IT_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="fld">
        <span className="fld-l">How urgent</span>
        <select className="fld-i" style={INPUT} value={urgency} onChange={(e) => setUrgency(e.target.value)}>
          {IT_URGENCY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <div className="fld">
        <span className="fld-l">Screenshots</span>
        <Files files={files} onChange={setFiles} />
      </div>
      {error && <div role="alert" style={ALERT}>{error}</div>}
      <button type="submit" className="btn" disabled={busy}>{busy ? "Sending..." : "Send"}</button>
    </form>
  );
}

function OneRequest({ code }: { code: string }) {
  const [detail, setDetail] = useState<ItDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<"" | "reply" | "confirm" | "file">("");
  const [error, setError] = useState<string | null>(null);
  const path = `/api/it-support/tickets/${encodeURIComponent(code)}`;

  const load = useCallback(async () => {
    try {
      setDetail(await itFresh<ItDetail>(path));
      setLoadError(null);
    } catch (err) {
      setLoadError(itMessage(err, "This IT request could not be opened."));
    }
  }, [path]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!detail) {
    return loadError ? (
      <div className="empty">
        <div className="empty-t">We couldn't open this IT request.</div>
        <div className="empty-s">{loadError}</div>
        <button type="button" className="btn-ghost" style={{ marginTop: 14 }} onClick={() => void load()}>Retry</button>
      </div>
    ) : (
      <div style={{ fontSize: 12.5, color: "var(--mut)" }}>Loading...</div>
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
      setError(itMessage(err, "Your reply was not sent. Please try again in a moment."));
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
      setError(itMessage(err, "That was not saved. Please try again in a moment."));
    } finally {
      setBusy("");
    }
  };
  /* The download needs the Authorization header, which a plain link cannot send. */
  const openFile = async (a: ItFileRef) => {
    if (busy) return;
    setError(null);
    setBusy("file");
    try {
      const url = await api.fetchBlobUrl(`/api/it-support/attachments/${a.id}`, a.mime);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(itMessage(err, "That file could not be opened."));
    } finally {
      setBusy("");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {loadError && <div role="alert" style={ALERT}>Showing what was last loaded. {loadError}</div>}
      <div className="card card-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 700 }}>{t.code}</span>
          <StatusBadge status={t.status} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, overflowWrap: "anywhere" }}>{t.title}</div>
        <div style={{ fontSize: 12, color: "var(--mut)" }}>{t.assignee_name ? `Handled by ${t.assignee_name}` : "Not picked up yet"}</div>
        {t.description && <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.description}</div>}
        {t.status === "resolved" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--line2)", paddingTop: 10 }}>
            <div style={{ fontSize: 13 }}>IT has marked this as done. If it is fixed, confirm to close it. If not, reply below and it goes back to IT.</div>
            <button type="button" className="btn" disabled={busy !== ""} onClick={() => void confirmFixed()}>
              {busy === "confirm" ? "Closing..." : "Yes, it is fixed"}
            </button>
          </div>
        )}
      </div>

      <div className="card card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {detail.events.map((s) => (
          <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 13 }}>
              <b>{s.author_kind === "reporter" ? "You" : s.author_name}</b>{" "}
              <span style={{ color: "var(--mut)" }}>{itStepLine(s)}</span>{" "}
              <span style={{ fontSize: 11, color: "var(--mut2)" }} title={formatDateTime(s.created_at)}>{relativeTime(s.created_at)}</span>
            </div>
            {s.body && (
              <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--bg)", borderRadius: 10, padding: "9px 11px" }}>
                {s.body}
              </div>
            )}
            {s.attachments.map((a) => (
              <button key={a.id} type="button" onClick={() => void openFile(a)}
                style={{ display: "flex", alignItems: "center", gap: 7, background: "none", border: "1px solid var(--line)", borderRadius: 10, padding: "9px 11px", fontSize: 13, textAlign: "left", color: "var(--ink)" }}>
                <Paperclip size={14} /> <span style={{ overflowWrap: "anywhere" }}>{a.filename}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {closed ? (
        <div className="card card-b" style={{ fontSize: 13, color: "var(--mut)" }}>This request is closed. If the problem is back, report it again.</div>
      ) : (
        <form onSubmit={send} className="card card-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <textarea className="fld-i" style={TEXTAREA} value={reply} maxLength={10000} rows={3} aria-label="Reply to IT"
            placeholder="Reply to IT" onChange={(e) => setReply(e.target.value)} />
          <Files files={files} onChange={setFiles} />
          <button type="submit" className="btn" disabled={busy !== ""}>{busy === "reply" ? "Sending..." : "Send reply"}</button>
        </form>
      )}
      {error && <div role="alert" style={ALERT}>{error}</div>}
    </div>
  );
}

function RequestList({ onOpen }: { onOpen: (code: string) => void }) {
  const [rows, setRows] = useState<ItRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await itFresh<{ tickets: ItRequestRow[] }>("/api/it-support/tickets")).tickets);
      setError(null);
    } catch (err) {
      setError(itMessage(err, "Your IT requests could not load."));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!rows) {
    return error ? (
      <div className="empty">
        <div className="empty-t">We couldn't load your IT requests.</div>
        <div className="empty-s">{error}</div>
        <button type="button" className="btn-ghost" style={{ marginTop: 14 }} onClick={() => void load()}>Retry</button>
      </div>
    ) : (
      <div style={{ fontSize: 12.5, color: "var(--mut)" }}>Loading...</div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="empty">
        <LifeBuoy size={28} />
        <div className="empty-t">Nothing sent to IT yet.</div>
        <div className="empty-s">When something in the system is not working, or you need a change, report it here. IT replies on this screen.</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <div role="alert" style={ALERT}>Showing what was last loaded. {error}</div>}
      {rows.map((r) => (
        <button key={r.code} type="button" className="card card-b" onClick={() => onOpen(r.code)}
          style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "left", width: "100%", cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: "var(--mut)" }}>{r.code}</span>
            {r.unread && <span className="badge b-brand">New reply</span>}
            <span style={{ marginLeft: "auto" }}><StatusBadge status={r.status} /></span>
          </div>
          <div style={{ fontSize: 14, fontWeight: r.unread ? 800 : 600, color: "var(--ink)", overflowWrap: "anywhere" }}>{r.title}</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--mut2)", width: "100%" }}>
            <span>{r.assignee_name ?? "Not picked up yet"}</span>
            <span title={formatDateTime(r.updated_at)}>{relativeTime(r.updated_at)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

type View = { v: "list" } | { v: "new" } | { v: "one"; code: string };

export function MobileItSupport({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View>({ v: "list" });
  const toList = () => setView({ v: "list" });

  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={view.v === "list" ? onBack : toList} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">‹</span> {view.v === "list" ? "Back" : "All my requests"}
            </button>
            <div className="eyebrow">System</div>
            <div className="scr-title">{view.v === "new" ? "Report a problem" : view.v === "one" ? "IT request" : "IT Support"}</div>
          </div>
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {view.v === "new" ? (
          <NewRequest onSent={(code) => setView({ v: "one", code })} />
        ) : view.v === "one" ? (
          <OneRequest key={view.code} code={view.code} />
        ) : (
          <RequestList onOpen={(code) => setView({ v: "one", code })} />
        )}
      </div>

      {view.v === "list" && (
        <footer className="actbar">
          <button type="button" className="btn" onClick={() => setView({ v: "new" })}>Report a problem</button>
        </footer>
      )}
    </div>
  );
}

export default MobileItSupport;
