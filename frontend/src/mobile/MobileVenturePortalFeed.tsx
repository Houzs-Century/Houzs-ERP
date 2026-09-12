// ---------------------------------------------------------------------------
// Venture Portal Feed, on a phone.
//
// SAME VERDICTS, SAME ACTIONS, SAME WORDS as pages/VenturePortalFeed.tsx —
// every one of them from lib/venturePortalFeed.ts. This file decides nothing.
// The owner's standing rule is one shared logic layer with the two surfaces
// differing only in presentation, and "the rule was fixed on the desktop and
// not on mobile" is a bug class this repo keeps paying for.
//
// WHAT IS DIFFERENT HERE, and it is only layout: the two settings cards stack,
// the queue is a scrolling list of cards rather than a register, and the state
// filter is the header's chip strip (where every other mobile screen's filter
// lives) instead of in-page pills. Nothing is hidden from the phone that the
// desktop shows — including turning the feed off, which is the one control
// somebody most plausibly needs while not at a desk.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";

import {
  VP_MIN_SECRET_LEN,
  VP_ROW_STATUS_LABEL,
  useVpActions,
  useVpRows,
  useVpStatus,
  vpOutcomeLine,
  vpRowTodo,
  vpScopeLabel,
  vpSecretLine,
  vpVerdict,
  type VpRow,
  type VpRowStatus,
  type VpTone,
} from "../lib/venturePortalFeed";
import "./mobile.css";

const TONE_BG: Record<VpTone, string> = {
  good: "rgba(22,105,95,.07)",
  bad: "rgba(176,42,42,.07)",
  wait: "rgba(161,106,46,.09)",
  off: "rgba(17,20,15,.04)",
};

const TONE_INK: Record<VpTone, string> = {
  good: "#11564e",
  bad: "#8f2222",
  wait: "#7a4f1f",
  off: "#5f6459",
};

const TABS: ReadonlyArray<{ id: VpRowStatus | "all"; label: string }> = [
  { id: "failed", label: "Not delivered" },
  { id: "pending", label: "Waiting" },
  { id: "sent", label: "Delivered" },
  { id: "skipped", label: "Out of scope" },
  { id: "all", label: "Everything" },
];

function Note({ tone, text }: { tone: VpTone; text: string }) {
  return (
    <div
      style={{
        background: TONE_BG[tone],
        color: TONE_INK[tone],
        borderRadius: 11,
        padding: "9px 11px",
        fontSize: 12.5,
        lineHeight: 1.45,
      }}
    >
      {text}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="ey" style={{ color: "#767b6e", marginBottom: 4 }}>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, lineHeight: 1.45, color: "#767b6e", marginTop: 4 }}>{children}</div>
  );
}

function QueueCard({
  row,
  canManage,
  busy,
  onRequeue,
}: {
  row: VpRow;
  canManage: boolean;
  busy: string | null;
  onRequeue: () => void;
}) {
  const outcome = vpOutcomeLine(row);
  const todo = vpRowTodo(row);
  const sending = busy === `row:${row.id}`;

  return (
    <div className="card" style={{ padding: 12, marginBottom: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 700 }}>{row.doc_no}</span>
        <span style={{ fontSize: 11, color: "#767b6e" }}>{VP_ROW_STATUS_LABEL[row.status]}</span>
        {row.attempts > 1 ? (
          <span className="tnum" style={{ fontSize: 11, color: "#9aa093" }}>
            tried {row.attempts}x
          </span>
        ) : null}
      </div>
      {outcome ? <div style={{ fontSize: 11.5, color: "#767b6e", marginTop: 3 }}>{outcome}</div> : null}
      {todo ? <div style={{ fontSize: 12, marginTop: 7, lineHeight: 1.45 }}>{todo}</div> : null}
      {row.last_error ? (
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#767b6e",
            marginTop: 6,
            wordBreak: "break-word",
          }}
        >
          {row.last_error}
        </div>
      ) : null}
      {row.status === "failed" && canManage ? (
        <button
          className="btn"
          style={{ marginTop: 10, padding: 10, fontSize: 13 }}
          disabled={sending}
          onClick={onRequeue}
        >
          {sending ? "Sending" : "Send again"}
        </button>
      ) : null}
    </div>
  );
}

