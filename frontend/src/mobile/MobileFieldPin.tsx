import { useEffect, useState } from "react";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import {
  FIELD_PIN_LENGTH,
  clearFieldPin,
  fetchFieldPinStatus,
  fieldPinReasonText,
  setFieldPin,
  showsFieldPin,
  type FieldPinStatus,
} from "../lib/fieldPin";

/* Crew PIN sign-in on the phone member screen — the desktop FieldPinCard's
 * twin, against the same endpoints and the same shared rules (lib/fieldPin).
 * Rendered by MemberAccountActions, which already gates on users.manage. */
export function MobileFieldPin({ userId, memberName }: { userId: number; memberName: string }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const notify = useNotify();
  const [status, setStatus] = useState<FieldPinStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setStatus(await fetchFieldPinStatus(userId));
      setLoadError(false);
    } catch {
      setStatus(null);
      setLoadError(true);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over userId only
  }, [userId]);

  if (!loadError && !showsFieldPin(status)) return null;

  const setPin = async () => {
    const pin = await prompt({
      title: status?.hasPin ? "Set a new crew PIN" : "Set crew PIN",
      body: `6-digit PIN for ${memberName}. Tell it to them directly; it is never shown again.`,
      placeholder: "6 digits",
      confirmLabel: "Set PIN",
      validate: (v) => (new RegExp(`^\\d{${FIELD_PIN_LENGTH}}$`).test(v.trim()) ? null : "Exactly 6 digits."),
    });
    if (pin == null) return;
    setBusy(true);
    try {
      const res = await setFieldPin(userId, pin.trim());
      await notify({ title: "Crew PIN set", body: `${memberName} signs in as ${res.login} with this PIN.` });
      await refresh();
    } catch (e) {
      await notify({ title: "Couldn't set the PIN", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(false);
    }
  };

  const removePin = async () => {
    if (!(await confirm({ title: "Remove crew PIN?", body: `${memberName} is signed out of the crew screens and cannot sign in with a PIN until a new one is set.`, confirmLabel: "Remove" }))) return;
    setBusy(true);
    try {
      await clearFieldPin(userId);
      await refresh();
    } catch (e) {
      await notify({ title: "Couldn't remove the PIN", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(false);
    }
  };

  const reason = status ? fieldPinReasonText(status) : null;
  const line = { fontSize: 12.5, color: "#5f6358", margin: "0 2px 8px" } as const;
  return (
    <div style={{ marginBottom: 13 }}>
      <div className="ey" style={{ color: "var(--hz-c-ink-muted)", margin: "4px 2px 6px" }}>Crew PIN sign-in</div>
      {loadError ? (
        <div style={line}>
          Could not check the crew PIN.{" "}
          <button type="button" onClick={() => void refresh()} style={{ textDecoration: "underline", background: "none", border: "none", padding: 0 }}>
            Try again
          </button>
        </div>
      ) : status ? (
        <>
          <div style={line}>
            {status.locked ? "Locked after too many wrong PINs." : status.hasPin ? "PIN set." : "No PIN yet."}
            {status.eligible && status.login ? ` Staff code: ${status.login}` : ""}
          </div>
          {reason && <div style={line}>{reason}</div>}
          <div style={{ display: "grid", gap: 8 }}>
            {status.eligible && (
              <button className="btn" disabled={busy} onClick={setPin} style={{ opacity: busy ? 0.6 : 1 }}>
                {status.hasPin ? "Set a new PIN" : "Set PIN"}
              </button>
            )}
            {status.hasPin && (
              <button className="btn" disabled={busy} onClick={removePin} style={{ opacity: busy ? 0.6 : 1 }}>
                Remove PIN
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
