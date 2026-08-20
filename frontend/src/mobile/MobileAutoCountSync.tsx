import { useCallback, useState } from "react";
import {
  AC_COUNTS_PARTIAL_LINE,
  AC_DEFAULT_STATE,
  AC_DOC_TYPES,
  AC_EARLIER_SENDS_NOTE,
  AC_FILTER_STATES,
  AC_FILTER_STATE_LABEL,
  AC_LOAD_FAILED_LINE,
  AC_NOT_ASKED_NOTE,
  AC_ONLY_REPLACED_LINE,
  AC_REPLACED_GROUP_NOTE,
  AC_REPLACED_NOTE,
  AC_SEND_AGAIN_BUSY_LABEL,
  AC_SEND_NOW_LABEL,
  AC_SEND_NOW_BUSY_LABEL,
  AC_SEND_AGAIN_LABEL,
  AC_STATE_PLAIN_MEANING,
  AC_TECHNICAL_LABEL,
  acAge,
  acDocTypePlural,
  acDocTypeCounts,
  acEarlierSendsHeading,
  acEmptyLine,
  acGroupByDocument,
  acGroupsOfType,
  acHeadline,
  acListCountLine,
  acListTitle,
  acReplacedHeading,
  acRowDetail,
  acRowStandsAt,
  acSplitReplaced,
  acStateCount,
  acStateLabel,
  acStateTone,
  acWritebackLine,
  useAcExpandedRows,
  useAcReplacedGroup,
  useAcRequeue,
  useAcSendHistory,
  useAutoCountOutbox,
  type AcDocGroup,
  type AcDocType,
  type AcFilterState,
  type AcOutboxRow,
  type AcRequeueNote,
  type AcSaid,
  type AcTone,
} from "../lib/autocountOutbox";
import { MobileVirtualList } from "./MobileVirtualList";
import "./mobile.css";

/*
 * MobileAutoCountSync — the phone twin of pages/AutoCountSync.tsx.
 *
 * It reuses the SAME hook (useAutoCountOutbox -> GET /api/scm/autocount-outbox)
 * and the SAME words — the state labels, the type labels, the reason headline,
 * the "AutoCount replied" / "AutoCount was not asked" distinction, all from
 * lib/autocountOutbox — so the two surfaces differ only in presentation, the
 * owner's standing rule.
 *
 * SIMPLIFIED 2026-08-16 alongside the desktop page, and for his complaint about
 * it: "一个 sales order 那么宽，那如果我有一千个 sales order 的时候，我不是完蛋？"
 * A card is now the document and where it stands; the reason is one headline
 * line that opens the rest; a document already in the account book has nothing
 * to open; and the page arrives on Needs attention rather than on everything.
 * The list is windowed by MobileVirtualList, the same component MobileSalesOrders
 * uses for its own thousands.
 *
 * A phone cannot hold the state, the number and where it stands on ONE visual
 * line at 375 px, so a quiet card here is two short lines rather than the
 * desktop's one. What matters is the same on both: nothing to open, and no
 * reason block.
 *
 * The mobile shell has no router and does not keep filters in the URL (unlike
 * the desktop page's useSearchParams), so the status chip, the type chip and the
 * document search are plain component state, matching every other mobile screen.
 * The two strips live in `.hdr`, which mobile.css already pins, so they stay put
 * while the list scrolls.
 *
 * ONE CARD PER DOCUMENT since 2026-08-17, alongside the desktop and from the
 * same helper (acGroupByDocument): "为什么在 AutoCount 里面一张 Sales Order 会出现
 * 两次呢?" The card is the document, its newest send says where it stands, and
 * every earlier send is folded under it.
 *
 * Send again is here too, and it has to be: a rule or a control on one surface
 * and not the other is the recurring bug class this repo names. Same shared
 * hook, same server sentence, same place for the answer — on the row.
 *
 * English · DD/MM/YYYY · no emoji.
 */

