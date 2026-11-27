const INTERACTIVE = "button, a, [role='button'], [role='tab'], [role='menuitem'], [role='option'], summary, label, input[type='button'], input[type='submit']";
const SCAN = `${INTERACTIVE}, th, h1, h2, h3, h4, legend, span, div, p, li, td, input, textarea, select`;

/** A label for comparing: whitespace collapsed, trimmed, lower case. */
export const normLabel = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const tight = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

const visible = (el: Element): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const view = el.ownerDocument.defaultView;
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n instanceof HTMLElement && n.hidden) return false;
    if (n.getAttribute("aria-hidden") === "true") return false;
    const style = view?.getComputedStyle(n);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  }
  return true;
};

const laidOut = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  const width = el.ownerDocument.defaultView?.innerWidth ?? Infinity;
  return r.width > 0 && r.height > 0 && r.right > 0 && r.left < width;
};

const ownText = (el: Element): string => {
  if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "submit")) return el.value;
  return el.textContent;
};

const matches = (candidate: string, want: string): boolean => {
  if (!candidate) return false;
  return normLabel(candidate) === normLabel(want) || tight(candidate) === tight(want);
};

/**
 * The visible element whose text (or aria-label / title / placeholder) is the label, trimmed and
 * case-insensitive. The deepest text match wins, then its nearest interactive ancestor is returned
 * (a span inside a button gives the button). Read-only: it never clicks or changes anything.
 */
export function findHighlightTarget(root: ParentNode, label: string): HTMLElement | null {
  if (!normLabel(label)) return null;
  const shown = Array.from(root.querySelectorAll(SCAN)).filter(visible);
  const all = shown.some(laidOut) ? shown.filter(laidOut) : shown;
  const byAttr = all.find((el) => ["aria-label", "title", "placeholder"].some((a) => matches(el.getAttribute(a) ?? "", label)));
  const byText = all.filter((el) => matches(ownText(el), label));
  const deepest = byText.filter((el) => !byText.some((o) => o !== el && el.contains(o)));
  const first: Element | undefined = deepest.length ? deepest[0] : undefined;
  const pick = deepest.find((el) => el.closest(INTERACTIVE)) ?? first ?? byAttr;
  if (!pick) return null;
  const interactive = pick.closest(INTERACTIVE);
  return (interactive instanceof HTMLElement ? interactive : pick) as HTMLElement;
}

/** The URL without its highlight parameter (other parameters and the hash kept). */
export function withoutHighlight(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("highlight");
  return `${u.pathname}${u.search}${u.hash}`;
}
