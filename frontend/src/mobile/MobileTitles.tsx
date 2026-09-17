import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useQuery } from "../hooks/useQuery";
import { useToast } from "../hooks/useToast";
import { api } from "../api/client";
import {
  COHORT_HELP,
  COHORT_LABEL,
  DUTY_HELP,
  DUTY_LABEL,
  draftOf,
  dutyEditableFor,
  flagsEditableFor,
  fleetEditableFor,
  normalise,
  orderedPositions,
  profileLabel,
  profileOptionsFor,
  type Draft,
  type PolicyCohort,
  type TitlePolicyEntry,
  type TitlePolicyPayload,
} from "../lib/titlePolicyModel";

/**
 * Mobile Titles — the phone presentation of the desktop Roles & Permissions ›
 * Titles tab (`pages/team/TeamTitlesPolicy.tsx`). ONE shared logic layer
 * (`lib/titlePolicyModel`) and the SAME `/api/position-policy` endpoints; only
 * the presentation differs: a Title LIST grouped by department, then a per-Title
 * detail where each control saves at once. Reads ride `users.read` (the screen
 * mount gate); writes need `roles.manage`, so a viewer without it sees the same
 * values with every control locked.
 */

const HDR_BACK: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  color: "var(--teal)",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
};

const SELECT_STYLE: React.CSSProperties = {
  width: "100%",
  height: 40,
  border: "1px solid var(--line-card)",
  background: "var(--bg)",
  borderRadius: "var(--r-input)",
  padding: "0 12px",
  fontSize: 13.5,
  fontFamily: "inherit",
  color: "var(--ink)",
  outline: "none",
};

