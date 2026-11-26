
const LOGIN_LINK = /(https?:\/\/[^\s"'<>]*)?\/(invite|reset|reset-password|accept-invite)(\/[A-Za-z0-9._~%-]{8,}|\?[^\s"'<>]*?token=[^\s"'<>&]{8,})[^\s"'<>]*/gi;

export const HIDDEN_LINK = "[sign-in link hidden — only a Mail Center admin can see it]";

/** Replace every invite / reset sign-in link in a text or HTML body. */
export function maskLoginLinks(body: string | null | undefined): string {
  if (!body) return body ?? "";
  return body.replace(LOGIN_LINK, HIDDEN_LINK);
}