const TONE_COLOR: Record<AcTone, { fg: string; bg: string }> = {
  good: { fg: "var(--green)", bg: "var(--green-bg)" },
  bad: { fg: "var(--red)", bg: "var(--red-bg)" },
  wait: { fg: "var(--amber)", bg: "var(--amber-bg)" },
  muted: { fg: "var(--mut)", bg: "var(--bg)" },
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

/** A chip with its count, on both strips. */
function CountChip(
  { label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void },
) {
  return (
    <button onClick={onClick} className={on ? "chip on" : "chip"} aria-pressed={on}>
      {label}
      <span
        style={{
          marginLeft: 6, fontSize: 10, fontWeight: 800, fontVariantNumeric: "tabular-nums",
          borderRadius: 999, padding: "1px 5px",
          background: on ? "rgba(255,255,255,.35)" : "var(--bg)",
          color: "inherit",
        }}
      >
        {count}
      </span>
    </button>
  );
}

/**
 * The machinery, one level in from the reason — collapsed, and labelled with
 * who it is for. The desktop twin's TechnicalNote, in this file's idiom.
 *
 * It matters more here than there. The account-book dump the AutoCount service
 * started appending on 2026-08-16 is four lines of `Qty=1.00000000
 * TransferedQty=0.00000000` at 375 px, which is most of a phone screen spent on
 * something the person holding it cannot act on.
 */
function TechnicalNote({ text }: { text: string }) {
  return (
    <details
      data-ac-technical=""
      style={{ marginTop: 6, border: "1px dashed var(--line)", borderRadius: 7, padding: "5px 8px", background: "var(--bg)" }}
    >
      <summary style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--mut)" }}>
        {AC_TECHNICAL_LABEL}
      </summary>
      <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace", color: "var(--mut)" }}>
        {text}
      </div>
    </details>
  );
}

/**
 * What a machine said, quoted, and WHO said it.
 *
 * "AutoCount replied" and "AutoCount was not asked" are different facts and
 * they change what the reader does about the document. Behind the opener since
 * the cards had to get short — never flattened into one label, which would lose
 * the distinction rather than tidy it.
 *
 * Renders the shared layer's AcSaid, exactly as the desktop does. What counts
 * as a sentence and what counts as machinery is decided once, for the product,
 * not twice, per surface.
 */
function WhatWasSaid({ said }: { said: AcSaid }) {
  return (
    <div style={{ marginTop: 8, paddingTop: 7, borderTop: "1px dashed var(--line)" }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--mut)" }}>
        {said.label}
      </span>
      {said.notAsked && (
        <span style={{ marginLeft: 6, fontSize: 11, color: "var(--mut)" }}>{AC_NOT_ASKED_NOTE}</span>
      )}
      {said.silent && (
        <span style={{ marginLeft: 6, fontSize: 11, fontStyle: "italic", color: "var(--mut)" }}>Nothing came back with it.</span>
      )}
      {said.said !== null && (
        <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace", color: "var(--ink2)" }}>
          {said.said}
        </div>
      )}
      {said.technical !== null && <TechnicalNote text={said.technical} />}
    </div>
  );
}

/**
 * A document's earlier sends, folded under it — the desktop twin's
 * `EarlierSends`, in this file's idiom. The audit trail is kept; it is simply
 * not the list.
 */
function EarlierSends({ sends, maxAttempts }: { sends: AcOutboxRow[]; maxAttempts: number }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--bg)", borderTop: "1px solid var(--line)" }}>
      <p style={{ margin: "0 0 6px", fontSize: 11, lineHeight: 1.5, color: "var(--mut)" }}>
        {AC_EARLIER_SENDS_NOTE}
      </p>
      {sends.map((s) => (
        <div
          key={s.id}
          data-ac-send=""
          style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}
        >
          <StateBadge state={s.state} />
          <span
            style={{
              minWidth: 0, flex: 1, fontSize: 10.5, color: "var(--mut2)",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {acRowStandsAt(s, maxAttempts)}
          </span>
        </div>
      ))}
    </div>
  );
}

