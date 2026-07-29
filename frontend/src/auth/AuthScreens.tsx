import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "./AuthContext";
import { signInErrorMessage } from "./loginErrors";
import { Button } from "../components/Button";
import { cn } from "../lib/utils";
import { api } from "../api/client";
import { useBranding } from "../hooks/useBranding";
import { CompanyMark } from "../components/CompanyMark";
import { HOUZS_COMPANY_CODE, shortCompanyName } from "../lib/branding";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { validatePasswordStrength } from "../lib/passwordStrength";
import { AmbientSnow } from "../components/AmbientSnow";
import { consumeCorrelated, correlatedFetch } from "../lib/requestCorrelation";
import { readRememberedEmail } from "../lib/rememberedEmail";

// NOTE: this module is lazy-loaded by auth/AuthGate.tsx — every screen here is
// unauthenticated-only UI, kept out of the initial bundle on purpose. AuthGate
// (the eager half: session splash + screen selection) lives in its own file.

// Logo lives in /public; the wordmark is black-on-transparent so it gets
// inverted to cream on the Nature Black canvas.
const LOGO_WORDMARK_SRC = "/logo-wordmark.png";
// brightness(0) flattens any anti-aliased edge to pure black, invert(1)
// lifts it to white — turns the black PNG into a clean cream mark on dark.
const INVERT_TO_CREAM = { filter: "brightness(0) invert(1)" } as const;

