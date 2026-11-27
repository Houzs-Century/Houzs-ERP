import type { AuthUser } from "./auth";
import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { NO_GUIDE_NOTE, queryTerms, rank, redactQuestion, scoreItem, type HowtoCtx, type HowtoOutcome } from "./mcp-howto";
import { canOpenPage, erpLink, gatePasses, NO_PERMISSION_NOTE } from "./mcp-howto-types";
import { SCREENS } from "./mcp-screen-map";
import type { ScreenAction, ScreenPage } from "./mcp-screen-types";

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const answer = (v: unknown, target: string, note = ""): HowtoOutcome => ({ result: text(JSON.stringify(v)), status: 200, note, target });
const basePath = (p: string): string => p.split("?")[0];
const routeMatches = (route: string, path: string): boolean => {
  const r = route.split("/");
  const p = path.split("/");
  return r.length === p.length && r.every((s, i) => s.startsWith(":") || s === p[i]);
};

/** "https://erp.x/scm/grns/12?tab=lines#a" or "/scm/grns/12" -> { path: "/scm/grns/12", query: URLSearchParams }. */
export function parseErpPath(raw: string): { path: string; query: URLSearchParams } | null {
  const s = raw.trim();
  if (!s) return null;
  const withOrigin = /^https?:\/\//i.test(s) ? s : `https://x${s.startsWith("/") ? "" : "/"}${s}`;
  try {
    const u = new URL(withOrigin);
    return { path: u.pathname.replace(/\/+$/, "") || "/", query: u.searchParams };
  } catch {
    return null;
  }
}

/** The screen for a URL: a query variant (e.g. /assr?view=cases) when the URL carries it, else the bare route. */
export function screenForPath(raw: string): ScreenPage | null {
  const p = parseErpPath(raw);
  if (!p) return null;
  const literal = SCREENS.filter((s) => basePath(s.path) === p.path);
  const candidates = literal.length ? literal : SCREENS.filter((s) => routeMatches(basePath(s.path), p.path));
  if (!candidates.length) return null;
  const variant = candidates.find((s) => {
    const q = s.path.split("?")[1];
    if (!q) return false;
    return [...new URLSearchParams(q)].every(([k, v]) => p.query.get(k) === v);
  });
  return variant ?? candidates.find((s) => !s.path.includes("?")) ?? candidates[0];
}