function OutboxCard(
  { group, maxAttempts, sending, note, open, onToggle, historyOpen, onToggleHistory, onSendAgain, onSendNow }: {
    group: AcDocGroup;
    maxAttempts: number;
    sending: boolean;
    note: AcRequeueNote | undefined;
    open: boolean;
    onToggle: () => void;
    historyOpen: boolean;
    onToggleHistory: () => void;
    onSendAgain: () => void;
    onSendNow: () => void;
  },
) {
  /* The card is the DOCUMENT and its newest send says where it stands — same
     rule as the desktop, from the same helper. */
  const row = group.current;
  const tone = acStateTone(row.state);
  const c = TONE_COLOR[tone];
  /* Cleared the moment the re-send is accepted — see the desktop twin. */
  const detail = acRowDetail(row, note?.clearsReason === true);

  return (
    <div
      data-ac-row=""
      className="card"
      style={{
        border: `1px solid ${row.needs_attention ? "#e6cccc" : "var(--line-card)"}`,
        borderLeft: `3px solid ${c.fg}`,
      }}
    >
      <div style={{ padding: "7px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <StateBadge state={row.state} />
          <b style={{ fontSize: 12.5, color: "var(--ink)", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
            {row.doc_no}
          </b>
          {/* Offered only where the SERVER says a re-send can mean anything. */}
          {row.can_requeue && (
            <button
              onClick={onSendAgain}
              disabled={sending}
              style={{
                marginLeft: "auto", fontFamily: "inherit", fontSize: 11, fontWeight: 700,
                borderRadius: 7, padding: "3px 8px", cursor: sending ? "default" : "pointer",
                border: "1px solid var(--brand)", background: "var(--brand-bg)", color: "var(--brand-d)",
                whiteSpace: "nowrap",
              }}
            >
              {sending ? AC_SEND_AGAIN_BUSY_LABEL : AC_SEND_AGAIN_LABEL}
            </button>
          )}
          {/* The WAITING row gets its push here too. A control on one surface
              and not the other is the recurring bug class this repo names, and
              the owner uses the phone on the floor. */}
          {row.can_send_now && (
            <button
              onClick={onSendNow}
              disabled={sending}
              style={{
                marginLeft: "auto", fontFamily: "inherit", fontSize: 11, fontWeight: 700,
                borderRadius: 7, padding: "3px 8px", cursor: sending ? "default" : "pointer",
                border: "1px solid var(--brand)", background: "var(--brand-bg)", color: "var(--brand-d)",
                whiteSpace: "nowrap",
              }}
            >
              {sending ? AC_SEND_NOW_BUSY_LABEL : AC_SEND_NOW_LABEL}
            </button>
          )}
        </div>
        <div
          style={{
            fontSize: 10.5, color: "var(--mut2)", marginTop: 2,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {acRowStandsAt(row, maxAttempts)}
        </div>
      </div>

      {/* THE REASON, ONE LINE, ALWAYS VISIBLE — and it is the opener. */}
      {detail.line !== null && (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          style={{
            display: "flex", alignItems: "center", gap: 5, width: "100%", textAlign: "left",
            fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: c.fg, background: c.bg,
            border: "none", borderTop: "1px solid var(--line)", padding: "6px 10px", cursor: "pointer",
          }}
        >
          {/* The same angle mark the Back control uses, rotated. A filled
              triangle would be the obvious glyph and is one of the code points
              that renders as an EMOJI on some platforms, which this repo does
              not allow anywhere. */}
          <span
            aria-hidden
            className="chev"
            style={{
              flex: "none", lineHeight: 1, display: "inline-block",
              transform: open ? "rotate(90deg)" : undefined,
            }}
          >
            ›
          </span>
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail.line}
          </span>
        </button>
      )}

      {open && detail.expandable && (
        <div style={{ padding: "8px 10px", background: c.bg, borderTop: "1px solid var(--line)" }}>
          {detail.copy && (
            <>
              <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--mut)" }}>
                {detail.copy.explain}
              </p>
              <p style={{ margin: "6px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--ink2)" }}>
                <b style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: c.fg, marginRight: 6 }}>
                  To fix
                </b>
                {detail.copy.toFix}
              </p>
            </>
          )}
          {detail.showRequeuedNote && (
            <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: "var(--mut)" }}>
              {AC_REPLACED_NOTE}
            </p>
          )}
          {detail.said && <WhatWasSaid said={detail.said} />}
        </div>
      )}

      {/* The send history, folded, and only where there is one. */}
      {group.earlier.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={onToggleHistory}
            style={{
              display: "flex", alignItems: "center", gap: 5, width: "100%", textAlign: "left",
              fontFamily: "inherit", fontSize: 11, fontWeight: 700, color: "var(--mut)",
              background: "transparent", border: "none", borderTop: "1px solid var(--line)",
              padding: "6px 10px", cursor: "pointer",
            }}
          >
            <span
              aria-hidden
              className="chev"
              style={{
                flex: "none", lineHeight: 1, display: "inline-block",
                transform: historyOpen ? "rotate(90deg)" : undefined,
              }}
            >
              ›
            </span>
            {acEarlierSendsHeading(group.earlier.length)}
          </button>
          {historyOpen && <EarlierSends sends={group.earlier} maxAttempts={maxAttempts} />}
        </>
      )}

      {/* Accepted, refused, or never answered — all three land on the row, and
          never behind the opener: nobody presses a button then goes looking. */}
      {note && (
        <div
          style={{
            fontSize: 11.5, lineHeight: 1.45, padding: "8px 10px",
            background: TONE_COLOR[note.tone].bg, color: TONE_COLOR[note.tone].fg,
            borderTop: "1px solid var(--line)", fontWeight: 600,
          }}
        >
          {note.text}
          {note.todo && (
            <div style={{ marginTop: 5, fontWeight: 400, color: "var(--ink2)" }}>
              <b style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: TONE_COLOR[note.tone].fg, marginRight: 6 }}>
                To do
              </b>
              {note.todo}
            </div>
          )}
          {note.quote && (
            <div style={{ marginTop: 4, fontWeight: 400, fontFamily: "ui-monospace, monospace", color: "var(--ink2)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {note.quote}
            </div>
          )}
          {note.quoteTechnical && <TechnicalNote text={note.quoteTechnical} />}
        </div>
      )}
    </div>
  );
}

