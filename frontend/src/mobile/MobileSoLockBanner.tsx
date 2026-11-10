/* The phone SO editor's lock banner: Override with a reason on a SHIPPED+ order
   (#5600) and the DEV-32 "Edit after DO" notice with its Delivery Order pick.
   The phone twin of pages/scm-v2/SoLockBanner.tsx: the reason ask and the notice
   sentence are imported from there, so the two surfaces say the same thing. */
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { LOCKED_STATUSES } from "../vendor/scm/lib/so-detail-gates";
import type { AfterDoMode } from "../vendor/scm/lib/so-after-do-client";
import { SO_OVERRIDE_PROMPT, afterDoNoticeText } from "../pages/scm-v2/SoLockBanner";

const BOX = { display: "flex", flexDirection: "column", gap: 8, borderRadius: 10, padding: "9px 11px", fontSize: 11, lineHeight: 1.45 } as const;

export function MobileSoLockBanner({ status, overridden, overridePending, onOverride, onRelock, afterDo, afterDoTargetId, onPickTarget }: {
  status: string;
  overridden: boolean;
  /** The override request is in flight: the button stays locked (submitLock rule). */
  overridePending: boolean;
  /** Called with the typed reason; the caller unlocks only once the server has kept it. */
  onOverride: (reason: string) => void;
  onRelock: () => void;
  afterDo: AfterDoMode;
  afterDoTargetId: string | null;
  onPickTarget: (doId: string | null) => void;
}) {
  const askPrompt = usePrompt();
  const showLock = LOCKED_STATUSES.includes(status.toUpperCase());
  if (!showLock && !afterDo.on) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 11 }}>
      {showLock && (
        <div data-testid="so-lock-banner" style={{ ...BOX, background: overridden ? "rgba(184,51,31,0.06)" : "rgba(232,107,58,0.08)", border: `1px solid ${overridden ? "#B8331F" : "var(--c-orange, #e86b3a)"}`, color: "#8a4a24" }}>
          <span>
            {overridden
              ? <strong>Edit-lock overridden — changes are tracked in the status timeline.</strong>
              : <>This SO is <strong>{status.replace(/_/g, " ")}</strong>. Line items and addresses are locked. Tap <em>Override</em> if you must change something.</>}
          </span>
          <button type="button" className={overridden ? "btn-ghost" : "btn"} disabled={overridePending}
            onClick={async () => {
              if (overridden) { onRelock(); return; }
              const reason = await askPrompt(SO_OVERRIDE_PROMPT);
              if (reason != null) onOverride(reason.trim());
            }}>
            {overridePending ? "Saving…" : overridden ? "Re-lock" : "Override"}
          </button>
        </div>
      )}
      {afterDo.on && (
        <div data-testid="so-after-do-notice" style={{ ...BOX, background: "rgba(31,92,72,0.06)", border: "1px solid #c9d6cf", color: "#1f3d33" }}>
          <span><strong>Edit after DO.</strong> {afterDoNoticeText(afterDo)}</span>
          {afterDo.openTargets.length > 1 && (
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>New charge lines go on</span>
              <select className="fld-i" aria-label="Delivery Order for new charge lines" value={afterDoTargetId ?? ""} onChange={(e) => onPickTarget(e.target.value || null)}>
                <option value="">Pick a DO</option>
                {afterDo.openTargets.map((t) => <option key={t.id} value={t.id}>{t.do_number ?? t.id}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
