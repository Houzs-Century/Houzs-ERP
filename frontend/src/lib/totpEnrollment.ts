
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export type TotpStatus = { enabled: boolean; backup_codes_remaining: number };
export type TotpSetup = { secret: string; otpauth_uri: string };

/** Enrolment phase. `idle` covers both "off" and "on" — `status.enabled` says which. */
export type TotpPhase = "idle" | "enrolling";

export type TotpEnrollment = {
  status: TotpStatus | null;
  statusError: string | null;
  phase: TotpPhase;
  setup: TotpSetup | null;
  backupCodes: string[] | null;
  busy: boolean;
  error: string | null;
  reload: () => Promise<void>;
  begin: () => Promise<void>;
  cancel: () => void;
  enable: (code: string) => Promise<boolean>;
  disable: (code: string) => Promise<boolean>;
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
