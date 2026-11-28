export const CJK_FONT_STYLESHEET = "/fonts/fonts-cjk-v1.css";

export function loadDeferredFontStylesheet(doc: Document, href: string): void {
  const attach = () => {
    if (doc.head.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    doc.head.appendChild(link);
  };
  if (doc.readyState === "complete") attach();
  else doc.defaultView?.addEventListener("load", attach, { once: true });
}
