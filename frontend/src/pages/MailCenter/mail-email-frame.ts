
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
