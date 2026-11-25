// One-time sign-in links in the auto-sent log (routes/mail-center.ts /outbox).
//
// email_outbox keeps every system email's full body, including member invites
// (/invite/<token>) and password resets (/reset/<token>) — live, one-time links
// that sign the recipient in. The auto-sent log is readable by anyone with a
// mailbox in scope, which is nearly everyone (personal mailboxes), so without
// this a staff member could open a colleague's reset link. Mail Center admins
// still see the bodies unchanged; everyone else sees the email with those links
// replaced. Found by the 2026-11-26 Mail Center parity review.

/** A sign-in link: /invite/<token>, /reset/<token>, or /reset-password|/accept-invite|/invite?token=<token>. */
const LOGIN_LINK = /(https?:\/\/[^\s"'<>]*)?\/(invite|reset|reset-password|accept-invite)(\/[A-Za-z0-9._~%-]{8,}|\?[^\s"'<>]*?token=[^\s"'<>&]{8,})[^\s"'<>]*/gi;

export const HIDDEN_LINK = "[sign-in link hidden — only a Mail Center admin can see it]";

/** Replace every invite / reset sign-in link in a text or HTML body. */
export function maskLoginLinks(body: string | null | undefined): string {
  if (!body) return body ?? "";
  return body.replace(LOGIN_LINK, HIDDEN_LINK);
}
