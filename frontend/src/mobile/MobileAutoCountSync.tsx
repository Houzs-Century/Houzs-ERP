import { useState } from "react";
import {
  AC_DOC_TYPES,
  AC_FILTER_STATES,
  acAge,
  acHeadline,
  acOpLabel,
  acStateLabel,
  acStateTone,
  useAutoCountOutbox,
  type AcDocType,
  type AcFilterState,
  type AcOutboxRow,
  type AcTone,
} from "../lib/autocountOutbox";
import { fmtDateTime } from "../vendor/shared/format";
import "./mobile.css";

/*
 * MobileAutoCountSync — the phone twin of pages/AutoCountSync.tsx.
 *
 * It reuses the SAME hook (useAutoCountOutbox -> GET /api/scm/autocount-outbox)
 * and the SAME words (acHeadline / acStateLabel / acOpLabel / acAge, all from
 * lib/autocountOutbox), so the two surfaces differ only in presentation — the
 * owner's standing rule. The server decides each row's state, reason and
 * remedy; neither surface classifies anything.
 *
 * The mobile shell has no router and does not keep filters in the URL (unlike
 * the desktop page's useSearchParams), so the state chip, the type and the
 * document search are plain component state, matching every other mobile
 * screen.
 *
 * Read-only, like the desktop page: re-sending a refused document is the
 * re-queue workflow and its includeFailed opt-in, not a button (#2189).
 *
 * English · DD/MM/YYYY · no emoji.
 */

const TONE_COLOR: Record<AcTone, { fg: string; bg: string }> = {
  good: { fg: "var(--green)", bg: "var(--green-bg)" },
  bad: { fg: "var(--red)", bg: "var(--red-bg)" },
  wait: { fg: "var(--amber)", bg: "var(--amber-bg)" },
  muted: { fg: "var(--mut)", bg: "var(--bg)" },
};

const STATE_CHIP: Record<AcFilterState, string> = {
  all: "All",
  attention: "Needs attention",
  pending: "Queued",
  sent: "In AutoCount",
  failed: "Failed",
  skipped: "Skipped",
  requeued: "Re-queued",
};

function StateBadge({ state }: { state: string }) {
  const c = TONE_COLOR[acStateTone(state)];
  return (
    <span
      style={{
        background: c.bg, color: c.fg, fontSize: 10.5, fontWeight: 800,
        borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap",
      }}
    >
      {acStateLabel(state)}
    </span>
  );
}

function OutboxCard({ row, maxAttempts }: { row: AcOutboxRow; maxAttempts: number }) {
  const c = TONE_COLOR[acStateTone(row.state)];
  return (
    <div
      className="card"
      style={{ border: `1px solid ${row.needs_attention ? "#e6cccc" : "var(--line-card)"}` }}
    >
      <div className="card-b" style={{ padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <StateBadge state={row.state} />
          <b style={{ fontSize: 13.5, color: "var(--ink)" }}>{row.doc_no}</b>
          <span style={{ fontSize: 10.5, color: "var(--mut)", border: "1px solid var(--line)", borderRadius: 5, padding: "1px 5px" }}>
            {row.doc_type}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 4 }}>
          {acOpLabel(row.op)}
          {row.ac_doc_no ? ` · AutoCount ${row.ac_doc_no}` : ""}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--mut2)", marginTop: 3 }}>
          Queued {fmtDateTime(row.created_at ?? "")}
          {row.state === "pending" && ` · waiting ${acAge(row.created_at)} · attempt ${row.attempts} of ${maxAttempts}`}
          {row.state === "failed" && ` · gave up after ${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`}
          {row.sent_at ? ` · sent ${fmtDateTime(row.sent_at)}` : ""}
        </div>

        {/* WHOLE, never clipped — the tail of an AutoCount foreign-key message
            is routinely the half that names the column. */}
        {row.reason && (
          <div
            style={{
              marginTop: 8, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap",
              wordBreak: "break-word", borderRadius: 9, padding: "8px 10px",
              background: acStateTone(row.state) === "bad" ? "var(--red-bg)" : "var(--bg)",
              color: acStateTone(row.state) === "bad" ? c.fg : "var(--ink2)",
              border: "1px solid var(--line)",
            }}
          >
            {row.reason}
          </div>
        )}
        {row.remedy && (
          <div style={{ marginTop: 7, fontSize: 11.5, color: "var(--ink2)" }}>
            <b>What to do: </b>{row.remedy}
          </div>
        )}
        {row.reason_kind === "unrecognised" && (
          <div style={{ marginTop: 7, fontSize: 11, color: "var(--amber)" }}>
            This refusal has no named remedy yet. The message above is exactly what the ERP
            wrote down.
          </div>
        )}
        {row.state === "requeued" && (
          <div style={{ marginTop: 7, fontSize: 11, color: "var(--mut)" }}>
            Already asked again — the record of the original refusal, not an open item.
          </div>
        )}
      </div>
    </div>
  );
}

