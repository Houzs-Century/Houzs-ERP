import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { cn } from "../../lib/utils";
import { fmtDate } from "../../vendor/shared/format";
import { Eyebrow } from "./teamShared";


export type PinStatus = {
  hasStaffRow: boolean;
  staffActive: boolean;
  positionSlug: string | null;
  positionEligible: boolean;
  hasPin: boolean;
  updatedAt: string | null;
};

const PIN_LEN = 6;

export function PosPinCard({
  userId,
  memberName,
  canManage,
  pendingSave,
  autoOpen,
}: {
  userId: number;
  memberName: string;
  canManage: boolean;
  pendingSave: boolean;
  autoOpen: boolean;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [entering, setEntering] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoOpened = useRef(false);

  async function refresh() {
    if (pendingSave) return;
    try {
      setStatus(await api.get<PinStatus>(`/api/pos/admin-pin-status/${userId}`));
      setLoadError(false);
    } catch {
      setStatus(null);
      setLoadError(true);
    }
  }

  useEffect(() => {
    autoOpened.current = false;
    setEntering(false);
    setPin("");
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh closes over exactly these two
  }, [userId, pendingSave]);

  useEffect(() => {
    if (!autoOpen || autoOpened.current || !canManage) return;
    if (!status || status.hasPin || !status.hasStaffRow) return;
    autoOpened.current = true;
    setEntering(true);
  }, [autoOpen, canManage, status]);

  async function submit() {
    if (pin.length !== PIN_LEN || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/pos/admin-set-pin/${userId}`, { pin });
      toast.success("POS PIN set for " + memberName);
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
      "Remove the POS PIN for " +
        memberName +
        "?\n\nThey cannot sign in at the 2990 tablet until a new one is set.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/api/pos/admin-reset-pin/${userId}`);
      toast.success("POS PIN removed for " + memberName);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the PIN");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface shadow-stone">
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
        <Eyebrow>POS Access &middot; 2990&rsquo;s Home</Eyebrow>
        {status && !pendingSave && (
          <Badge tone={status.hasPin ? "success" : "warning"} caseless>
            {status.hasPin ? "PIN set" : "No PIN yet"}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-3 p-5">
        <p className="mb-0 text-[12.5px] leading-relaxed text-ink-secondary">
          The 2990 showroom tablet signs a salesperson in with a 6-digit PIN, not a
          password. Set one here and {memberName} can pick their name on the tablet
          straight away; they can change it themselves afterwards.
        </p>

        {pendingSave ? (
          <div className="rounded-md border border-accent bg-warning-bg px-3 py-2 text-[12px] text-warning-text">
            Save the assignment first — the PIN attaches to the saved record.
          </div>
        ) : loadError ? (
          <div className="rounded-md border border-err bg-err-bg px-3 py-2 text-[12px] text-err">
            Could not check whether a PIN is already set.{" "}
            <button type="button" className="underline" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : status && !status.hasStaffRow ? (
          <div className="rounded-md border border-err bg-err-bg px-3 py-2 text-[12px] text-err">
            This member has no sales profile yet, so a PIN cannot be issued. One is
            created with the account — re-open this profile once they have signed in.
          </div>
        ) : (
          <>
            {status && !status.staffActive && (
              <div className="rounded-md border border-accent bg-warning-bg px-3 py-2 text-[12px] text-warning-text">
                Their sales profile is inactive, so the tablet will not list them even
                with a PIN set.
              </div>
            )}
            {status?.hasPin && status.updatedAt && (
              <div className="text-[12px] text-ink-muted">
                Last changed {fmtDate(status.updatedAt)}
              </div>
            )}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                {entering ? (
                  <>
                    <input
                      ref={inputRef}
                      autoFocus
                      inputMode="numeric"
                      autoComplete="off"
                      aria-label="6-digit POS PIN"
                      placeholder="------"
                      value={pin}
                      onChange={(e) =>
                        setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_LEN))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submit();
                        if (e.key === "Escape") {
                          setEntering(false);
                          setPin("");
                        }
                      }}
                      className={cn(
                        "h-[38px] w-[132px] rounded-md border border-border bg-surface px-3",
                        "text-center font-mono text-[15px] tracking-[0.35em] text-ink",
                        "outline-none focus:border-primary",
                      )}
                    />
                    <Button
                      variant="primary"
                      disabled={pin.length !== PIN_LEN || busy}
                      onClick={() => void submit()}
                    >
                      {busy ? "Saving…" : status?.hasPin ? "Replace PIN" : "Set PIN"}
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
                    <Button variant="secondary" onClick={() => setEntering(true)}>
                      {status?.hasPin ? "Change PIN" : "Set PIN"}
                    </Button>
                    {status?.hasPin && (
                      <Button variant="ghost" disabled={busy} onClick={() => void clear()}>
                        Remove PIN
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
