import { useState, useEffect, useRef } from "react";
import { User as UserIcon, KeyRound, LogOut, Bell, Camera, Trash2, ShieldCheck } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/Button";
import { StatusDot } from "../components/StatusDot";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { api } from "../api/client";
import { useProfilePicture } from "../lib/profilePicture";
import { useTotpEnrollment } from "../lib/totpEnrollment";
import { formatDate, relativeTime, cn } from "../lib/utils";
import {
  requestBrowserNotificationPermission,
  setBrowserNotificationPreference,
  useBrowserNotificationPermission,
  useBrowserNotificationPreference,
} from "../lib/browserNotificationPreference";
import { PasswordStrengthMeter } from "../components/PasswordStrengthMeter";
import { validatePasswordStrength } from "../lib/passwordStrength";

/**
 * Self-service profile page for every authenticated staff user.
 *
 * Two concerns, two sections:
 *   1. Identity — display name (editable), email + role (read-only).
 *      Email/role changes are privileged; they live in the Team page.
 *   2. Password — change with current-password verification.
 *
 * Intentionally small and boring. Nothing role-specific, nothing
 * module-specific. Driver-focused fields live in DriverProfile.
 */
export function Profile() {
  const { user, reload, logout } = useAuth();
  const toast = useToast();

  const [name, setName] = useState(user?.name || "");
  const [savingName, setSavingName] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /* The compress-weigh-PUT path, the 1000px cap and the 5 MB refusal moved to
     `lib/profilePicture` so the phone shares them instead of re-typing them. */
  const pic = useProfilePicture(reload);
  const picBusy = pic.busy;

  useEffect(() => {
    setName(user?.name || "");
  }, [user?.name]);

  async function uploadPic(rawFile: File) {
    const err = await pic.upload(rawFile);
    if (err) toast.error(err);
    else toast.success("Profile picture updated");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function removePic() {
    if (!user?.profile_pic_r2_key) return;
    const err = await pic.remove();
    if (err) toast.error(err);
    else toast.success("Profile picture removed");
  }

  async function saveName() {
    if (!name.trim() || name === user?.name) return;
    setSavingName(true);
    try {
      await api.patch("/api/auth/me", { name: name.trim() });
      await reload();
      toast.success("Display name updated");
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  if (!user) {
    return null;
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        eyebrow="Account"
        title="Your Profile"
        description="Display name, password, and account info."
      />

      {/* ── Identity ─────────────────────────────── */}
      <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
        <div className="mb-5 flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar
              userId={user.id}
              hasImage={user.profile_pic_r2_key}
              name={user.name}
              email={user.email}
              size={72}
              ring
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={picBusy}
              className={cn(
                "absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border border-border bg-surface text-ink-secondary shadow-stone transition-colors hover:bg-accent hover:text-white",
                picBusy && "opacity-50",
              )}
              title="Change profile picture"
              aria-label="Change profile picture"
            >
              <Camera size={13} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPic(f);
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Identity
            </h2>
            <div className="truncate font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
              {user.name || user.email}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
              <span className="inline-flex items-center gap-1">
                <UserIcon size={11} />
                {picBusy
                  ? "Uploading…"
                  : user.profile_pic_r2_key
                  ? "Click the camera to replace · max 5 MB"
                  : "Add a photo so teammates recognise you"}
              </span>
              {user.profile_pic_r2_key && !picBusy && (
                <button
                  type="button"
                  onClick={removePic}
                  className="inline-flex items-center gap-0.5 text-err transition-colors hover:underline"
                >
                  <Trash2 size={11} /> remove
                </button>
              )}
            </div>
          </div>
          <div className="self-start">
            <StatusDot
              variant={user.status === "active" ? "synced" : "neutral"}
              label={user.status}
            />
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Display Name
            </label>
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <Button
                variant="primary"
                onClick={saveName}
                disabled={savingName || !name.trim() || name === user.name}
              >
                {savingName ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label="Email">
              <span className="font-mono text-[12px]">{user.email}</span>
            </InfoRow>
            <InfoRow label="Role">
              <span className="rounded bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-accent-ink">
                {user.role_name}
              </span>
            </InfoRow>
            {user.joined_at && (
              <InfoRow label="Joined">
                {formatDate(user.joined_at)}
                <span className="ml-1 text-ink-muted">
                  ({relativeTime(user.joined_at)})
                </span>
              </InfoRow>
            )}
            {user.last_login_at && (
              <InfoRow label="Last Login">
                {relativeTime(user.last_login_at)}
              </InfoRow>
            )}
          </div>
        </div>
      </section>

      {/* ── Notifications ────────────────────────── */}
      <NotificationsSection />

      {/* ── Change password ──────────────────────── */}
      <PasswordSection />

      {/* ── Two-factor authentication ────────────── */}
      <TwoFactorSection />

      {/* ── Footer — sign out ────────────────────── */}
      <section className="rounded-md border border-border bg-surface p-6 shadow-stone">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Session
            </h2>
            <div className="mt-1 text-[12px] text-ink-secondary">
              Sign out of this device. Other devices stay signed in.
            </div>
          </div>
          <Button
            variant="secondary"
            icon={<LogOut size={14} />}
            onClick={() => logout()}
          >
            Sign out
          </Button>
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}

function NotificationsSection() {
  const toast = useToast();
  const enabled = useBrowserNotificationPreference();
  const permission = useBrowserNotificationPermission();

  async function toggle() {
    if (permission === "unsupported") {
      toast.error("This browser doesn't support desktop notifications");
      return;
    }
    if (enabled) {
      // Turn OFF — just flip the preference. We don't revoke the
      // browser permission; that's the user's OS-level choice.
      setBrowserNotificationPreference(false);
      toast.success("Browser notifications off");
      return;
    }
    // Turning ON — may need to prompt.
    if (permission === "default") {
      const result = await requestBrowserNotificationPermission();
      if (result !== "granted") {
        toast.error("Permission denied");
        return;
      }
    } else if (permission === "denied") {
      toast.error(
        "Notifications are blocked in your browser settings. Unblock them for this site and try again."
      );
      return;
    }
    setBrowserNotificationPreference(true);
    toast.success("Browser notifications on");
    // Fire a hello banner so they see it worked.
    try {
      new Notification("Notifications enabled", {
        body: "You'll get a banner when there's new activity on your projects.",
        icon: "/logo-mark.png",
      });
    } catch {
      // no-op
    }
  }

  const supported = permission !== "unsupported";
  const active = enabled && permission === "granted";

  return (
    <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Bell size={18} />
        </div>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Notifications
          </h2>
          <div className="text-[12px] text-ink-secondary">
            The bell in the sidebar polls every 30s automatically. Turn on
            desktop notifications to get OS-level banners when new activity
            lands on your projects.
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg/40 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">
            Browser notifications
          </div>
          <div className="mt-0.5 text-[11px] text-ink-muted">
            {!supported
              ? "Not supported in this browser."
              : permission === "denied"
              ? "Blocked in browser settings — unblock this site to enable."
              : active
              ? "On — banners fire when the tab is in the background."
              : "Off — you'll still see the in-app bell, just no OS banner."}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={!supported}
          aria-pressed={active}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
            active
              ? "border-accent bg-accent"
              : "border-border bg-surface-dim",
            !supported && "opacity-40"
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
              active ? "translate-x-6" : "translate-x-1"
            )}
          />
        </button>
      </div>
    </section>
  );
}

function PasswordSection() {
  const toast = useToast();
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const strength = validatePasswordStrength(next, user?.email);
    if (!strength.ok) {
      setError(strength.error || "Password is too weak.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/auth/me/password", { current, next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password updated — other sessions signed out");
    } catch (e: any) {
      setError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <KeyRound size={18} />
        </div>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Password
          </h2>
          <div className="text-[12px] text-ink-secondary">
            Change your password. Requires your current password. Other
            sessions will be signed out automatically.
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Current Password
          </label>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              New Password
            </label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <PasswordStrengthMeter password={next} email={user?.email} />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Confirm New Password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>
        {error && (
          <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
            {error}
          </div>
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || !current || !next || !confirm}
          >
            {submitting ? "Updating…" : "Update password"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── Two-factor authentication (TOTP) ──────────────────────────
// Self-service enroll / disable. Three states: off (Enable button), enrolling
// (setup key + code + show backup codes), on (Disable).
//
// The STATE MACHINE IS NOT HERE. It is `lib/totpEnrollment.ts`, shared with
// `mobile/MobileTwoFactorCard.tsx`. A phone-only member could answer the login
// challenge but could not enrol and — the part that is a lockout rather than an
// inconvenience — could not DISABLE 2FA after losing the authenticator. The fix
// for that must not be a second copy of an auth flow, so this component is now
// the desktop's markup over that hook and nothing else.
function TwoFactorSection() {
  const toast = useToast();
  const dialog = useDialog();
  const totp = useTotpEnrollment();
  const [code, setCode] = useState("");

  const status = totp.status;
  const setup = totp.setup;
  const backupCodes = totp.backupCodes;
  const busy = totp.busy;
  const error = totp.error;

  async function confirmEnable(e: React.FormEvent) {
    e.preventDefault();
    if (await totp.enable(code)) {
      setCode("");
      toast.success("Two-factor authentication enabled");
    }
  }

  /* THE DISABLE GATE, unchanged: a current 6-digit code or a backup code, which
     the server verifies. The phone asks for exactly the same thing through an
     inline field (mobile/MobileTwoFactorCard) — a modal prompt is unusable
     inside an installed PWA and suppressed in several webviews. */
  async function disable() {
    const entered = await dialog.prompt({
      title: "Turn off two-factor authentication?",
      message: "Enter a current 6-digit code (or a backup code) to confirm.",
      placeholder: "6-digit code or backup code",
      required: true,
      danger: true,
      confirmLabel: "Turn off",
    });
    if (!entered) return;
    if (await totp.disable(entered)) {
      toast.success("Two-factor authentication disabled");
    }
  }

  return (
    <section className="mb-6 rounded-md border border-border bg-surface p-6 shadow-stone">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ShieldCheck size={18} />
        </div>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Two-Factor Authentication
          </h2>
          <div className="text-[12px] text-ink-secondary">
            Protect your account with an authenticator app (Google Authenticator,
            Authy, 1Password). Recommended for Owner and Director accounts.
          </div>
        </div>
      </div>

      {/* One-time backup codes — shown once, right after enabling. */}
      {backupCodes && (
        <div className="mb-4 rounded-md border border-accent/40 bg-accent-soft/40 p-4">
          <div className="mb-2 text-[12px] font-semibold text-accent-ink">
            Save your backup codes
          </div>
          <div className="mb-3 text-[11px] text-ink-secondary">
            Each code works once if you lose your authenticator. Store them
            somewhere safe — they won't be shown again.
          </div>
          <div className="grid grid-cols-2 gap-1.5 font-mono text-[13px] sm:grid-cols-3">
            {backupCodes.map((c) => (
              <span key={c} className="rounded bg-surface px-2 py-1 text-center">
                {c}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={totp.dismissCodes}
            className="mt-3 text-[11px] font-semibold text-accent underline-offset-2 hover:underline"
          >
            I've saved them
          </button>
        </div>
      )}

      {status?.enabled ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/10 px-2.5 py-1 text-[11px] font-semibold text-ok">
              <ShieldCheck size={13} /> Enabled
            </span>
            <span className="text-ink-muted">
              {status.backup_codes_remaining} backup code
              {status.backup_codes_remaining === 1 ? "" : "s"} left
            </span>
          </div>
          <Button variant="secondary" onClick={disable} disabled={busy}>
            {busy ? "Working…" : "Disable"}
          </Button>
        </div>
      ) : totp.phase === "enrolling" && setup ? (
        <form onSubmit={confirmEnable} className="space-y-3">
          <div className="text-[12px] text-ink-secondary">
            In your authenticator app choose "Add account" → "Enter a setup key"
            and type the key below (account: your email, type: time-based). On a
            phone you can tap the link to open your app directly.
          </div>
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Setup key
              </div>
              <code className="block break-all rounded bg-canvas px-2 py-1 font-mono text-[13px] tracking-wider">
                {setup.secret}
              </code>
            </div>
            <a
              href={setup.otpauth_uri}
              className="inline-block text-[11px] font-semibold text-accent underline-offset-2 hover:underline"
            >
              Open in authenticator app
            </a>
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Enter the 6-digit code to confirm
            </label>
            <input
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoComplete="one-time-code"
              className="h-9 w-40 rounded-md border border-border bg-surface px-3 font-mono text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          {error && (
            <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[12px] text-err">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || code.trim().length < 6}>
              {busy ? "Verifying…" : "Enable"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                totp.cancel();
                setCode("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-muted/10 px-2.5 py-1 text-[11px] font-semibold text-ink-muted">
            {totp.statusError ? "Status unavailable" : "Not enabled"}
          </span>
          {/* A failed STATUS read must not read as "off" — that would offer to
             enrol an account whose 2FA is already ON. `useTotpEnrollment` binds
             the reason instead of swallowing it into a false `enabled: false`;
             this renders it. */}
          {totp.statusError && (
            <span className="text-[12px] text-err">{totp.statusError}</span>
          )}
          {error && <span className="text-[12px] text-err">{error}</span>}
          <Button variant="primary" onClick={totp.begin} disabled={busy || !status}>
            {busy ? "Working…" : "Enable 2FA"}
          </Button>
        </div>
      )}
    </section>
  );
}
