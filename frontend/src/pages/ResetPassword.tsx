import { useEffect, useState, type ReactNode } from "react";
import {
  defaultBrandingForCompany,
  hostDefaultCompanyCode,
  shortCompanyName,
} from "../lib/branding";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { validatePasswordStrength } from "../lib/passwordStrength";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from "../lib/requestCorrelation";

/**
 * Public reset-password screen — lives at /reset/:token. Bypasses the
 * authenticated app shell (main.tsx routes /reset/* here unprompted).
 * Fetches the token's metadata (email) to show "Reset for alice@…",
 * then submits a new password. On success, bounces back to /login.
 */

// PROD default is same-origin (Pages Function proxies /api/* to the Worker) —
// reset links open on phones where *.workers.dev can be carrier-blocked.
const baseUrl =
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

class ResetPasswordDisplayError extends Error {}

/** Build the public reset screen's friendly HTTP error without dropping the
 * response's correlation id. A malformed error body keeps the plain fallback;
 * support can still resolve the exact Worker request through
 * requestIdFromError(). */
export async function resetPasswordResponseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  let message = fallback;
  try {
    const body = await consumeCorrelated(
      response,
      () => response.json() as Promise<{ error?: unknown }>,
    );
    if (typeof body.error === "string" && body.error.trim()) message = body.error;
  } catch {
    // Non-JSON/undecodable error response: retain the friendly fallback. The
    // correlated error returned below still carries this response's id.
  }
  return correlateError(new ResetPasswordDisplayError(message), requestIdFromResponse(response));
}

function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="paper-grain flex min-h-screen items-center justify-center px-4 py-12">
      <div className="relative w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-surface px-8 py-10 shadow-slab animate-rise">
        <span className="pointer-events-none absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        <div className="mb-1 flex items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <span className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            {eyebrow}
          </span>
        </div>
        <h1 className="font-display text-[24px] font-extrabold leading-tight tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-1.5 text-[12.5px] text-ink-secondary">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <div className="mt-8 border-t border-border-subtle pt-4 text-[10px] uppercase tracking-brand text-ink-muted">
          {shortCompanyName(defaultBrandingForCompany(hostDefaultCompanyCode()).companyName)} · Operations
        </div>
      </div>
    </div>
  );
}

export function ResetPassword() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; email: string; name: string | null }
    | { kind: "error"; message: string }
    | { kind: "done" }
  >({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Verify the token up front so bad/expired links fail fast.
  useEffect(() => {
    if (!token) {
      setState({ kind: "error", message: "Missing token." });
      return;
    }
    correlatedFetch(`${baseUrl}/api/auth/reset/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.ok) {
          let d: { email: string; name: string | null };
          try {
            d = await consumeCorrelated(
              r,
              () => r.json() as Promise<{ email: string; name: string | null }>,
            );
          } catch {
            throw correlateError(
              new ResetPasswordDisplayError(
                "We couldn't read the server response. Please try the link again.",
              ),
              requestIdFromResponse(r),
            );
          }
          setState({ kind: "ready", ...d });
        } else {
          throw await resetPasswordResponseError(r, "Invalid link");
        }
      })
      .catch((error: unknown) => setState({
        kind: "error",
        message: error instanceof ResetPasswordDisplayError
          ? error.message
          : "We couldn't reach the server. Please check your connection and try again.",
      }));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const strength = validatePasswordStrength(
      password,
      state.kind === "ready" ? state.email : undefined
    );
    if (!strength.ok) {
      setSubmitError(strength.error || "Password is too weak.");
      return;
    }
    if (password !== confirmPwd) {
      setSubmitError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await correlatedFetch(`${baseUrl}/api/auth/reset/${encodeURIComponent(token!)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        throw await resetPasswordResponseError(
          r,
          "We couldn't reset your password. The link may have expired — please request a new one.",
        );
      }
      setState({ kind: "done" });
    } catch (e: any) {
      // A thrown Error above already carries a plain sentence; a bare network
      // failure (TypeError "Failed to fetch") must not leak — show plain words.
      setSubmitError(
        e?.name === "TypeError"
          ? "We couldn't reach the server. Please check your connection and try again."
          : e?.message || "We couldn't reset your password. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Checking your link…"
        subtitle="One moment."
      >
        <div className="h-6 w-full animate-pulse rounded bg-border" />
      </AuthShell>
    );
  }

  if (state.kind === "error") {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Link unavailable"
        subtitle={state.message}
      >
        <Button variant="secondary" onClick={() => navigate("/")}>
          Go to login
        </Button>
      </AuthShell>
    );
  }

  if (state.kind === "done") {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Password updated"
        subtitle="You can now sign in with your new password."
      >
        <Button onClick={() => navigate("/")}>Go to login</Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Password Reset"
      title={state.name ? `Hi ${state.name.split(" ")[0]},` : "Set a new password"}
      subtitle={`Choose a new password for ${state.email}. Minimum 12 characters.`}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            New password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="new-password"
            className={cn(
              "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
            )}
          />
          <PasswordStrengthMeter password={password} email={state.email} />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Confirm password
          </label>
          <input
            type="password"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
            autoComplete="new-password"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        {submitError && (
          <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
            {submitError}
          </div>
        )}
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Saving…" : "Update password"}
        </Button>
      </form>
    </AuthShell>
  );
}
