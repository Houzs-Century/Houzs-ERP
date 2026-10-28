import { PasswordStrengthMeter } from "autocount-sync-frontend";

// Four-segment strength bar + first-failing-rule hint. Driven entirely by
// the shared validator (12-char floor, all four character classes, common-
// password and email-local-part guards; score 1-4 steps at 16/20/24 chars).
// Renders nothing for an empty password, so every story feeds one.

const Field = ({ label, password, email }: { label: string; password: string; email?: string }) => (
  <div className="w-72">
    <div className="mb-1 text-[10px] font-bold uppercase tracking-brand text-ink-muted">
      {label}
    </div>
    <input
      type="password"
      readOnly
      value={password}
      className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink"
    />
    <PasswordStrengthMeter password={password} email={email} />
  </div>
);

export const ScoreLadder = () => (
  <div className="space-y-4">
    <Field label="Acceptable (12+)" password="Houzs-SO2990!" />
    <Field label="Good (16+)" password="Aircon-Houzs2990!" />
    <Field label="Strong (20+)" password="Panasonic-Inverter25!" />
    <Field label="Excellent (24+)" password="Deliver-Klang-Valley-2990!" />
  </div>
);

export const RuleHints = () => (
  <div className="space-y-4">
    <Field label="Too short" password="Houzs!29" />
    <Field label="Missing uppercase" password="houzs-delivery-2990!" />
    <Field
      label="Contains email name"
      password="Farra-Deliveries29!"
      email="farra@houzscentury.com"
    />
  </div>
);

export const InContext = () => (
  <div className="w-80 rounded-lg border border-border bg-surface p-4 shadow-stone">
    <div className="mb-3 font-display text-[14px] font-bold text-ink">Set your password</div>
    <label className="mb-1 block text-[11px] font-medium text-ink-secondary">
      New password
    </label>
    <input
      type="password"
      readOnly
      value="Aircon-Houzs2990!"
      className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink"
    />
    <PasswordStrengthMeter password="Aircon-Houzs2990!" email="hafiz@houzscentury.com" />
  </div>
);