export function MobileAutoCountSync({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<AcFilterState>("all");
  const [docType, setDocType] = useState<AcDocType | "">("");
  const [docNo, setDocNo] = useState("");

  const q = useAutoCountOutbox({ state, docType, docNo });
  const d = q.data;
  const headline = acHeadline(d);
  const maxAttempts = d?.meta.max_attempts ?? 6;
  const tile = (label: string, n: number, tone: AcTone) => (
    <div
      key={label}
      style={{
        flex: "1 1 30%", minWidth: 92, background: "var(--card)", border: "1px solid var(--line-card)",
        borderRadius: 11, padding: "9px 10px",
      }}
    >
      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--mut)" }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: n > 0 ? TONE_COLOR[tone].fg : "var(--ink)", marginTop: 2 }}>
        {n}
      </div>
    </div>
  );

  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">‹</span> Back
            </button>
            <div className="eyebrow">System</div>
            <div className="scr-title">AutoCount Sync</div>
          </div>
        </div>
        <div className="chips" style={{ marginTop: 11 }}>
          {AC_FILTER_STATES.map((s) => (
            <button key={s} onClick={() => setState(s)} className={state === s ? "chip on" : "chip"}>
              {STATE_CHIP[s]}
            </button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {/* THE ANSWER FIRST — the same sentence the desktop page shows. */}
        <div
          style={{
            fontSize: 12, fontWeight: 700, lineHeight: 1.45, borderRadius: 11, padding: "10px 12px",
            marginBottom: 11, color: TONE_COLOR[headline.tone].fg, background: TONE_COLOR[headline.tone].bg,
            border: "1px solid var(--line)",
          }}
        >
          {headline.text}
        </div>

        {/* A failure that reaches nobody is worse than a crash — a page built
            because something went unseen must state its own load error. */}
        {q.error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px", marginBottom: 11 }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>
              The queue could not be read: {q.error}
            </span>
            <button
              onClick={() => q.reload()}
              style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
            >
              Retry
            </button>
          </div>
        )}

        {!d && q.loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b ph" style={{ height: 96, borderRadius: 14 }} /></div>
            ))}
          </div>
        )}

        {d && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 11 }}>
              {tile("Failed", d.counts.failed, "bad")}
              {tile("Skipped", d.counts.skipped, "bad")}
              {tile("Queued", d.counts.pending, "wait")}
              {tile("In AutoCount", d.counts.sent, "good")}
              {tile("Re-queued", d.counts.requeued, "muted")}
            </div>

            <div style={{ fontSize: 10.5, color: "var(--mut)", background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
              Write-back switch:{" "}
              <b style={{ color: d.writeback.on ? "var(--green)" : "var(--mut)" }}>
                {d.writeback.on ? `ON for ${d.writeback.scope === "all" ? "every company" : `company ${d.writeback.scope}`}` : "OFF"}
              </b>
              {" "}(scm.autocount_writeback = {d.writeback.value === null ? "row absent" : JSON.stringify(d.writeback.value)}).
              A queued document is sent every 5 minutes and gives up after {maxAttempts} attempts.
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 11 }}>
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value as AcDocType | "")}
                style={{ flex: "0 0 auto", fontFamily: "inherit", fontSize: 12, borderRadius: 9, border: "1px solid var(--line)", padding: "7px 9px", background: "var(--card)", color: "var(--ink)" }}
              >
                <option value="">All types</option>
                {AC_DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input
                value={docNo}
                onChange={(e) => setDocNo(e.target.value)}
                placeholder="Document no."
                style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 12, borderRadius: 9, border: "1px solid var(--line)", padding: "7px 9px", background: "var(--card)", color: "var(--ink)" }}
              />
            </div>

            {d.truncated && (
              <div style={{ fontSize: 11, color: "var(--amber)", background: "var(--amber-bg)", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
                Only the most recent rows are shown. The counts above still cover every row.
              </div>
            )}

            {d.rows.length === 0 ? (
              <div style={{ textAlign: "center", padding: "34px 12px", fontSize: 12, color: "var(--mut)" }}>
                {d.counts.total === 0
                  ? "Nothing has ever been queued for AutoCount in this company."
                  : "No document matches these filters."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                {d.rows.map((r) => <OutboxCard key={r.id} row={r} maxAttempts={maxAttempts} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default MobileAutoCountSync;