export function MobileVenturePortalFeed({ onBack }: { onBack: () => void }) {
  const status = useVpStatus();
  const [tab, setTab] = useState<VpRowStatus | "all">("failed");
  const rows = useVpRows(tab);

  const statusReload = status.reload;
  const rowsReload = rows.reload;
  const refresh = useCallback(() => {
    statusReload();
    rowsReload();
  }, [statusReload, rowsReload]);

  const actions = useVpActions(refresh);
  const s = status.data;
  const canManage = s?.canManage ?? false;
  const verdict = useMemo(() => vpVerdict(s), [s]);

  /* Draft state, seeded once from the server. Deliberately not re-synced on
     every poll — overwriting a half-typed address every fifteen seconds is the
     classic version of this bug, and a phone keyboard makes it worse. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [sinceDraft, setSinceDraft] = useState<string | null>(null);
  const [secretDraft, setSecretDraft] = useState("");
  const [companiesDraft, setCompaniesDraft] = useState<string | null>(null);
  const [everyCompany, setEveryCompany] = useState<boolean | null>(null);

  const url = urlDraft ?? s?.connection.url ?? "";
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
    <div
      className="hz-m"
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}
    >
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}>
              <span className="chev">&lsaquo;</span> Back
            </button>
            <div className="eyebrow">System</div>
            <div className="scr-title">Venture Portal Feed</div>
          </div>
        </div>

        {/* The state filter, where every other mobile screen keeps its filter.
            Counts are the SERVER's aggregate — the list is capped at 100, so
            counting what loaded would understate a real backlog. */}
        <div className="chips" style={{ marginTop: 11 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={tab === t.id ? "chip on" : "chip"}
              aria-pressed={tab === t.id}
            >
              {t.label}
              {t.id !== "all" && s ? ` ${s.queue[t.id]}` : ""}
            </button>
          ))}
        </div>
      </header>

      <div className="scroll" style={{ padding: 14 }}>
        <div style={{ marginBottom: 12 }}>
          <Note tone={verdict.tone} text={verdict.headline} />
          {verdict.detail ? (
            <div style={{ fontSize: 11.5, color: "#767b6e", marginTop: 6, lineHeight: 1.45 }}>{verdict.detail}</div>
          ) : null}
        </div>

        {actions.note ? (
          <div style={{ marginBottom: 12 }}>
            <Note tone={actions.note.tone} text={actions.note.text} />
          </div>
        ) : null}

        {s ? (
          <>
            <div className="card" style={{ padding: 13, marginBottom: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 3 }}>Switch</div>
              <Hint>
                Off means no sales order leaves this system. Nothing piles up waiting while it is off.
              </Hint>

              <div style={{ fontSize: 12.5, marginTop: 9, color: "#11140f" }}>
                Now: <strong>{s.feed.enabled ? "On" : "Off"}</strong> &middot; {vpScopeLabel(s)}
              </div>

              <div style={{ marginTop: 11 }}>
                <Label>Companies</Label>
                <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, marginBottom: 7 }}>
                  <input
                    type="checkbox"
                    checked={allCompanies}
                    disabled={!canManage}
                    onChange={(e) => setEveryCompany(e.target.checked)}
                  />
                  Every company
                </label>
                <input
                  className="fld-i"
                  value={companies}
                  placeholder="1"
                  disabled={!canManage || allCompanies}
                  onChange={(e) => setCompaniesDraft(e.target.value)}
                />
                <Hint>
                  Which companies&rsquo; sales orders feed the portal. Houzs Century is 1. Nothing is sent for a company
                  that is not listed.
                </Hint>
              </div>

              {canManage ? (
                <>
                  <button
                    className="btn"
                    style={{ marginTop: 12 }}
                    disabled={actions.busy === "scope" || (!allCompanies && parsedCompanies.length === 0)}
                    onClick={() => void actions.saveScope(true, allCompanies ? "all" : parsedCompanies)}
                  >
                    {actions.busy === "scope" ? "Saving" : s.feed.enabled ? "Save and keep on" : "Turn on"}
                  </button>
                  {s.feed.enabled ? (
                    <button
                      className="btn"
                      style={{ marginTop: 8, background: "#fff", color: "#8f2222", border: "1px solid rgba(176,42,42,.35)" }}
                      disabled={actions.busy === "scope"}
                      onClick={() => void actions.saveScope(false, [])}
                    >
                      Turn off
                    </button>
                  ) : null}
                </>
              ) : (
                <Hint>You can see the feed but not change it.</Hint>
              )}
            </div>

            <div className="card" style={{ padding: 13, marginBottom: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 3 }}>Connection</div>
              <Hint>The shared secret is never shown again after it is saved.</Hint>

              <div style={{ marginTop: 11 }}>
                <Label>Receiver address</Label>
                <input
                  className="fld-i"
                  value={url}
                  placeholder="https://…/api/erp/v1/sales-orders"
                  disabled={!canManage}
                  onChange={(e) => setUrlDraft(e.target.value)}
                />
                <Hint>Must be https. The portal owner provides this.</Hint>
              </div>

              <div style={{ marginTop: 11 }}>
                <Label>Do not send orders dated before</Label>
                <input
                  className="fld-i"
                  type="date"
                  value={since}
                  disabled={!canManage}
                  onChange={(e) => setSinceDraft(e.target.value)}
                />
                <Hint>Leave empty to send every order in scope, however old.</Hint>
              </div>

              {canManage ? (
                <button
                  className="btn"
                  style={{ marginTop: 12, background: "#fff", color: "#16695f", border: "1px solid #d6d9d2" }}
                  disabled={actions.busy === "connection" || !url}
                  onClick={() => void actions.saveConnection(url, since)}
                >
                  {actions.busy === "connection" ? "Saving" : "Save address"}
                </button>
              ) : null}

              <div style={{ marginTop: 13 }}>
                <Label>Shared secret</Label>
                <input
                  className="fld-i"
                  type="password"
                  autoComplete="new-password"
                  value={secretDraft}
                  placeholder={`At least ${VP_MIN_SECRET_LEN} characters`}
                  disabled={!canManage}
                  onChange={(e) => setSecretDraft(e.target.value)}
                />
                <Hint>{vpSecretLine(s)}</Hint>
                {secretDraft.length > 0 && secretDraft.length < VP_MIN_SECRET_LEN ? (
                  <div style={{ fontSize: 11.5, color: "#8f2222", marginTop: 4 }}>
                    Too short &mdash; {secretDraft.length} of {VP_MIN_SECRET_LEN} characters.
                  </div>
                ) : null}
              </div>

              {canManage ? (
                <>
                  <button
                    className="btn"
                    style={{ marginTop: 10 }}
                    disabled={actions.busy === "secret" || secretDraft.length < VP_MIN_SECRET_LEN}
                    onClick={() => void actions.saveSecret(secretDraft).then(() => setSecretDraft(""))}
                  >
                    {actions.busy === "secret" ? "Saving" : s.connection.secret.set ? "Replace secret" : "Save secret"}
                  </button>
                  <button
                    className="btn"
                    style={{ marginTop: 8, background: "#fff", color: "#16695f", border: "1px solid #d6d9d2" }}
                    disabled={actions.busy === "probe"}
                    onClick={() => void actions.probe()}
                  >
                    {actions.busy === "probe" ? "Testing" : "Test connection"}
                  </button>
                </>
              ) : null}
            </div>

            {canManage ? (
              <div className="card" style={{ padding: 13, marginBottom: 12 }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 3 }}>The queue</div>
                <Hint>
                  A batch goes out every five minutes, up to {s.queue.batch} at a time.
                </Hint>
                <button
                  className="btn"
                  style={{ marginTop: 11, background: "#fff", color: "#16695f", border: "1px solid #d6d9d2" }}
                  disabled={actions.busy === "queue"}
                  onClick={() => void actions.queueUndelivered(false)}
                >
                  {actions.busy === "queue" ? "Checking" : "Queue anything not delivered"}
                </button>
                <button
                  className="btn"
                  style={{ marginTop: 8, background: "#fff", color: "#16695f", border: "1px solid #d6d9d2" }}
                  disabled={actions.busy === "drain"}
                  onClick={() => void actions.sendNow(s.queue.batch)}
                >
                  {actions.busy === "drain" ? "Sending" : "Send now"}
                </button>
              </div>
            ) : null}

            {(rows.data?.rows.length ?? 0) === 0 ? (
              <div style={{ textAlign: "center", padding: "28px 0", fontSize: 12.5, color: "#767b6e" }}>
                {tab === "failed"
                  ? "Nothing has failed to deliver."
                  : tab === "pending"
                    ? "Nothing is waiting."
                    : "Nothing here."}
              </div>
            ) : (
              (rows.data?.rows ?? []).map((row) => (
                <QueueCard
                  key={row.id}
                  row={row}
                  canManage={canManage}
                  busy={actions.busy}
                  onRequeue={() => void actions.requeueRow(row.id, row.doc_no)}
                />
              ))
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default MobileVenturePortalFeed;
