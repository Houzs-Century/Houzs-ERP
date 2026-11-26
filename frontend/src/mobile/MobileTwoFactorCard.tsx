import { useState } from "react";
import { useTotpEnrollment } from "../lib/totpEnrollment";
import { useToast } from "../hooks/useToast";


const card: React.CSSProperties = {
  background: "var(--hz-c-surface)", border: "1px solid var(--line)", borderRadius: 14, padding: 14,
};
const label: React.CSSProperties = {
  fontSize: 8.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--hz-c-ink-soft)",
};
const field: React.CSSProperties = {
  width: "100%", marginTop: 6, border: "1px solid var(--line)", borderRadius: 10,
  padding: "10px 12px", fontFamily: "inherit", fontSize: 14, color: "var(--ink)", outline: "none",
};
const primary = (enabled: boolean): React.CSSProperties => ({
  width: "100%", marginTop: 14, background: "var(--teal)", color: "#fff", border: "none",
  borderRadius: 11, padding: "12px", fontSize: 13.5, fontWeight: 700, fontFamily: "inherit",
  cursor: enabled ? "pointer" : "default", opacity: enabled ? 1 : 0.6,
});
const danger: React.CSSProperties = {
  width: "100%", marginTop: 12, background: "var(--hz-c-surface)", color: "var(--hz-c-err)",
  border: "1px solid rgba(178,58,58,.35)", borderRadius: 11, padding: "12px",
  fontSize: 13.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
};
const errText: React.CSSProperties = { fontSize: 11.5, color: "var(--hz-c-err)", marginTop: 10 };
const hint: React.CSSProperties = {
  fontSize: 11, color: "var(--hz-c-ink-soft)", marginTop: 11, lineHeight: 1.5, padding: "0 2px",
};

export function MobileTwoFactorCard() {
  const totp = useTotpEnrollment();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [disarming, setDisarming] = useState(false);
  const [disableCode, setDisableCode] = useState("");

  const onEnable = async () => {
    if (await totp.enable(code)) {
      setCode("");
      toast.success("Two-factor authentication enabled");
    }
  };

  const onDisable = async () => {
    if (await totp.disable(disableCode)) {
      setDisableCode("");
      setDisarming(false);
      toast.success("Two-factor authentication disabled");
    }
  };

  return (
    <>
      {totp.backupCodes && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Save your backup codes"
          style={{
            position: "fixed", inset: 0, zIndex: 90, background: "var(--app-bg,#f4f4ef)",
            padding: 18, overflowY: "auto",
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--ink)" }}>
            Save your backup codes
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, lineHeight: 1.5 }}>
            Each code works once if you lose your authenticator. Write them down or
            put them in your password manager — they won't be shown again.
          </div>
          <div
            className="money"
            style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14,
            }}
          >
            {totp.backupCodes.map((c) => (
              <span
                key={c}
                style={{
                  background: "var(--hz-c-surface)", border: "1px solid var(--line)", borderRadius: 10,
                  padding: "10px 6px", textAlign: "center", fontSize: 13.5, fontWeight: 700,
                  color: "var(--ink)",
                }}
              >
                {c}
              </span>
            ))}
          </div>
          <button type="button" onClick={totp.dismissCodes} style={primary(true)}>
            I've saved them
          </button>
        </div>
      )}

      <div style={{ ...card, marginTop: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
          Two-Factor Authentication
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
          Protect your account with an authenticator app (Google Authenticator, Authy,
          1Password).
        </div>

        {totp.statusError && !totp.status && (
          <div style={errText}>
            {totp.statusError} Pull down to retry — your existing setting is unchanged.
          </div>
        )}

        {totp.status?.enabled ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5, color: "var(--ink)" }}>
              <span style={{ fontWeight: 700, color: "var(--hz-c-primary)" }}>Enabled</span>
              {" · "}
              {totp.status.backup_codes_remaining} backup code
              {totp.status.backup_codes_remaining === 1 ? "" : "s"} left
            </div>

            {!disarming ? (
              <button type="button" onClick={() => setDisarming(true)} style={danger}>
                Turn off 2FA
              </button>
            ) : (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="totp-disable-code" style={label}>
                  Current 6-digit code (or a backup code)
                </label>
                <input
                  id="totp-disable-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  placeholder="123456"
                  style={field}
                />
                {totp.error && <div style={errText}>{totp.error}</div>}
                <button
                  type="button"
                  onClick={onDisable}
                  disabled={totp.busy || !disableCode.trim()}
                  style={{
                    ...danger,
                    cursor: totp.busy || !disableCode.trim() ? "default" : "pointer",
                    opacity: totp.busy || !disableCode.trim() ? 0.6 : 1,
                  }}
                >
                  {totp.busy ? "Working…" : "Turn off 2FA"}
                </button>
                <button
                  type="button"
                  onClick={() => { setDisarming(false); setDisableCode(""); }}
                  style={{ ...danger, color: "var(--muted)", borderColor: "var(--line)" }}
                >
                  Cancel
                </button>
                <div style={hint}>
                  Turning 2FA off makes your account password-only. You'll need your
                  authenticator (or a backup code) to do it.
                </div>
              </div>
            )}
          </div>
        ) : totp.phase === "enrolling" && totp.setup ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>
              In your authenticator app choose "Add account" → "Enter a setup key" and
              type the key below, or tap the link to open your app directly.
            </div>
            <div style={{ ...label, marginTop: 12 }}>Setup key</div>
            <div
              className="money"
              style={{
                marginTop: 6, background: "var(--app-bg,#f4f4ef)", border: "1px solid var(--line)",
                borderRadius: 10, padding: "10px 12px", fontSize: 14, fontWeight: 700,
                letterSpacing: ".06em", wordBreak: "break-all", color: "var(--ink)",
              }}
            >
              {totp.setup.secret}
            </div>
            <a
              href={totp.setup.otpauth_uri}
              style={{
                display: "inline-block", marginTop: 10, fontSize: 12, fontWeight: 700,
                color: "var(--teal)",
              }}
            >
              Open in authenticator app
            </a>

            <label htmlFor="totp-enable-code" style={{ ...label, display: "block", marginTop: 14 }}>
              Enter the 6-digit code to confirm
            </label>
            <input
              id="totp-enable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              style={field}
            />
            {totp.error && <div style={errText}>{totp.error}</div>}
            <button
              type="button"
              onClick={onEnable}
              disabled={totp.busy || code.trim().length < 6}
              style={primary(!totp.busy && code.trim().length >= 6)}
            >
              {totp.busy ? "Verifying…" : "Enable"}
            </button>
            <button
              type="button"
              onClick={() => { totp.cancel(); setCode(""); }}
              style={{ ...danger, color: "var(--muted)", borderColor: "var(--line)" }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Not enabled</div>
            {totp.error && <div style={errText}>{totp.error}</div>}
            <button
              type="button"
              onClick={totp.begin}
              disabled={totp.busy || !totp.status}
              style={primary(!totp.busy && !!totp.status)}
            >
              {totp.busy ? "Working…" : "Enable 2FA"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
