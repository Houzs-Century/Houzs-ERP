import { useState } from "react";
import { useAuth } from "./AuthContext";


export const CREW_LOGIN_PREFIX = "EMP-";
export const CREW_PIN_LENGTH = 6;

/** What the staff-code box keeps from a typed or pasted value. */
export function crewCodeInput(raw: string): string {
  const s = raw.toUpperCase().replace(/\s+/g, "");
  const rest = s.startsWith(CREW_LOGIN_PREFIX) ? s.slice(CREW_LOGIN_PREFIX.length) : s.startsWith("EMP") ? s.slice(3) : s;
  return rest.replace(/[^0-9-]/g, "").slice(0, 9);
}

export function CrewPinForm({
  onTotp,
  onBack,
}: {
  onTotp: (challenge: string) => void;
  onBack: () => void;
}) {
  const { pinLogin } = useAuth();
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = /^\d/.test(code) && pin.length === CREW_PIN_LENGTH && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await pinLogin(`${CREW_LOGIN_PREFIX}${code}`, pin);
      if (res.kind === "totp") onTotp(res.challenge);
    } catch (e) {
      setPin("");
      setErr(e instanceof Error && e.message ? e.message : "Could not sign in. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const box =
    "h-11 w-full rounded-md border border-border bg-surface px-3 text-[15px] text-ink outline-none focus:border-accent";

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Crew sign-in">
      <div>
        <label htmlFor="crew-code" className="mb-1 block text-[11px] font-medium text-ink-muted">
          Staff code
        </label>
        <div className="flex items-stretch">
          <span className="flex items-center rounded-l-md border border-r-0 border-border bg-surface-2 px-3 font-mono text-[15px] text-ink-secondary">
            {CREW_LOGIN_PREFIX}
          </span>
          <input
            id="crew-code"
            name="username"
            className={`${box} rounded-l-none font-mono`}
            inputMode="numeric"
            autoComplete="username"
            placeholder="0042"
            value={code}
            onChange={(e) => setCode(crewCodeInput(e.target.value))}
            autoFocus
            required
          />
        </div>
      </div>
      <div>
        <label htmlFor="crew-pin" className="mb-1 block text-[11px] font-medium text-ink-muted">
          PIN
        </label>
        <input
          id="crew-pin"
          name="password"
          type="password"
          className={`${box} text-center font-mono tracking-[0.4em]`}
          inputMode="numeric"
          autoComplete="current-password"
          placeholder="••••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, CREW_PIN_LENGTH))}
          required
        />
        <div className="mt-1 text-[11px] text-ink-muted">
          Forgot your PIN? Ask the office to set a new one.
        </div>
      </div>
      {err && (
        <div role="alert" className="text-[11px] text-err">
          {err}
        </div>
      )}
      <button
        type="submit"
        disabled={!ready}
        className="h-11 w-full rounded-md bg-accent text-[14px] font-medium text-white disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <div className="text-center">
        <button
          type="button"
          onClick={onBack}
          className="text-[11px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
        >
          Sign in with email instead
        </button>
      </div>
    </form>
  );
}