export function MobileAutoCountSync({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<AcFilterState>(AC_DEFAULT_STATE);
  const [docType, setDocType] = useState<AcDocType | "">("");
  const [docNo, setDocNo] = useState("");

  const q = useAutoCountOutbox({ state, docNo });
  const d = q.data;
  const reload = q.reload;
  const requeue = useAcRequeue(useCallback(() => { reload(); }, [reload]));
  const expanded = useAcExpandedRows();
  const sendHistory = useAcSendHistory();
  const history = useAcReplacedGroup();
  const headline = acHeadline(d);
  const maxAttempts = d?.meta.max_attempts ?? 6;
  /* ONE CARD PER DOCUMENT, from the same helper the desktop uses. A phone has
     less room than a screen for the same sales order four times over, not
     more. */
  const loaded = acGroupByDocument(d?.rows ?? []);
  const typeCounts = acDocTypeCounts(loaded);
  const groups = acGroupsOfType(loaded, docType);
  /* History folds away here too — a phone has less room to spend on documents
     that already went through, not more. Same helper, same default. */
  const split = acSplitReplaced(groups, state);

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

        {/* Two strips, the same two the desktop page shows, in the same order.
            `.hdr` is sticky in mobile.css, so they stay put while the list
            scrolls — which is the whole point at a thousand rows. */}
        <div className="chips" style={{ marginTop: 11 }}>
          {AC_FILTER_STATES.map((s) => (
            <CountChip
              key={s}
              label={AC_FILTER_STATE_LABEL[s]}
              count={acStateCount(d ?? null, s)}
              on={state === s}
              onClick={() => setState(s)}
            />
          ))}
        </div>
        <div className="chips" style={{ marginTop: 7 }}>
          <CountChip
            label="Every type"
            count={typeCounts.all}
            on={docType === ""}
            onClick={() => setDocType("")}
          />
          {AC_DOC_TYPES.map((t) => (
            <CountChip
              key={t}
              label={acDocTypePlural(t)}
              count={typeCounts[t]}
              on={docType === t}
              onClick={() => setDocType(t)}
            />
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
            {/* The page's own sentence, then the machine's words QUOTED under
                it — never spliced into it. Same rule as every other reply on
                this screen. */}
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>
              {AC_LOAD_FAILED_LINE}
              <span style={{ display: "block", marginTop: 3, fontWeight: 400, fontSize: 10.5, fontFamily: "ui-monospace, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {q.error}
              </span>
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
            <div style={{ fontSize: 10.5, color: "var(--mut)", background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
              <b style={{ color: d.writeback.on ? "var(--green)" : "var(--mut)" }}>{acWritebackLine(d)}</b>
              {" "}Documents go out every five minutes and give up after {maxAttempts} tries.
              {d.oldest_pending
                ? ` Oldest still waiting: ${d.oldest_pending.doc_no}, ${acAge(d.oldest_pending.created_at)}.`
                : " Nothing waiting."}
            </div>

            <input
              value={docNo}
              onChange={(e) => setDocNo(e.target.value)}
              placeholder="Find a document number"
              aria-label="Find a document number"
              style={{ width: "100%", marginBottom: 11, fontFamily: "inherit", fontSize: 12, borderRadius: 9, border: "1px solid var(--line)", padding: "8px 10px", background: "var(--card)", color: "var(--ink)" }}
            />

            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
              <b style={{ fontSize: 13, color: "var(--ink)" }}>{acListTitle(state, docType)}</b>
              {/* The SAME sentence the desktop prints. It used to be "6 of 17"
                  here and "6 of 17 documents" there — two hand-written strings
                  making two different claims about one number. */}
              <span style={{ fontSize: 10.5, color: "var(--mut)", fontVariantNumeric: "tabular-nums" }}>
                {acListCountLine(groups.length, d.counts.total)}
              </span>
            </div>

            {(d.truncated || !d.counts_complete) && (
              <div style={{ fontSize: 11, color: "var(--amber)", background: "var(--amber-bg)", borderRadius: 9, padding: "8px 10px", marginBottom: 11 }}>
                {d.truncated && (
                  <p style={{ margin: 0 }}>
                    Only the most recent documents are shown. The status counts still cover every
                    one; the type counts cover what is on screen.
                  </p>
                )}
                {!d.counts_complete && (
                  <p style={{ margin: d.truncated ? "5px 0 0" : 0 }}>{AC_COUNTS_PARTIAL_LINE}</p>
                )}
              </div>
            )}

            {groups.length === 0 ? (
              <div style={{ textAlign: "center", padding: "34px 12px", fontSize: 12, color: "var(--mut)" }}>
                {acEmptyLine(d, state)}
              </div>
            ) : split.live.length === 0 ? (
              <div style={{ textAlign: "center", padding: "34px 12px", fontSize: 12, color: "var(--mut)" }}>
                {AC_ONLY_REPLACED_LINE}
              </div>
            ) : (
              <MobileVirtualList
                items={split.live}
                getKey={(g) => g.key}
                gap={8}
                estimateHeight={62}
                ariaLabel={`${split.live.length} loaded documents. Only visible cards are mounted; scroll to browse this loaded set.`}
                renderItem={(g) => (
                  <OutboxCard
                    group={g}
                    maxAttempts={maxAttempts}
                    sending={requeue.sendingId === g.current.id}
                    note={requeue.notes[g.current.id]}
                    open={expanded.isOpen(g.current)}
                    onToggle={() => expanded.toggle(g.current)}
                    historyOpen={sendHistory.isOpen(g)}
                    onToggleHistory={() => sendHistory.toggle(g)}
                    onSendAgain={() => void requeue.sendAgain(g.current.id)}
                    onSendNow={() => void requeue.sendNow(g.current.id)}
                  />
                )}
              />
            )}

            {/* THE RECORD, FOLDED — under the live cards, never among them, and
                not built at all until it is opened. */}
            {split.replaced.length > 0 && (
              <div style={{ marginTop: 11, border: "1px dashed var(--line)", borderRadius: 11, background: "var(--card)" }}>
                <button
                  type="button"
                  aria-expanded={history.open}
                  onClick={history.toggle}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
                    fontFamily: "inherit", fontSize: 11.5, fontWeight: 700, color: "var(--mut)",
                    background: "transparent", border: "none", padding: "9px 11px", cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden
                    className="chev"
                    style={{
                      flex: "none", lineHeight: 1, display: "inline-block",
                      transform: history.open ? "rotate(90deg)" : undefined,
                    }}
                  >
                    ›
                  </span>
                  {acReplacedHeading(split.replaced.length)}
                </button>
                {history.open && (
                  <div style={{ borderTop: "1px solid var(--line)", padding: "9px 11px" }}>
                    <p style={{ margin: "0 0 8px", fontSize: 11, lineHeight: 1.5, color: "var(--mut)" }}>
                      {AC_REPLACED_GROUP_NOTE}
                    </p>
                    <MobileVirtualList
                      items={split.replaced}
                      getKey={(g) => g.key}
                      gap={8}
                      estimateHeight={62}
                      ariaLabel={`${split.replaced.length} replaced documents, kept as a record.`}
                      renderItem={(g) => (
                        <OutboxCard
                          group={g}
                          maxAttempts={maxAttempts}
                          sending={requeue.sendingId === g.current.id}
                          note={requeue.notes[g.current.id]}
                          open={expanded.isOpen(g.current)}
                          onToggle={() => expanded.toggle(g.current)}
                          historyOpen={sendHistory.isOpen(g)}
                          onToggleHistory={() => sendHistory.toggle(g)}
                          onSendAgain={() => void requeue.sendAgain(g.current.id)}
                          onSendNow={() => void requeue.sendNow(g.current.id)}
                        />
                      )}
                    />
                  </div>
                )}
              </div>
            )}

            <details style={{ marginTop: 14, background: "var(--card)", border: "1px solid var(--line-card)", borderRadius: 11, padding: "10px 12px" }}>
              <summary style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
                What each of these words means
              </summary>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 7 }}>
                {Object.entries(AC_STATE_PLAIN_MEANING).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 7, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <StateBadge state={k} />
                    <span style={{ flex: 1, minWidth: 180, fontSize: 11, color: "var(--mut)" }}>{v}</span>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

export default MobileAutoCountSync;
