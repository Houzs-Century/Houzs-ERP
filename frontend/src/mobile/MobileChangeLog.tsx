// ---------------------------------------------------------------------------
// Change Log, on a phone. The twin of pages/ChangeLog.tsx.
//
// It renders the SAME hook, the SAME words and the SAME verdicts out of
// lib/changeLog.ts, and differs only in presentation — cards instead of a
// table, because a table does not fit 375 px. The owner's standing rule is that
// the two surfaces are one product (「電話電腦的權限應該一樣的」), and a rule fixed on
// one surface and not the other is a recurring bug class in this repo.
//
// Filters are component state rather than the URL: the mobile shell has no
// router, and every other mobile filter is held the same way. The DEFAULTS come
// from the shared layer, so both surfaces open on the same view.
// ---------------------------------------------------------------------------
import { useState } from "react";

import {
  CL_DEFAULT_FILTERS,
  CL_DOC_TYPE_LABEL,
  CL_DOC_TYPES,
  CL_WINDOWS,
  clActionLabel,
  clFieldLabel,
  clMyt,
  clTruncationNote,
  clValueLabel,
  clVerdict,
  clWhoLabel,
  useChangeLog,
  type ChangeLogAuthorFilter,
  type ChangeLogDocType,
  type ChangeLogDocument,
} from "../lib/changeLog";

const AUTHORS: Array<{ value: ChangeLogAuthorFilter; label: string }> = [
  { value: "person", label: "People" },
  { value: "machine", label: "The system" },
  { value: "all", label: "Both" },
];


function DocumentCard({ doc }: { doc: ChangeLogDocument }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, background: "var(--card)", marginBottom: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "block", width: "100%", textAlign: "left", background: "none",
          border: 0, padding: "10px 11px", color: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, fontSize: 13 }}>{doc.docNo}</span>
          <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--mut)" }}>
            {CL_DOC_TYPE_LABEL[doc.docType]}
          </span>
        </div>
        <div style={{ marginTop: 3, fontSize: 12 }}>
          {/* A document only the system touched says so, rather than showing an
              empty name that reads as a change nobody can account for. */}
          {doc.people.length > 0 ? doc.people.join(", ") : "The system only"}
        </div>
        <div style={{ marginTop: 2, fontSize: 11, color: "var(--mut)" }}>
          {doc.changeCount} change{doc.changeCount === 1 ? "" : "s"} · last {clMyt(doc.lastChangeAt)}
        </div>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "9px 11px" }}>
          {doc.changes.map((ch) => (
            <div key={ch.id} style={{ marginBottom: 10, fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>
                {clActionLabel(ch.action)} by {clWhoLabel(ch)}
                {ch.author === "machine" ? " (automatic)" : ""}
              </div>
              <div style={{ color: "var(--mut)", fontSize: 11 }}>
                {clMyt(ch.at)}
                {ch.source ? ` · via ${ch.source}` : ""}
              </div>
              {ch.fields.length === 0 ? (
                <div style={{ color: "var(--mut)", marginTop: 3 }}>
                  No field-by-field detail was recorded for this change.
                </div>
              ) : (
                <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                  {ch.fields.map((f, i) => (
                    <li key={`${ch.id}-${f.field}-${i}`} style={{ marginBottom: 2 }}>
                      <span style={{ color: "var(--mut)" }}>{clFieldLabel(f.field)}: </span>
                      <span style={{ textDecoration: "line-through" }}>{clValueLabel(f.from)}</span>
                      {" -> "}
                      <span style={{ fontWeight: 600 }}>{clValueLabel(f.to)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MobileChangeLog({ onBack }: { onBack: () => void }) {
  const [hours, setHours] = useState(CL_DEFAULT_FILTERS.hours);
  const [author, setAuthor] = useState<ChangeLogAuthorFilter>(CL_DEFAULT_FILTERS.author);
  const [docType, setDocType] = useState<ChangeLogDocType | "all">(CL_DEFAULT_FILTERS.docType);

  const q = useChangeLog({ hours, author, docType });
  const d = q.data;
  const truncation = clTruncationNote(d ?? null);

  return (
    <div
      className="hz-m"
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}
    >
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">‹</span> Back
            </button>
            <div className="eyebrow">System</div>
            <div className="scr-title">Change Log</div>
          </div>
        </div>

        {/* The same three strips the desktop page shows, in the same order. */}
        <div className="chips" style={{ marginTop: 11 }}>
          {CL_WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setHours(w.hours)}
              className={hours === w.hours ? "chip on" : "chip"}
              aria-pressed={hours === w.hours}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="chips" style={{ marginTop: 7 }}>
          {AUTHORS.map((a) => (
            <button
              key={a.value}
              onClick={() => setAuthor(a.value)}
              className={author === a.value ? "chip on" : "chip"}
              aria-pressed={author === a.value}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="chips" style={{ marginTop: 7 }}>
          <button
            onClick={() => setDocType("all")}
            className={docType === "all" ? "chip on" : "chip"}
            aria-pressed={docType === "all"}
          >
            Every type
          </button>
          {CL_DOC_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setDocType(t)}
              className={docType === t ? "chip on" : "chip"}
              aria-pressed={docType === t}
            >
              {CL_DOC_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 40 }}>
        {/* THE ANSWER FIRST — the same sentence the desktop page shows. */}
        <div
          style={{
            border: "1px solid var(--line)", borderRadius: 10, padding: 11,
            fontSize: 12, fontWeight: 600, marginBottom: 12, background: "var(--card)",
          }}
        >
          {d ? clVerdict(d) : "Reading the change log..."}
        </div>

        {/* A refusal or a failure reaches the reader here too. */}
        {q.error && (
          <div
            style={{
              border: "1px solid var(--danger, #b91c1c)", borderRadius: 10,
              padding: 11, fontSize: 12, marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700 }}>The change log could not be read, so nothing below is complete.</div>
            <div style={{ marginTop: 4, fontFamily: "ui-monospace, monospace", fontSize: 11, wordBreak: "break-word" }}>
              {q.error}
            </div>
          </div>
        )}

        {truncation && (
          <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 11, fontSize: 11, marginBottom: 12 }}>
            {truncation}
          </div>
        )}

        {!d && q.loading ? (
          <div style={{ fontSize: 12, color: "var(--mut)" }}>Loading...</div>
        ) : (
          d && (
            <>
              {d.documents.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--mut)" }}>
                  {author === "person"
                    ? "No person changed a document in this period. The system's own automatic changes are under The system."
                    : "Nothing was changed in this period."}
                </p>
              ) : (
                <>
                  {d.documents.map((doc) => (
                    <DocumentCard key={`${doc.docType}|${doc.docNo}`} doc={doc} />
                  ))}
                  <p style={{ fontSize: 11, color: "var(--mut)" }}>
                    {d.totals.documentsShown} of {d.totals.documents} document(s) on screen.
                  </p>
                </>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}

export default MobileChangeLog;