export function MobileTitles({ onBack }: { onBack: () => void }) {
  const policyQ = useQuery<TitlePolicyPayload>("/api/position-policy", () => api.get("/api/position-policy"));
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const payload = policyQ.data ?? null;
  const positions = payload ? orderedPositions(payload) : [];
  const selected = selectedId != null ? positions.find((p) => p.id === selectedId) ?? null : null;

  // A Title that vanished under us (deleted/deactivated elsewhere) drops back to the list.
  useEffect(() => {
    if (selectedId != null && positions.length > 0 && !positions.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, positions]);

  if (selected && payload) {
    return (
      <TitleDetail
        entry={selected}
        payload={payload}
        onBack={() => setSelectedId(null)}
        onSaved={() => policyQ.reload()}
      />
    );
  }
  return (
    <TitleList
      payload={payload}
      loading={policyQ.loading}
      onBack={onBack}
      onOpen={setSelectedId}
    />
  );
}

// ── List view ────────────────────────────────────────────────
function TitleList({
  payload,
  loading,
  onBack,
  onOpen,
}: {
  payload: TitlePolicyPayload | null;
  loading: boolean;
  onBack: () => void;
  onOpen: (id: number) => void;
}) {
  const positions = payload ? orderedPositions(payload) : [];
  let lastDept: string | null | undefined;

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <header className="hdr">
        <button onClick={onBack} style={HDR_BACK}>‹ Back</button>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>Titles</div>
        <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 2 }}>
          A Title decides which pages its members see. Tap one to set it.
        </div>
      </header>

      <div className="scroll" style={{ padding: "12px 14px 32px" }}>
        {loading && <div style={{ color: "var(--mut)", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>}
        {!loading && positions.length === 0 && (
          <div style={{ color: "var(--mut)", fontSize: 13, padding: 24, textAlign: "center" }}>No Titles yet.</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {positions.map((p) => {
            const deptHeader = p.department_name !== lastDept ? (p.department_name ?? "No department") : null;
            lastDept = p.department_name;
            const eff = p.row ?? p.effective;
            return (
              <div key={p.id}>
                {deptHeader && (
                  <div className="ey" style={{ color: "var(--gold)", padding: "8px 2px 6px" }}>{deptHeader}</div>
                )}
                <button
                  className="card"
                  onClick={() => onOpen(p.id)}
                  style={{ width: "100%", textAlign: "left", cursor: "pointer", fontFamily: "inherit", padding: "13px 14px", border: "1px solid var(--line-card)" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </span>
                    <span
                      style={{
                        flex: "none",
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: ".06em",
                        textTransform: "uppercase",
                        color: p.source === "row" ? "var(--teal)" : "var(--mut)",
                        background: p.source === "row" ? "#e4f1ef" : "#efece4",
                        borderRadius: 999,
                        padding: "2px 6px",
                      }}
                    >
                      {p.source === "row" ? "Set" : "Default"}
                    </span>
                    <span style={{ flex: "none", color: "var(--mut2)", fontSize: 18 }}>›</span>
                  </div>
                  <div className="tnum" style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 6 }}>
                    {COHORT_LABEL[eff.cohort]}
                    {eff.profile ? ` · ${profileLabel(eff.profile)}` : ""}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────
function TitleDetail({
  entry,
  payload,
  onBack,
  onSaved,
}: {
  entry: TitlePolicyEntry;
  payload: TitlePolicyPayload;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can("roles.manage");
  const [draft, setDraft] = useState<Draft>(() => draftOf(entry));
  const [busy, setBusy] = useState(false);

  // Re-seed when a different Title is opened or the payload reloads (id is stable
  // across a save+reload, so persisted edits are not clobbered).
  useEffect(() => {
    setDraft(draftOf(entry));
  }, [entry]);

  const disabled = !canEdit || busy;
  const profiles = profileOptionsFor(draft.cohort, payload);
  const duties = payload.duties ?? [];
  const showDuty = duties.length > 0;

  async function save(patch: Partial<Draft>) {
    if (!canEdit || busy) return;
    const previous = draft;
    const next = normalise({ ...previous, ...patch }, payload);
    setDraft(next);
    setBusy(true);
    try {
      await api.put(`/api/position-policy/${entry.id}`, next);
      onSaved();
    } catch (e) {
      setDraft(previous);
      toast.error(e instanceof Error ? e.message : "Could not save the change");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!canEdit || busy) return;
    setBusy(true);
    try {
      await api.del(`/api/position-policy/${entry.id}`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset the Title");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <header className="hdr">
        <button onClick={onBack} style={HDR_BACK}>‹ Titles</button>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>{entry.name}</div>
        <div className="tnum" style={{ fontSize: 12, color: "var(--mut)", marginTop: 2 }}>
          {entry.department_name ?? "No department"} · {entry.slug}
        </div>
      </header>

      <div className="scroll" style={{ padding: "14px 14px 40px", display: "flex", flexDirection: "column", gap: 16 }}>
        {!canEdit && (
          <div style={{ fontSize: 12, color: "var(--mut)", background: "var(--bg)", border: "1px solid var(--line-card)", borderRadius: "var(--r-input)", padding: "10px 12px" }}>
            You can view this Title. Editing needs the roles.manage permission.
          </div>
        )}

        <Field label="Cohort" help={COHORT_HELP[draft.cohort]}>
          <select
            aria-label={`${entry.name} cohort`}
            value={draft.cohort}
            disabled={disabled}
            onChange={(e) => save({ cohort: e.target.value as PolicyCohort })}
            style={SELECT_STYLE}
          >
            {payload.cohorts.map((c) => (
              <option key={c} value={c}>{COHORT_LABEL[c]}</option>
            ))}
          </select>
        </Field>

        {profiles.length > 0 && (
          <Field label="Profile">
            <select
              aria-label={`${entry.name} profile`}
              value={draft.profile ?? ""}
              disabled={disabled}
              onChange={(e) => save({ profile: e.target.value })}
              style={SELECT_STYLE}
            >
              {profiles.map((o) => (
                <option key={o} value={o}>{profileLabel(o)}</option>
              ))}
            </select>
          </Field>
        )}

        {showDuty && (
          <Field label="Duty" help={dutyEditableFor(draft.cohort) ? DUTY_HELP : "Owner tier is Management on every project"}>
            <select
              aria-label={`${entry.name} duty`}
              value={draft.duty}
              disabled={disabled || !dutyEditableFor(draft.cohort)}
              onChange={(e) => save({ duty: e.target.value })}
              style={SELECT_STYLE}
            >
              {duties.map((o) => (
                <option key={o} value={o}>{DUTY_LABEL[o] ?? o}</option>
              ))}
            </select>
          </Field>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FlagRow
            label={`${entry.name} may move money`}
            title="Post journals and raise payment vouchers"
            on={draft.can_move_money}
            editable={flagsEditableFor(draft.cohort) && !disabled}
            onToggle={() => save({ can_move_money: !draft.can_move_money })}
          />
          <FlagRow
            label={`${entry.name} may write SCM master data`}
            title="Products, prices, combos, delivery fees without the flat key"
            on={draft.can_write_config}
            editable={flagsEditableFor(draft.cohort) && !disabled}
            onToggle={() => save({ can_write_config: !draft.can_write_config })}
          />
          <FlagRow
            label={`${entry.name} is fleet`}
            title="Sees only their own delivery jobs; empty board until linked to a driver"
            on={draft.is_fleet}
            editable={fleetEditableFor(draft.cohort) && !disabled}
            onToggle={() => save({ is_fleet: !draft.is_fleet })}
          />
        </div>

        {entry.source === "row" && canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={reset}
            style={{
              alignSelf: "flex-start",
              background: "none",
              border: "1px solid var(--line-card)",
              borderRadius: "var(--r-input)",
              color: "var(--mut)",
              fontFamily: "inherit",
              fontSize: 12.5,
              padding: "8px 12px",
              cursor: "pointer",
            }}
            title="Remove the stored row; the Title goes back to the name rule"
          >
            Reset to default
          </button>
        )}

        <p style={{ fontSize: 12, color: "var(--ink2)", lineHeight: 1.5, marginTop: 4 }}>
          The cohort decides which pages members see; the duty decides the job on a project
          page (who sees money, who edits, who is crew). Changes reach members on their next
          request. A Title marked Default follows its name until you set it.
        </p>
      </div>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <div className="ey" style={{ color: "var(--gold)", padding: "0 2px 6px" }}>{label}</div>
      {children}
      {help && <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 4 }}>{help}</div>}
    </label>
  );
}

function FlagRow({
  label,
  title,
  on,
  editable,
  onToggle,
}: {
  label: string;
  title: string;
  on: boolean;
  editable: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={!editable}
      onClick={onToggle}
      title={editable ? title : "Set by the cohort"}
      className="card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        textAlign: "left",
        fontFamily: "inherit",
        padding: "11px 14px",
        border: "1px solid var(--line-card)",
        cursor: editable ? "pointer" : "default",
        opacity: editable ? 1 : 0.7,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: "none",
          width: 22,
          height: 22,
          borderRadius: 6,
          border: "1px solid var(--line-card)",
          background: on ? "var(--teal)" : "transparent",
          color: on ? "#fff" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 800,
        }}
      >
        {on ? "✓" : ""}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--ink)" }}>{label}</span>
    </button>
  );
}
