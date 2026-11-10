export const CJK_FONT_STYLESHEET = "/fonts/fonts-cjk-v1.css";

/* The Chinese faces are ~97% of the font CSS (fonts-v2.css was 968 KB), so a
   <link> in index.html would hold up first paint on every screen. A stylesheet
   attached by script after the load event never blocks rendering; Chinese text
   shows in the system CJK font until it arrives, then swaps. readyState is
   checked so a caller that runs after the load event still gets the sheet. */
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
