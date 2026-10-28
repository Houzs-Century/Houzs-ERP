import type { Invitation } from "../types";

/** Expiring-soon window for a pending invitation (2 days). */
export const INVITE_EXPIRING_SOON_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Expiry bucket for an invitation — drives the status badge and row dimming
 * on BOTH surfaces (desktop Team.tsx table, mobile MobileInvitations card).
 */
export function inviteExpiry(inv: Invitation): "expired" | "expiring" | "pending" {
  const ms = new Date(inv.expires_at).getTime() - Date.now();
  if (ms < 0) return "expired";
  if (ms < INVITE_EXPIRING_SOON_MS) return "expiring";
  return "pending";
}

/**
 * The link Copy Link places on the clipboard. Prefer the server-built
 * canonical link (PUBLIC_APP_URL) so copies always carry
 * erp.houzscentury.com regardless of which origin the admin's browser is on.
 */
export function inviteLink(inv: Invitation): string {
  return inv.invite_url || `${window.location.origin}/#invite=${inv.token}`;
}
