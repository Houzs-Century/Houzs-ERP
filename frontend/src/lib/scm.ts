// Shared helpers for the ported 2990's SCM (furniture supply chain) pages.
// All SCM endpoints live under /api/scm/* (the Hono routes ported from 2990's,
// which talk to the `scm` Postgres schema). Money in the SCM layer is stored as
// integer *_centi (sen, 1/100 of a currency unit), matching 2990's convention.

export const SCM = "/api/scm";

const CURRENCY_SYMBOL: Record<string, string> = {
  MYR: "RM",
  SGD: "S$",
  USD: "US$",
  RMB: "¥",
};

/** Integer *_centi → a BARE 2dp amount, e.g. 123456 → "1,234.56" — no currency.
 *  For callers that print their own "RM " prefix; {@link fmtCenti} builds on it
 *  so the two cannot drift.
 *
 *  Non-finite collapses to 0 rather than reaching toLocaleString, which renders
 *  the literal "NaN" / "∞" at the user (owner's plain-language rule: a number
 *  the ERP does not have must never read as broken). `?? 0` does NOT do this —
 *  it only catches null/undefined, and NaN passes straight through it. Note this
 *  is NOT the vendor/shared/format.ts contract, which returns "—" for both null
 *  and non-finite: this module keeps null → "0.00" because six mobile screens
 *  render it that way today, and changing that is presentation, not a guard. */
export function fmtAmt(centi: number | null | undefined): string {
  const raw = Number(centi ?? 0);
  const n = (Number.isFinite(raw) ? raw : 0) / 100;
  return n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format an integer *_centi value into a display string, e.g. 123456 → "RM 1,234.56".
 *  NOTE: this is NOT the same function as `fmtCenti` in vendor/shared/format.ts —
 *  that one prefixes the currency CODE ("MYR 1,234.56") and returns "—" when the
 *  value is absent, this one prefixes the SYMBOL. Two same-named formatters is
 *  why #647's finite guard never reached mobile: the whole mobile tree imports
 *  THIS one, so hardening only the shared copy left every mobile screen exposed. */
export function fmtCenti(centi: number | null | undefined, currency = "MYR"): string {
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${sym}${fmtAmt(centi)}`;
}

/** True when an SCM document status means "cancelled", whatever the casing.
 *  The backends are not consistent: PO/GRN/PI store SCREAMING_CASE
 *  ("CANCELLED"), SO/DO come back in any case, and legacy SO rows carry the
 *  bare verb "cancel" (see MfgSalesOrdersListV2's STATUS_TONE). The list
 *  pages use this ONE predicate for the muted cancelled-row treatment
 *  (index.css `dt-row-cancelled`) so the SCM lists cannot drift apart on
 *  what counts as cancelled. */
export function isCancelledDocStatus(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toUpperCase();
  return s === "CANCELLED" || s === "CANCEL";
}

/** SCM document/master statuses share a small colour vocabulary. Returns
 *  Tailwind classes for a status pill (semantic tokens from tailwind.config). */
export function scmStatusClasses(status: string | null | undefined): string {
  switch ((status ?? "").toUpperCase()) {
    case "ACTIVE":
    case "POSTED":
    case "RECEIVED":
    case "COMPLETED":
    case "DELIVERED":
      return "bg-synced/15 text-synced border-synced/30";
    case "BLOCKED":
    case "CANCELLED":
    // Legacy SO rows carry the bare verb "cancel" (see isCancelledDocStatus);
    // keep it on the err branch so the pill matches the muted cancelled row.
    case "CANCEL":
      return "bg-err/10 text-err border-err/30";
    case "SUBMITTED":
    case "PARTIALLY_RECEIVED":
    case "PARTIALLY_PAID":
    case "DRAFT":
      // `warning` token only defines bg/text sub-keys (no DEFAULT), so
      // text-warning / bg-warning/15 don't resolve — use the explicit names.
      return "bg-warning-bg text-warning-text border-warning-text/30";
    default:
      return "bg-surface-dim text-ink-muted border-border";
  }
}