/**
 * Shared shell for the unauthenticated screens. The Nature Black brand
 * panel fills the whole viewport (cream wordmark + tagline + a faint
 * building-mark watermark); the form rides in a frosted "liquid glass"
 * floating card. Two columns on lg+ (brand left, card right); stacked and
 * centred below lg.
 */
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
  const year = new Date().getFullYear();
  const branding = useBranding();
  return (
    <div
      className="relative min-h-screen overflow-hidden text-sidebar"
      style={{
        background:
          "radial-gradient(130% 115% at 26% -12%, #1d2519 0%, #141b13 46%, #0c110b 100%)",
      }}
    >
      {/* Fine paper grain over the gradient for depth */}
      <div className="slab-grain pointer-events-none absolute inset-0 opacity-70" />
      {/* Two slow, counter-drifting pine glows = a living aurora behind the
          brand (no yellow). Parallax wrappers shift them with the cursor. */}
      <div className="pointer-events-none absolute left-[10%] top-[14%] h-[560px] w-[560px]">
        <div
          className="auth-drift absolute inset-0 rounded-full blur-[150px]"
          style={{
            background:
              "radial-gradient(circle, rgba(63,107,83,0.26), rgba(63,107,83,0) 70%)",
          }}
        />
      </div>
      <div className="pointer-events-none absolute bottom-[6%] right-[8%] h-[460px] w-[460px]">
        <div
          className="auth-drift2 absolute inset-0 rounded-full blur-[150px]"
          style={{
            background:
              "radial-gradient(circle, rgba(45,75,60,0.5), rgba(45,75,60,0) 70%)",
          }}
        />
      </div>
      {/* Ambient drifting snow — same particle effect as the mobile login */}
      <AmbientSnow />
      {/* Faint building wordmark watermark, bottom-left — the bundled Houzs
          asset, so HOUZS-only (another company's canvas stays clean). */}
      {branding.companyCode === HOUZS_COMPANY_CODE && (
        <img
          src={LOGO_WORDMARK_SRC}
          alt=""
          aria-hidden
          draggable={false}
          style={INVERT_TO_CREAM}
          className="pointer-events-none absolute -bottom-12 -left-10 w-[520px] max-w-[64vw] object-contain opacity-[0.045]"
        />
      )}

      <div className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center gap-14 px-6 py-12 lg:flex-row lg:justify-between lg:gap-10 lg:px-16">
        {/* Brand lockup — children rise in sequence */}
        <div className="w-full max-w-2xl text-center lg:text-left">
          <div
            className="animate-rise mb-7 flex items-center justify-center gap-2 lg:justify-start"
            style={{ animationDelay: "0ms" }}
          >
            <span className="h-px w-10 bg-accent" />
            <span className="text-[11px] font-semibold uppercase tracking-brand text-accent">
              {branding.companyName}
            </span>
          </div>
          {/* wordmark: rises in (entrance) → floats gently → a metallic
              sheen sweeps across it. Nested so the three motions don't
              fight over the `animation` property. */}
          <div
            className="animate-rise mx-auto inline-block lg:mx-0"
            style={{ animationDelay: "120ms" }}
          >
            <div className="auth-float relative inline-block overflow-hidden">
              <CompanyMark
                variant="wordmark"
                imgClassName="block h-24 w-auto max-w-[560px] object-contain drop-shadow-[0_10px_36px_rgba(0,0,0,0.5)] sm:h-28 xl:h-36"
                imgStyle={INVERT_TO_CREAM}
                uploadedImgClassName="block h-24 w-auto max-w-[560px] object-contain drop-shadow-[0_10px_36px_rgba(0,0,0,0.5)] sm:h-28 xl:h-36"
                textClassName="font-display block text-5xl font-bold tracking-tight text-sidebar-ink drop-shadow-[0_10px_36px_rgba(0,0,0,0.5)] sm:text-6xl xl:text-7xl"
              />
              {/* wide, blurred light band sweeping across — soft feathered
                  edges (no hard rectangle) */}
              <span className="auth-sheen pointer-events-none absolute -inset-y-12 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent blur-2xl" />
            </div>
          </div>
          <p
            className="animate-rise mx-auto mt-9 max-w-lg text-[15.5px] leading-relaxed text-sidebar-ink-soft lg:mx-0"
            style={{ animationDelay: "240ms" }}
          >
            The operations workspace for the {shortCompanyName(branding.companyName)}{" "}
            team — projects, logistics, and people in one place.
          </p>
        </div>

        {/* Liquid-glass floating card — dimmer frosted panel so it doesn't
            glare against the dark canvas */}
        <div
          className="animate-rise w-full max-w-[348px]"
          style={{ animationDelay: "360ms" }}
        >
          <div
            className="relative overflow-hidden rounded-[28px] border border-white/45 bg-white/[0.62] px-7 py-8 backdrop-blur-2xl backdrop-saturate-150"
            style={{
              boxShadow:
                "0 28px 70px -30px rgba(0,0,0,0.85), inset 0 1px 1px rgba(255,255,255,0.85), inset 0 -14px 30px rgba(255,255,255,0.10)",
            }}
          >
            {/* specular highlight catching the glass rim (top-left) */}
            <span className="pointer-events-none absolute -left-10 -top-14 h-40 w-48 rounded-full bg-white/45 blur-3xl" />
            {/* faint counter-highlight, bottom-right */}
            <span className="pointer-events-none absolute -bottom-12 -right-10 h-32 w-40 rounded-full bg-white/15 blur-3xl" />
            {/* brass hairline along the very top edge */}
            <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent" />

            <div className="relative">
              <div className="mb-1 flex items-center gap-2">
                <span className="h-px w-5 bg-accent" />
                <span className="text-[10px] font-semibold uppercase tracking-brand text-accent">
                  {eyebrow}
                </span>
              </div>
              <h1 className="font-display text-[25px] font-extrabold leading-tight tracking-tight text-ink">
                {title}
              </h1>
              <p className="mt-1.5 text-[12.5px] text-ink-secondary">{subtitle}</p>
              <div className="mt-7">{children}</div>
            </div>
          </div>
          <div className="mt-5 text-center text-[10px] uppercase tracking-brand text-sidebar-ink-soft lg:text-left">
            {year} {branding.companyName}
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20",
        props.className
      )}
    />
  );
}

/* Nick 2026-07-09 — password fields need an eye toggle so operators can
   verify what they typed. Wraps TextInput, flips its `type` between
   "password" and "text", parks a small icon button inside the input's
   right-pad (pr-10). Used by Login + Bootstrap + Set-password screens
   below; MobileLogin has its own copy of the pattern for its inline
   input. */
