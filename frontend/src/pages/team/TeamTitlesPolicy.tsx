import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/Badge";
import { Eyebrow } from "./teamShared";

/* Roles & Permissions › Titles (owner 2026-09-16, review part B). One row per
 * Title: which cohort it is (god / full / restricted / sales), which whitelist
 * or sales tier, and the three per-Title flags. Each change saves at once
 * (PUT /api/position-policy/:id) and reaches every member of that Title on
 * their next request. The vocabularies come from the API; nothing here
 * restates a backend rule. */

export type {
  PolicyCohort,
  TitlePolicyRow,
  TitlePolicyEntry,
  TitlePolicyPayload,
} from "../../lib/titlePolicyModel";
import type { PolicyCohort, TitlePolicyEntry, TitlePolicyPayload, Draft } from "../../lib/titlePolicyModel";
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
} from "../../lib/titlePolicyModel";

export function TeamTitlesPolicy({
  payload,
  canEdit,
  onSaved,
}: {
  payload: TitlePolicyPayload;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Map<number, Draft>>(new Map());
  const [savingId, setSavingId] = useState<number | null>(null);

  useEffect(() => {
    const next = new Map<number, Draft>();
    for (const e of payload.positions) next.set(e.id, draftOf(e));
    setDrafts(next);
  }, [payload]);

  const positions = orderedPositions(payload);

  async function save(entry: TitlePolicyEntry, patch: Partial<Draft>) {
    if (!canEdit || savingId != null) return;
    const previous = drafts.get(entry.id) ?? draftOf(entry);
    const next = normalise({ ...previous, ...patch }, payload);
    setDrafts((prev) => new Map(prev).set(entry.id, next));
    setSavingId(entry.id);
    try {
      await api.put(`/api/position-policy/${entry.id}`, next);
      onSaved();
    } catch (e) {
      setDrafts((prev) => new Map(prev).set(entry.id, previous));
      toast.error(e instanceof Error ? e.message : "Could not save the change");
    } finally {
      setSavingId(null);
    }
  }

  async function reset(entry: TitlePolicyEntry) {
    if (!canEdit || savingId != null) return;
    setSavingId(entry.id);
    try {
      await api.del(`/api/position-policy/${entry.id}`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset the Title");
    } finally {
      setSavingId(null);
    }
  }

  const showDuty = (payload.duties ?? []).length > 0;
  const gridTemplate = showDuty
    ? "200px 120px 150px 130px 64px 64px 64px 90px"
    : "220px 130px 170px 72px 72px 72px 90px";
  let lastDept: string | null | undefined;

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[840px] overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          <div
            className="grid items-end gap-2 border-b border-border bg-surface-2 px-5 py-2"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {["Title", "Cohort", "Profile", ...(showDuty ? ["Duty"] : []), "Money", "Config", "Fleet", "Source"].map((h) => (
              <span key={h} className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                {h}
              </span>
            ))}
          </div>

          {positions.map((p) => {
            const d = drafts.get(p.id) ?? draftOf(p);
            const disabled = !canEdit || savingId != null;
            const deptHeader = p.department_name !== lastDept ? (p.department_name ?? "No department") : null;
            lastDept = p.department_name;
            const profileOptions = profileOptionsFor(d.cohort, payload);
            const flagsEditable = flagsEditableFor(d.cohort);
            const fleetEditable = fleetEditableFor(d.cohort);
            return (
              <div key={p.id}>
                {deptHeader && (
                  <div className="border-b border-border-subtle bg-surface-2 px-5 py-1.5">
                    <Eyebrow>{deptHeader}</Eyebrow>
                  </div>
                )}
                <div
                  className={cn(
                    "grid items-center gap-2 border-b border-border-subtle px-5 py-2.5 last:border-b-0",
                    savingId === p.id && "opacity-60",
                  )}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div>
                    <div className="truncate text-[13px] font-semibold text-ink">{p.name}</div>
                    <div className="truncate font-mono text-[10px] uppercase tracking-wider text-ink-muted">{p.slug}</div>
                  </div>

                  <select
                    id={`title-policy-cohort-${p.id}`}
                    aria-label={`${p.name} cohort`}
                    value={d.cohort}
                    disabled={disabled}
                    title={COHORT_HELP[d.cohort]}
                    onChange={(e) => save(p, { cohort: e.target.value as PolicyCohort })}
                    className="h-8 rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink"
                  >
                    {payload.cohorts.map((c) => (
                      <option key={c} value={c}>
                        {COHORT_LABEL[c]}
                      </option>
                    ))}
                  </select>

                  {profileOptions.length ? (
                    <select
                      id={`title-policy-profile-${p.id}`}
                      aria-label={`${p.name} profile`}
                      value={d.profile ?? ""}
                      disabled={disabled}
                      onChange={(e) => save(p, { profile: e.target.value })}
                      className="h-8 rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink"
                    >
                      {profileOptions.map((o) => (
                        <option key={o} value={o}>
                          {profileLabel(o)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-[12px] text-ink-muted">—</span>
                  )}

                  {showDuty && (
                    <select
                      id={`title-policy-duty-${p.id}`}
                      aria-label={`${p.name} duty`}
                      value={d.duty}
                      disabled={disabled || !dutyEditableFor(d.cohort)}
                      title={d.cohort === "god" ? "Owner tier is Management on every project" : DUTY_HELP}
                      onChange={(e) => save(p, { duty: e.target.value })}
                      className="h-8 rounded-md border border-border bg-surface px-2 text-[12.5px] text-ink"
                    >
                      {(payload.duties ?? []).map((o) => (
                        <option key={o} value={o}>
                          {DUTY_LABEL[o] ?? o}
                        </option>
                      ))}
                    </select>
                  )}

                  <FlagCell
                    id={`title-policy-money-${p.id}`}
                    label={`${p.name} may move money`}
                    on={d.can_move_money}
                    editable={flagsEditable && !disabled}
                    onToggle={() => save(p, { can_move_money: !d.can_move_money })}
                    title={flagsEditable ? "Post journals and raise payment vouchers" : "Set by the cohort"}
                  />
                  <FlagCell
                    id={`title-policy-config-${p.id}`}
                    label={`${p.name} may write SCM master data`}
                    on={d.can_write_config}
                    editable={flagsEditable && !disabled}
                    onToggle={() => save(p, { can_write_config: !d.can_write_config })}
                    title={flagsEditable ? "Products, prices, combos, delivery fees without the flat key" : "Set by the cohort"}
                  />
                  <FlagCell
                    id={`title-policy-fleet-${p.id}`}
                    label={`${p.name} is fleet`}
                    on={d.is_fleet}
                    editable={fleetEditable && !disabled}
                    onToggle={() => save(p, { is_fleet: !d.is_fleet })}
                    title={fleetEditable ? "Sees only their own delivery jobs; empty board until linked to a driver" : "Restricted Titles only"}
                  />

                  <div className="flex items-center gap-1.5">
                    <Badge tone={p.source === "row" ? "accent" : "neutral"} title={p.source === "row" ? "Stored on this Title" : "Not set — resolved from the Title's name"}>
                      {p.source === "row" ? "Set" : "Default"}
                    </Badge>
                    {p.source === "row" && canEdit && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => reset(p)}
                        className="text-[11px] text-ink-muted underline-offset-2 hover:underline"
                        title="Remove the stored row; the Title goes back to the name rule"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-stone">
        <Badge tone="accent">Note</Badge>
        <p className="mb-0 text-[12.5px] leading-relaxed text-ink-secondary">
          A Title's cohort decides which pages its members see; its duty decides its
          job on a project page (who sees money, who edits, who is crew); the Roles
          matrix decides what they can do. Changes reach members on their next request. A Title
          marked Default has no stored row and follows its name; set it once to pin it.
          The Actions and SCM tabs still compose over the cohort.
        </p>
      </div>
    </div>
  );
}

function FlagCell({
  id,
  label,
  on,
  editable,
  onToggle,
  title,
}: {
  id: string;
  label: string;
  on: boolean;
  editable: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <button
      id={id}
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={!editable}
      onClick={onToggle}
      title={title}
      className={cn(
        "w-max rounded px-1.5 py-0.5 text-left text-[12.5px] transition-colors",
        on ? "font-semibold text-primary" : "text-ink-muted",
        editable ? "hover:bg-surface-2" : "cursor-default",
      )}
    >
      {on ? "✓" : "—"}
    </button>
  );
}