/** Screens ranked by how many of the labels read off a screenshot they carry (title and tabs weigh most). */
export function screensForLabels(labels: readonly string[]): { screen: ScreenPage; score: number }[] {
  const seen = [...new Set(labels.map(norm).filter((l) => l.length >= 2))].slice(0, 80);
  if (!seen.length) return [];
  return SCREENS.map((screen) => {
    const title = norm(screen.title);
    const tabs = new Set([...screen.tabs, ...screen.sections].map(norm));
    const acts = new Set(screen.actions.map((a) => norm(a.label)));
    let score = 0;
    for (const l of seen) {
      if (l === title) score += 3;
      else if (tabs.has(l)) score += 2;
      else if (acts.has(l)) score += 1.5;
      else if (l.length >= 8 && (title.includes(l) || [...acts].some((a) => a.includes(l)))) score += 0.5;
    }
    return { screen, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

const actionCanDo = (a: ScreenAction, pageOpen: boolean, u: AuthUser): boolean => pageOpen && (!a.gate || a.gate.kind === "route" || gatePasses(a.gate, u));

/** One screen as the tools return it: links carry ?highlight=<label>, canDo per action from the person's permissions. */
export function screenView(s: ScreenPage, ctx: HowtoCtx) {
  const canOpen = canOpenPage(s.path, ctx.user);
  return {
    path: s.path,
    title: s.title,
    purpose: s.purpose,
    sidebar: s.sidebar,
    link: erpLink(ctx.origin, s.path, null),
    canOpen,
    ...(canOpen ? {} : { note: NO_PERMISSION_NOTE }),
    sections: s.sections,
    tabs: s.tabs,
    actions: s.actions.map((a) => {
      const canDo = actionCanDo(a, canOpen, ctx.user);
      return { label: a.label, kind: a.kind, does: a.does, permission: a.permission, sideEffects: a.sideEffects, canDo, ...(canDo ? {} : { note: NO_PERMISSION_NOTE }), ...(s.path.includes(":") ? {} : { link: erpLink(ctx.origin, s.path, a.label) }) };
    }),
  };
}

function explainScreen(ctx: HowtoCtx, args: Record<string, unknown>): HowtoOutcome {
  const path = typeof args.path === "string" ? args.path.slice(0, 500) : "";
  const labels = Array.isArray(args.visible_text) ? (args.visible_text as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 120)) : [];
  const byPath = path ? screenForPath(path) : null;
  if (byPath) return answer({ matchedBy: "path", screen: screenView(byPath, ctx) }, `explain_screen ${byPath.path}`);
  const ranked = screensForLabels(labels);
  if (!ranked.length) {
    const asked = [path, ...labels.slice(0, 6)].filter(Boolean).join(" | ");
    return answer({ matched: false, message: "Could not tell which ERP page this is. Ask the person for the address bar (URL) or the page title." }, asked ? redactQuestion(asked) : "explain_screen (empty)", asked ? NO_GUIDE_NOTE : "");
  }
  const top = ranked[0];
  const others = ranked.slice(1, 3).filter((r) => r.score >= top.score * 0.7).map((r) => ({ path: r.screen.path, title: r.screen.title }));
  return answer({ matchedBy: "labels", screen: screenView(top.screen, ctx), ...(others.length ? { couldAlsoBe: others } : {}) }, `explain_screen ${top.screen.path}`);
}

/** where_is: the pages (and the button on them) that best match "where do I open X". */
export function whereIs(thing: string): { screen: ScreenPage; action: ScreenAction | null; score: number }[] {
  const q = queryTerms(thing);
  const guide = rank(HOWTO_GUIDES, thing)[0];
  const guidePage = guide ? basePath(guide.item.page) : null;
  return SCREENS.map((screen) => {
    const pageScore = scoreItem({ id: screen.path, title: screen.title, keywords: [...screen.keywords, screen.title, ...(screen.sidebar ? [screen.sidebar] : [])] }, q);
    let best: ScreenAction | null = null;
    let bestScore = 0;
    for (const a of screen.actions) {
      const sc = scoreItem({ id: "", title: a.label, keywords: [a.label] }, q);
      if (sc > bestScore) {
        best = a;
        bestScore = sc;
      }
    }
    const linkable = !screen.path.includes(":");
    const fromGuide = guidePage && basePath(screen.path) === guidePage ? guide.score * 0.5 : 0;
    return { screen, action: best, score: (pageScore + bestScore * 0.6 + fromGuide) * (linkable ? 1 : 0.5) };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

function whereIsTool(ctx: HowtoCtx, args: Record<string, unknown>): HowtoOutcome {
  const thing = typeof args.thing === "string" ? args.thing.trim().slice(0, 200) : "";
  if (!thing) return { result: text("Say what you are looking for, e.g. 'new sales order' or 'SO maintenance'.", true), status: 400, note: "", target: "where_is" };
  const hits = whereIs(thing).slice(0, 3);
  if (!hits.length) return answer({ matched: false, message: "No page matches that. Try other words, or call module_overview for the list of modules." }, redactQuestion(thing), NO_GUIDE_NOTE);
  const guide = rank(HOWTO_GUIDES, thing)[0];
  return answer(
    {
      places: hits.map(({ screen, action }) => {
        const canOpen = canOpenPage(screen.path, ctx.user);
        return {
          title: screen.title,
          sidebar: screen.sidebar ?? "Not in the sidebar; see purpose for how to reach it",
          purpose: screen.purpose.split(/(?<=\.)\s/)[0],
          ...(action ? { press: action.label } : {}),
          link: erpLink(ctx.origin, screen.path, action ? action.label : null) ?? screen.path,
          canOpen,
          ...(canOpen ? {} : { note: NO_PERMISSION_NOTE }),
        };
      }),
      ...(guide ? { stepByStep: { how_to: guide.item.id, title: guide.item.title } } : {}),
      tip: "The link opens the page and highlights the button to press.",
    },
    `where_is ${hits[0].screen.path}`,
  );
}

const readOnly = { readOnlyHint: true, openWorldHint: false };

/** The screen tools. No ERP data is read; canOpen / canDo come from the person's own ERP permissions. */
export const SCREEN_TOOLS = [
  {
    name: "explain_screen",
    title: "Explain an ERP screen (from a URL or a screenshot)",
    description: "Identify an ERP page from its URL path or from the labels visible on a screenshot (buttons, tabs, headings), and explain it: what the page is for, how to reach it from the sidebar, and what every button does (with the permission it needs, side effects, canDo for this person and a link that highlights it).",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "The URL or path from the address bar, e.g. /scm/purchase-orders/new" }, visible_text: { type: "array", items: { type: "string" }, description: "Labels read off the screenshot: page title, tab names, button texts" } }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "where_is",
    title: "Where do I open ... in the ERP",
    description: "Where to find something in the ERP (e.g. 'new sales order', 'SO maintenance', 'stock card', 'AR aging'): the sidebar path, the button to press and a link that opens the page with that button highlighted.",
    inputSchema: { type: "object", properties: { thing: { type: "string" } }, required: ["thing"], additionalProperties: false },
    annotations: readOnly,
  },
] as const;

const NAMES = new Set<string>(SCREEN_TOOLS.map((t) => t.name));
/** Is this one of the screen tools? */
export const isScreenTool = (name: string): boolean => NAMES.has(name);

/** Run a screen tool. Pure: no reads, no writes. */
export function runScreenTool(ctx: HowtoCtx, name: string, args: Record<string, unknown>): HowtoOutcome {
  if (name === "explain_screen") return explainScreen(ctx, args);
  if (name === "where_is") return whereIsTool(ctx, args);
  return { result: text(`Unknown tool: ${name}`, true), status: 400, note: "", target: name };
}

/** The screen part of the server instructions. */
export const SCREEN_INSTRUCTIONS = `SCREENSHOTS: when the person sends a screenshot or photo of the ERP, read the address bar (URL) and the visible labels (page title, tabs, button texts) and call explain_screen {path, visible_text}; then explain the page and the buttons they ask about in their language. "Where do I open / find X" -> where_is {thing}. Give the link: it opens the page and highlights the button.`;

/** Ready-made prompts for the screen tools. */
export const SCREEN_PROMPTS = [
  { name: "explain_this_screen", title: "Explain this screen", description: "What an ERP page and its buttons do. Uses explain_screen.", arguments: [{ name: "url", description: "The address bar URL or path", required: false }] },
  { name: "where_is_it", title: "Where is it", description: "Where to open something in the ERP. Uses where_is.", arguments: [{ name: "thing", description: "What you are looking for", required: true }] },
] as const;

/** The message for a screen prompt, or null. */
export function screenPromptText(name: string, a: Record<string, unknown>): string | null {
  const v = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim().slice(0, 200) : "");
  if (name === "explain_this_screen") return `Explain this ERP screen${v("url") ? ` (${v("url")})` : ""}. Call explain_screen with the path${v("url") ? "" : " or the labels you can read on my screenshot"}, then tell me what the page is for and what each button does. Answer in my language and give the links.`;
  if (name === "where_is_it") return `Where do I open ${v("thing") || "this"} in the ERP? Call where_is {thing: "${v("thing")}"} and give me the sidebar path, the button and the link.`;
  return null;
}
