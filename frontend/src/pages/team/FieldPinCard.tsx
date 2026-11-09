import { useEffect, useState } from "react";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { fmtDateTime } from "../../vendor/shared/format";
import { Eyebrow } from "./teamShared";
import {
  FIELD_PIN_LENGTH,
  clearFieldPin,
  fetchFieldPinStatus,
  fieldPinReasonText,
  setFieldPin,
  showsFieldPin,
  type FieldPinStatus,
} from "../../lib/fieldPin";

/* Crew PIN sign-in, on the member's profile. Drivers and helpers with no usable
 * email sign in with their staff code and a 6-digit PIN set here. The card
 * never shows a PIN back — the server keeps a hash and answers set / not set,
 * and whether wrong tries have locked it. A failed status read says so instead
 * of reading as "no PIN", so nobody overwrites a working PIN blind. */
export function FieldPinCard({ userId, memberName }: { userId: number; memberName: string }) {
  const toast = useToast();
  const dialog = useDialog();
  const [status, setStatus] = useState<FieldPinStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [entering, setEntering] = useState(false);
  const [pin, setPin] = useState("");
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
    setEntering(false);
    setPin("");
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over userId only
  }, [userId]);

  if (!loadError && !showsFieldPin(status)) return null;

  async function submit() {
    if (pin.length !== FIELD_PIN_LENGTH || busy) return;
    setBusy(true);
    try {
      const res = await setFieldPin(userId, pin);
      toast.success(`Crew PIN set for ${memberName}. They sign in as ${res.login}.`);
      setPin("");
      setEntering(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set the PIN");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    const ok = await dialog.confirm(
      `Remove the crew PIN for ${memberName}?\n\nThey are signed out of the crew screens and cannot sign in with a PIN until a new one is set.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await clearFieldPin(userId);
      toast.success(`Crew PIN removed for ${memberName}`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the PIN");
    } finally {
      setBusy(false);
    }
  }

  const reason = status ? fieldPinReasonText(status) : null;

  return (
    <div className="rounded-lg border border-border bg-surface shadow-stone">
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
        <Eyebrow>Crew PIN sign-in</Eyebrow>
        {status && (
          <Badge tone={status.locked ? "error" : status.hasPin ? "success" : "warning"} caseless>
            {status.locked ? "Locked" : status.hasPin ? "PIN set" : "No PIN yet"}
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-3 p-5">
        <p className="mb-0 text-[12.5px] leading-relaxed text-ink-secondary">
          For a driver or helper with no usable email. They sign in with their staff code and a
          6-digit PIN, and reach only the delivery and project crew screens.
        </p>
        {loadError ? (
          <div className="rounded-md border border-err bg-err-bg px-3 py-2 text-[12px] text-err">
            Could not check the crew PIN.{" "}
            <button type="button" className="underline" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : status ? (
          <>
            {status.login && status.eligible && (
              <div className="text-[12px] text-ink">
                Staff code to sign in with: <span className="font-mono font-semibold">{status.login}</span>
              </div>
            )}
            {reason && (
              <div className="rounded-md border border-accent bg-warning-bg px-3 py-2 text-[12px] text-warning-text">
                {reason}
              </div>
            )}
            {status.locked && status.lockedUntil && (
              <div className="text-[12px] text-err">
                Locked after too many wrong PINs until {fmtDateTime(status.lockedUntil)}. Setting a new PIN unlocks it.
              </div>
            )}
            {status.hasPin && status.setAt && (
              <div className="text-[12px] text-ink-muted">Last set {fmtDateTime(status.setAt)}</div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {entering ? (
                <>
                  <input
                    autoFocus
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label="New 6-digit crew PIN"
                    placeholder="------"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, FIELD_PIN_LENGTH))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submit();
                      if (e.key === "Escape") {
                        setEntering(false);
                        setPin("");
                      }
                    }}
                    className="h-[38px] w-[132px] rounded-md border border-border bg-surface px-3 text-center font-mono text-[15px] tracking-[0.35em] text-ink outline-none focus:border-primary"
                  />
                  <Button variant="primary" disabled={pin.length !== FIELD_PIN_LENGTH || busy} onClick={() => void submit()}>
                    {busy ? "Saving…" : status.hasPin ? "Replace PIN" : "Set PIN"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEntering(false);
                      setPin("");
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {status.eligible && (
                    <Button variant="secondary" onClick={() => setEntering(true)}>
                      {status.hasPin ? "Set a new PIN" : "Set PIN"}
                    </Button>
                  )}
                  {status.hasPin && (
                    <Button variant="ghost" disabled={busy} onClick={() => void clear()}>
                      Remove PIN
                    </Button>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
