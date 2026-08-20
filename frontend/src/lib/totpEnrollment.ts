// ---------------------------------------------------------------------------
// totpEnrollment — the self-service two-factor state machine, once.
//
// WHY THIS FILE EXISTS. The whole TOTP surface used to live inside
// `pages/Profile.tsx`'s TwoFactorSection: a desktop-only component. A phone-only
// member could ANSWER the challenge at login (MobileLogin) but could never
// enrol, never see how many backup codes were left, and — the part that is a
// lockout rather than an inconvenience — could never DISABLE 2FA after losing
// the authenticator. With no PC to hand, the account was gone.
//
// The fix is not a second copy of the flow on the phone. An auth flow written
// twice is an auth flow that will diverge, and the half that diverges quietly is
// the gate. So the state machine lives here and BOTH surfaces drive it:
//   · desktop  pages/Profile.tsx        → TwoFactorSection
//   · mobile   mobile/MobileTwoFactorCard.tsx
// Each owns only its own markup. Every endpoint call, every transition and every
// refusal is this file.
//
// WHAT IS DELIBERATELY NOT STORED. The setup secret and the backup codes exist
// in React state and nowhere else — no localStorage, no sessionStorage, no
// cookie, no console. They are rendered so the operator can copy them into an
// authenticator / password manager, and they die with the component. The
// `never writes a secret or a backup code to storage` case in
// mobile/mobileTotpSurface.test.tsx is what holds that.
//
// ONE BEHAVIOUR CHANGED IN THE MOVE, ON PURPOSE. The desktop's status read was
//
//     try { setStatus(await api.get(...)) } catch { setStatus({ enabled: false, … }) }
//
// A failed read therefore rendered "Not enabled" plus an "Enable 2FA" button to
// a member whose 2FA is ON — the read's failure disguised as an answer, which is
// the swallowed-read class in `backend/scripts/lib/swallowed-read-scan.mjs`. It
// matters more on a phone, where a blip is ordinary. `statusError` is now bound
// and surfaced, and `status` stays null: the surfaces say they could not check
// rather than saying it is off.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export type TotpStatus = { enabled: boolean; backup_codes_remaining: number };
export type TotpSetup = { secret: string; otpauth_uri: string };

/** Enrolment phase. `idle` covers both "off" and "on" — `status.enabled` says which. */
export type TotpPhase = "idle" | "enrolling";

export type TotpEnrollment = {
  /** null until the first status read lands, and null again if it fails. */
  status: TotpStatus | null;
  /** Non-null when the status read failed — NOT the same as "2FA is off". */
  statusError: string | null;
  phase: TotpPhase;
  /** The pending enrolment's secret + otpauth URI. In memory only. */
  setup: TotpSetup | null;
  /** Shown exactly once, right after enabling. In memory only. */
  backupCodes: string[] | null;
  busy: boolean;
  /** Last action error, for the surface to render. Never a thrown promise. */
  error: string | null;
  reload: () => Promise<void>;
  begin: () => Promise<void>;
  cancel: () => void;
  /** @returns true when 2FA was turned on. */
  enable: (code: string) => Promise<boolean>;
  /** The code is a CURRENT 6-digit code or a backup code — the server verifies
   *  it. Callers must collect it; there is no un-gated path to this. */
  disable: (code: string) => Promise<boolean>;
  /** The operator's "I have saved them" acknowledgement. The ONLY way the codes
   *  leave the screen — nothing clears them on a timer or a re-render. */
  dismissCodes: () => void;
};

const messageOf = (e: unknown, fallback: string): string =>
  (e as { message?: string } | null)?.message || fallback;

export function useTotpEnrollment(): TotpEnrollment {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [phase, setPhase] = useState<TotpPhase>("idle");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await api.get<TotpStatus>("/api/totp/status"));
      setStatusError(null);
    } catch (e: unknown) {
      // Bound, not swallowed — see the header. "We could not check" is a
      // different sentence from "it is off", and only one of them is true here.
      setStatus(null);
      setStatusError(messageOf(e, "We couldn't check your two-factor status."));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const begin = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setSetup(await api.post<TotpSetup>("/api/totp/setup", {}));
      setPhase("enrolling");
    } catch (e: unknown) {
      setError(messageOf(e, "We couldn't start the two-factor setup. Please try again."));
    } finally {
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(() => {
    setPhase("idle");
    setSetup(null);
    setError(null);
  }, []);

  const enable = useCallback(
    async (code: string) => {
      setError(null);
      setBusy(true);
      try {
        const res = await api.post<{ backup_codes: string[] }>("/api/totp/enable", {
          code: code.trim(),
        });
        setBackupCodes(res.backup_codes);
        setPhase("idle");
        setSetup(null);
        await reload();
        return true;
      } catch (e: unknown) {
        /* Match on the status FLAG, not on the message text. The humanized
           message no longer embeds status codes, so the old `includes("400")`
           branch was dead — and the server's own sentence ("That code didn't
           match…") is already the right wording, so prefer it. */
        setError(
          (e as { status?: number } | null)?.status === 400
            ? messageOf(e, "That code didn't match — try again.")
            : messageOf(e, "We couldn't turn on two-factor. Please try again."),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const disable = useCallback(
    async (code: string) => {
      setError(null);
      setBusy(true);
      try {
        await api.post("/api/totp/disable", { code: code.trim() });
        setBackupCodes(null);
        await reload();
        return true;
      } catch (e: unknown) {
        setError(messageOf(e, "Failed to disable — check the code."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const dismissCodes = useCallback(() => setBackupCodes(null), []);

  return {
    status, statusError, phase, setup, backupCodes, busy, error,
    reload, begin, cancel, enable, disable, dismissCodes,
  };
}
