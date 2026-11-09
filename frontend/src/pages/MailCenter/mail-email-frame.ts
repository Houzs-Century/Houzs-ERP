/* One home for how an email's HTML is put into an iframe, shared by the desktop
   conversation reader, the desktop outbox preview and the phone reader. Links
   must open in a new tab: the app sends X-Frame-Options DENY, so a link that
   navigates the frame itself shows "refused to connect", and with no popup
   permission at all (sandbox="") a click does nothing. A `target=_blank` link
   carries no opener by default (HTML spec, implied rel=noopener). Scripts stay
   off on every frame: no sandbox here grants allow-scripts. */

/** Popups may open (the new-tab links) and leave the sandbox, so the opened page works normally. */
export const EMAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** Adds same-origin (still no scripts) so the parent can measure the frame and size it to its content. */
export const EMAIL_FRAME_SANDBOX_MEASURABLE = `allow-same-origin ${EMAIL_FRAME_SANDBOX}`;

/** Wraps raw email HTML so every link opens in a new tab, with the caller's own presentation head. */
export function emailSrcDoc(rawHtml: string, presentationHead = ""): string {
  const inject = `<base target="_blank"><meta charset="utf-8">${presentationHead}`;
  if (/<head[^>]*>/i.test(rawHtml)) return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  if (/<html[^>]*>/i.test(rawHtml)) return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
  return `<!doctype html><html><head>${inject}</head><body>${rawHtml}</body></html>`;
}