function PasswordInput(
  props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">,
) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <TextInput
        {...props}
        type={show ? "text" : "password"}
        className={cn(props.className, "pr-10")}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        tabIndex={-1}
      >
        {show ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Login
// ──────────────────────────────────────────────────────────
export function LoginScreen() {
  const { login, verifyTotpLogin } = useAuth();
  // Remember the account: pre-fill the last email that signed in on THIS device
  // (owner: "remember me remember 不到我的户口"). Only the email is stored, never
  // the password — so the operator doesn't retype their account every time.
  const [email, setEmail] = useState(() => {
    return readRememberedEmail();
  });
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Set once a password login returns a 2FA challenge — switches to the code step.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await login(email, password, remember);
      if (res.kind === "totp") setChallenge(res.challenge);
    } catch (e: any) {
      // Wording lives in auth/loginErrors — ONE source for desktop and mobile.
      // Read the comment there before changing it: "Password incorrect." was
      // both a false statement on a mistyped email and an account-existence
      // oracle if it were ever made accurate.
      setErr(signInErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await verifyTotpLogin(challenge!, code.trim());
    } catch (e: any) {
      /* A 2FA 401 is not one thing: wrong code, expired 30s window, an EXPIRED
         CHALLENGE ("start again" — retyping codes is futile), or 2FA broken for
         the account. The backend sends a distinct plain sentence for each, and
         the old blanket "That code didn't work" here overwrote them all — the
         expired-challenge case told people to keep trying codes forever. Show
         the server's sentence; the fallback only covers a non-HTTP throw. */
      setErr(e?.message || "That code didn't work — try the current code or a backup code.");
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <AuthShell
        eyebrow="Two-Factor"
        title="Enter your code"
        subtitle="Open your authenticator app and enter the 6-digit code. You can also use a backup code."
      >
        <form onSubmit={submitCode} className="space-y-4">
          <div>
            <FieldLabel>Authentication code</FieldLabel>
            <TextInput
              inputMode="text"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
              autoFocus
            />
          </div>
          {err && <div className="text-[11px] text-err">{err}</div>}
          <Button variant="brass" className="w-full" disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode("");
                setErr(null);
              }}
              className="text-[11px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Back to sign in
            </button>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Sign In"
      title="Welcome back"
      subtitle="Enter your credentials to access the workspace."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel>Email</FieldLabel>
          <TextInput
            type="email"
            name="email"
            /* Login USERNAME token — NOT "email" (a contact-info token that
               makes browsers offer the address book / "Manage addresses"
               instead of the saved login, so the paired password is never
               offered). "username" pairs with current-password below so the
               browser's password manager fills BOTH in one click. */
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@houzscentury.com"
            required
            autoFocus={!email}
          />
        </div>
        <div>
          <FieldLabel>Password</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            autoFocus={!!email}
          />
          <div className="mt-2 flex items-center justify-between">
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              Remember me on this device
            </label>
            <a
              href="#forgot"
              className="text-[11px] text-ink-muted underline-offset-2 transition-colors hover:text-accent hover:underline"
            >
              Forgot password?
            </a>
          </div>
        </div>
        {err && <div className="text-[11px] text-err">{err}</div>}
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign In"}
        </Button>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Forgot password (self-service)
// ──────────────────────────────────────────────────────────
export function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/api/auth/forgot-password", {
        email: email.toLowerCase().trim(),
      });
    } catch {
      // Deliberately swallowed — the endpoint always answers ok and the
      // confirmation below stays generic (anti-enumeration).
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <AuthShell
        eyebrow="Password Reset"
        title="Check your email"
        subtitle={`If an account exists for ${email || "that address"}, we've sent a reset link. It expires in 1 hour.`}
      >
        <a
          href="#"
          className="text-[12px] font-semibold text-accent underline-offset-2 hover:underline"
        >
          Back to sign in
        </a>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Password Reset"
      title="Forgot your password?"
      subtitle="Enter your account email and we'll send you a link to set a new one."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel>Email</FieldLabel>
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@houzscentury.com"
            required
            autoFocus
          />
        </div>
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </Button>
        <div className="text-center">
          <a
            href="#"
            className="text-[11px] text-ink-muted underline-offset-2 hover:text-accent hover:underline"
          >
            Back to sign in
          </a>
        </div>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Bootstrap (first owner)
// ──────────────────────────────────────────────────────────
export function BootstrapScreen() {
  const { bootstrap } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const strength = validatePasswordStrength(password, email);
    if (!strength.ok) {
      setErr(strength.error || "Password is too weak");
      return;
    }
    setBusy(true);
    try {
      await bootstrap(email, name, password);
    } catch (e: any) {
      setErr(e?.message || "We couldn't create the owner account. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="First Run"
      title="Create the first owner"
      subtitle="No accounts exist yet. The first user becomes the workspace owner with full access."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <FieldLabel>Your name</FieldLabel>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            required
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>Email</FieldLabel>
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@houzscentury.com"
            required
          />
        </div>
        <div>
          <FieldLabel>Password (min 12 chars)</FieldLabel>
          <PasswordInput
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Choose a strong password"
            required
          />
          <PasswordStrengthMeter password={password} email={email} />
        </div>
        {err && <div className="text-[11px] text-err">{err}</div>}
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Create Owner Account"}
        </Button>
      </form>
    </AuthShell>
  );
}

// ──────────────────────────────────────────────────────────
// Accept invitation
// ──────────────────────────────────────────────────────────
export function AcceptInviteScreen() {
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();
  // Token arrives via the real public route (/invite/:token); the old
  // email links used a #invite= hash, still accepted for backward-compat.
  const { token: routeToken } = useParams<{ token: string }>();
  const baseUrl =
    (import.meta.env.VITE_API_URL as string) ||
    (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Invitation metadata (email + role/position + preset name) fetched
  // from the preflight endpoint so the invitee sees who they're joining
  // as instead of pasting an opaque token.
  const [meta, setMeta] = useState<{ email: string; role_name: string } | null>(
    null
  );

  // Resolve the token from the path param first (/invite/:token), falling
  // back to the legacy #invite= hash, then preflight it so we can pre-fill
  // the name/email and show the role they're invited as.
  useEffect(() => {
    let t = routeToken ? decodeURIComponent(routeToken) : "";
    if (!t) {
      const m = window.location.hash.match(/invite=([^&]+)/);
      if (m) t = decodeURIComponent(m[1]);
    }
    if (!t) return;
    setToken(t);
    correlatedFetch(`${baseUrl}/api/auth/invite/${encodeURIComponent(t)}`)
      .then(async (r) => {
        if (!r.ok) return;
        const d = await consumeCorrelated(r, () => r.json() as Promise<{
          email: string;
          name: string | null;
          role_name: string;
        }>);
        setMeta({ email: d.email, role_name: d.role_name });
        if (d.name) setName(d.name);
      })
      .catch(() => {
        /* fall back to the manual token form below */
      });
  }, [baseUrl, routeToken]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const strength = validatePasswordStrength(password, meta?.email);
    if (!strength.ok) {
      setErr(strength.error || "Password is too weak");
      return;
    }
    setBusy(true);
    try {
      await acceptInvite(token, name, password);
      // RootApp reads the live Router location, so this crosses from the
      // invite-only tree into the authenticated staff/mobile shell.
      navigate("/", { replace: true });
    } catch (e: any) {
      setErr(e?.message || "Couldn't accept invitation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Join Workspace"
      title="Accept your invitation"
      subtitle={
        meta
          ? `You've been invited to join as ${meta.role_name}. Set your name and password to continue.`
          : "Paste the invitation token you were given and set your password."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {meta ? (
          <div className="rounded-md border border-border bg-bg/60 px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Email
            </div>
            <div className="text-[13px] font-semibold text-ink">
              {meta.email}
            </div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
              {meta.role_name}
            </div>
          </div>
        ) : (
          <div>
            <FieldLabel>Invitation Token</FieldLabel>
            <TextInput
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste your token"
              className="font-mono text-[11px]"
              required
              autoFocus
            />
          </div>
        )}
        <div>
          <FieldLabel>Your name</FieldLabel>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            required
            autoFocus={!!meta}
          />
        </div>
        <div>
          <FieldLabel>Choose a password (min 12 chars)</FieldLabel>
          <PasswordInput
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          <PasswordStrengthMeter password={password} email={meta?.email} />
        </div>
        {err && <div className="text-[11px] text-err">{err}</div>}
        <Button variant="brass" className="w-full" disabled={busy}>
          {busy ? "Joining…" : "Join Workspace"}
        </Button>
      </form>
    </AuthShell>
  );
}
