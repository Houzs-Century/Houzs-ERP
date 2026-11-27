import type { AuthUser } from "./auth";
import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { MODULES } from "./mcp-howto-modules";
import { GLOSSARY } from "./mcp-howto-glossary";
import { ONBOARDING } from "./mcp-howto-onboarding";
import { ERRORS } from "./mcp-howto-errors";
import { canOpenPage, erpLink, NO_PERMISSION_NOTE, type HowtoGuide } from "./mcp-howto-types";
import { hasShot } from "./mcp-help-shots";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
/** What a help tool hands back to routes/mcp.ts callTool: the result plus what goes into mcp_calls. */
export type HowtoOutcome = { result: ToolResult; status: number; note: string; target: string };
/** The person and the public origin links are built on. Nothing else: help tools read no ERP data. */
export type HowtoCtx = { user: AuthUser; origin: string };

/** The mcp_calls note on a question no guide answers; the admin page lists these. */
export const NO_GUIDE_NOTE = "no-guide";

const STOP = new Set(["how", "to", "do", "does", "i", "a", "an", "the", "in", "on", "for", "of", "my", "me", "is", "are", "what", "where", "can", "we", "you", "and", "or", "with", "erp", "please", "help", "want", "need", "it", "this", "that", "be", "get", "should", "who", "when", "which", "macam", "mana", "cara", "saya", "nak", "untuk", "dan", "yang", "open", "find", "page", "screen", "button", "go", "locate", "located"]);

const norm = (s: string): string => s.normalize("NFKC").toLowerCase();

/** The latin words (stop words dropped) and the CJK runs of a question. A capitalised DO stays a word. */
export function queryTerms(q: string): { words: string[]; cjk: string[]; text: string } {
  const text = norm(q);
  const words = (text.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2 && !STOP.has(w));
  if (/\bDO\b/.test(q) || /\bDOs\b/.test(q)) words.push("do");
  const cjk = text.match(/[㐀-鿿]+/g) ?? [];
  return { words, cjk, text };
}

type Rankable = { id: string; title: string; keywords: readonly string[] };

const wordsOf = (s: string): string[] => norm(s).match(/[a-z0-9]+/g) ?? [];

/** Simple keyword / title score: whole keyword phrases count most, then shared words. No external calls. */
export function scoreItem(item: Rankable, q: ReturnType<typeof queryTerms>): number {
  if (!q.words.length && !q.cjk.length) return 0;
  const qWords = new Set(q.words);
  const padded = ` ${(q.text.match(/[a-z0-9㐀-鿿]+/g) ?? []).join(" ")} `;
  const hits: number[] = [];
  for (const raw of item.keywords) {
    const k = norm(raw);
    if (/[㐀-鿿]/.test(k)) {
      if (q.text.includes(k)) hits.push(4 + k.length);
      continue;
    }
    const kw = wordsOf(k);
    if (kw.length && padded.includes(` ${kw.join(" ")} `)) hits.push(3 + kw.length * 2);
    else hits.push(kw.filter((w) => qWords.has(w)).length * 0.75);
  }
  const best = hits.length ? Math.max(...hits) : 0;
  let score = best + 0.25 * (hits.reduce((a, b) => a + b, 0) - best);
  const titleWords = new Set(wordsOf(item.title));
  for (const w of qWords) if (titleWords.has(w)) score += 2;
  if (qWords.has(norm(item.id))) score += 50;
  return score;
}

/** Items ranked best first, zero scores dropped. */
export function rank<T extends Rankable>(items: readonly T[], question: string): { item: T; score: number }[] {
  const q = queryTerms(question);
  return items
    .map((item) => ({ item, score: scoreItem(item, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** A question with emails and long digit runs removed, cut to 80 characters, for the no-guide log. */
export function redactQuestion(q: string): string {
  return q
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s-]{5,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const answer = (v: unknown, target: string, note = ""): HowtoOutcome => ({ result: text(JSON.stringify(v)), status: 200, note, target });
const str = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, 300) : "");

/** One guide as the tool returns it: links built, gate replaced by canDo for this person. */
export function guideView(g: HowtoGuide, ctx: HowtoCtx) {
  const canDo = canOpenPage(g.page, ctx.user);
  const { steps, ...rest } = g;
  return {
    ...rest,
    link: erpLink(ctx.origin, g.page, null),
    canDo,
    ...(canDo ? {} : { note: NO_PERMISSION_NOTE }),
    steps: steps.map((s, i) => ({ n: i + 1, ...(s.role ? { role: s.role } : {}), text: s.text, ...(s.page ? { link: erpLink(ctx.origin, s.page, s.highlight) ?? s.page } : {}), ...(s.highlight ? { press: s.highlight } : {}), ...(s.page && hasShot(s.page, s.highlight) ? { showMe: { guide_id: g.id, step: i + 1 } } : {}) })),
  };
}

const moduleOpen = (m: (typeof MODULES)[number], u: AuthUser): boolean => m.keyPages.some((p) => canOpenPage(p.path, u));

const byId = new Map(HOWTO_GUIDES.map((g) => [g.id, g]));
const titleList = () => HOWTO_GUIDES.map((g) => ({ id: g.id, title: g.title, kind: g.kind }));

function howTo(ctx: HowtoCtx, args: Record<string, unknown>): HowtoOutcome {
  const topic = str(args.topic);
  const question = str(args.question);
  const exact = topic ? byId.get(topic) : undefined;
  if (exact) return answer({ guides: [guideView(exact, ctx)] }, `how_to ${exact.id}`);
  const asked = [question, topic].filter(Boolean).join(" ");
  const hits = rank(HOWTO_GUIDES, asked);
  if (!hits.length) {
    return answer({ matched: false, message: "No guide matches that question yet. These are the guides there are:", guides: titleList() }, asked ? redactQuestion(asked) : "how_to (empty)", asked ? NO_GUIDE_NOTE : "");
  }
  const top = hits[0].score;
  const full = hits.filter((h, i) => i === 0 || h.score >= top * 0.8).slice(0, 3);
  const more = hits.filter((h) => !full.includes(h)).slice(0, 4).map((h) => ({ id: h.item.id, title: h.item.title }));
  return answer({ guides: full.map((h) => guideView(h.item, ctx)), ...(more.length ? { alsoSee: more } : {}), tip: "Call how_to with topic = an id for another guide." }, `how_to ${full.map((h) => h.item.id).join(",")}`);
}

function moduleOverview(ctx: HowtoCtx, args: Record<string, unknown>): HowtoOutcome {
  const asked = str(args.module);
  if (!asked) return answer({ modules: MODULES.map((m) => ({ id: m.id, name: m.name, sidebar: m.sidebar, purpose: m.purpose.split(/(?<=\.)\s/)[0], canOpen: moduleOpen(m, ctx.user) })) }, "module_overview (list)");
  const exact = MODULES.find((m) => m.id === asked || norm(m.name) === norm(asked) || norm(m.sidebar) === norm(asked));
  const hits = exact ? [exact] : rank(MODULES.map((m) => ({ ...m, title: `${m.name} ${m.sidebar}` })), asked).slice(0, 2).map((h) => MODULES.find((m) => m.id === h.item.id) ?? h.item);
  if (!hits.length) return answer({ matched: false, message: "No module by that name. These are the modules:", modules: MODULES.map((m) => ({ id: m.id, name: m.name })) }, redactQuestion(asked), NO_GUIDE_NOTE);
  return answer(
    {
      modules: hits.map((m) => {
        const canOpen = moduleOpen(m, ctx.user);
        const { keyPages, ...rest } = m;
        return { ...rest, canOpen, ...(canOpen ? {} : { note: NO_PERMISSION_NOTE }), keyPages: keyPages.map((p) => ({ ...p, link: erpLink(ctx.origin, p.path, null) ?? p.path })) };
      }),
    },
    `module_overview ${hits.map((m) => m.id).join(",")}`,
  );
}

function glossary(ctx: HowtoCtx, args: Record<string, unknown>): HowtoOutcome {
  const asked = str(args.term);
  if (!asked) return answer({ terms: GLOSSARY.map((t) => t.term) }, "glossary (list)");
  const exact = GLOSSARY.filter((t) => norm(t.term) === norm(asked) || t.aliases.some((a) => norm(a) === norm(asked)));
  const hits = exact.length ? exact : rank(GLOSSARY.map((t) => ({ ...t, id: t.term, title: [t.term, ...t.aliases].join(" "), keywords: [t.term, ...t.aliases, ...t.keywords] })), asked).slice(0, 3).map((h) => h.item);
  if (!hits.length) return answer({ matched: false, message: "That term is not in the glossary yet. Known terms:", terms: GLOSSARY.map((t) => t.term) }, redactQuestion(asked), NO_GUIDE_NOTE);
  return answer({ terms: hits.map((t) => ({ term: t.term, aliases: t.aliases, definition: t.definition, seeAlso: t.seeAlso, ...(t.page ? { link: erpLink(ctx.origin, t.page, null) } : {}) })) }, `glossary ${hits.map((t) => t.term).join(",")}`);
}

/** The error entries whose backend text appears in what the person pasted, longest match first; then a word-overlap fallback. */
export function matchErrors(pasted: string) {
  const t = norm(pasted);
  const direct = ERRORS.map((e) => ({ e, len: Math.max(0, ...e.match.map((m) => (t.includes(norm(m)) ? m.length : 0))) }))
    .filter((x) => x.len > 0)
    .sort((a, b) => b.len - a.len)
    .map((x) => x.e);
  if (direct.length) return direct.slice(0, 2);
  const words = new Set(queryTerms(pasted).words);
  return ERRORS.map((e) => {
    const best = Math.max(...e.match.map((m) => {
      const mw = wordsOf(m).filter((w) => !STOP.has(w));
      return mw.length ? mw.filter((w) => words.has(w)).length / mw.length : 0;
    }));
    return { e, best };
  })
    .filter((x) => x.best >= 0.6)
    .sort((a, b) => b.best - a.best)
    .slice(0, 2)
    .map((x) => x.e);
}

function explainError(args: Record<string, unknown>): HowtoOutcome {
  const pasted = str(args.text);
  if (!pasted) return { result: text("Paste the error message text (exactly as the ERP shows it).", true), status: 400, note: "", target: "explain_error" };
  const hits = matchErrors(pasted);
  if (!hits.length) return answer({ matched: false, message: "This message is not in the error guide yet. Read it to the person in plain words, and if it blocks them ask them to send a screenshot to IT Support." }, redactQuestion(pasted), NO_GUIDE_NOTE);
  return answer({ errors: hits.map(({ id, module, meaning, cause, fix }) => ({ id, module, meaning, cause, fix })) }, `explain_error ${hits.map((e) => e.id).join(",")}`);
}

function onboarding(ctx: HowtoCtx, args: Record<string, unknown>): HowtoOutcome {
  const asked = str(args.role);
  if (!asked) return answer({ roles: ONBOARDING.map((o) => ({ role: o.role, title: o.title })) }, "onboarding (list)");
  const exact = ONBOARDING.find((o) => o.role === norm(asked));
  const ranked = rank(ONBOARDING.map((o) => ({ ...o, id: o.role, keywords: [o.role, ...o.keywords] })), asked);
  const hit = exact ?? (ranked.length ? ranked[0].item : undefined);
  if (!hit) return answer({ matched: false, message: "No first-week path for that role. Roles:", roles: ONBOARDING.map((o) => o.role) }, redactQuestion(asked), NO_GUIDE_NOTE);
  return answer(
    {
      role: hit.role,
      title: hit.title,
      contact: hit.contact,
      days: hit.days.map((d) => ({
        day: d.day,
        goals: d.goals,
        guides: d.guides.map((id) => {
          const g = byId.get(id);
          return g ? { id, title: g.title, canDo: canOpenPage(g.page, ctx.user) } : { id };
        }),
        pages: d.pages.map((p) => erpLink(ctx.origin, p, null) ?? p),
      })),
      tip: "Call how_to with topic = a guide id for its full steps.",
    },
    `onboarding ${hit.role}`,
  );
}

const readOnly = { readOnlyHint: true, openWorldHint: false };

/** The help tools (no ERP data read; canDo comes from the person's own ERP permissions). */
export const HOWTO_TOOLS = [
  {
    name: "how_to",
    title: "How do I ... (step-by-step ERP guide)",
    description: "Step-by-step SOP for doing something in the ERP (create a sales order, PO, GRN, delivery order, invoice, receipt, service case, stock transfer, Mail Center reply, leave ...) and whole chains (sales, purchasing, after-sales, 2990's outlet POS). Returns the top 1-3 guides: purpose, prerequisites, fields, click-by-click steps with links that highlight the button to press, checks, warnings, undo, common mistakes, and canDo for this person. Guides are English; translate for the person.",
    inputSchema: { type: "object", properties: { question: { type: "string", description: "The person's question in their own words (any language)" }, topic: { type: "string", description: "A guide id from an earlier answer" } }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "module_overview",
    title: "What an ERP module is for",
    description: "What a sidebar module is for, its key pages (with links), who uses it and how it connects to the other modules. Leave out module for the list of all modules with one line each.",
    inputSchema: { type: "object", properties: { module: { type: "string", description: "Module name or sidebar label, e.g. Procurement, Service Cases, Finance" } }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "glossary",
    title: "What does this ERP term mean",
    description: "Plain-English meaning of a term or abbreviation in the ERP (SO, PO, GRN, DO, ASSR, credit note, AR aging, unapplied payment, 2990's, venue / fair, MRP, BOM, SKU, sen ...). Leave out term for the list.",
    inputSchema: { type: "object", properties: { term: { type: "string" } }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "explain_error",
    title: "Explain an ERP error message",
    description: "The meaning, cause and fix of an error or validation message the ERP showed. Pass the message text exactly as shown (read it off a screenshot if needed).",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The error text" } }, required: ["text"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "onboarding",
    title: "First-week path for a new staff member",
    description: "A day-by-day first-week learning path for a role (outlet-sales, 2990s, purchasing, warehouse, finance, after-sales, admin) with the guides and pages to practise. Leave out role for the list.",
    inputSchema: { type: "object", properties: { role: { type: "string" } }, additionalProperties: false },
    annotations: readOnly,
  },
] as const;

const NAMES = new Set<string>(HOWTO_TOOLS.map((t) => t.name));
/** Is this one of the help tools? */
export const isHowtoTool = (name: string): boolean => NAMES.has(name);

/** Run a help tool. Pure: no reads, no writes; routes/mcp.ts logs the outcome. */
export function runHowtoTool(ctx: HowtoCtx, name: string, args: Record<string, unknown>): HowtoOutcome {
  switch (name) {
    case "how_to":
      return howTo(ctx, args);
    case "module_overview":
      return moduleOverview(ctx, args);
    case "glossary":
      return glossary(ctx, args);
    case "explain_error":
      return explainError(args);
    case "onboarding":
      return onboarding(ctx, args);
    default:
      return { result: text(`Unknown tool: ${name}`, true), status: 400, note: "", target: name };
  }
}

/** The help part of the server instructions. */
export const HOWTO_INSTRUCTIONS = `HELP (no ERP data, always available): "how do I / where do I / steps to ..." -> how_to {question}; give the steps in the person's language, keep the quoted button names in English as the screen shows them, and give each step's link (it highlights the button); a step with showMe has a screenshot: call show_me {guide_id, step} when the person wants to see where to click. If canDo is false say: you don't have permission for this in the ERP — ask your supervisor or admin. "What is module X" -> module_overview; "what does X mean" -> glossary; an error message -> explain_error {text}; a new staff member -> onboarding {role}.`;

/** Ready-made prompts for the help tools. */
export const HOWTO_PROMPTS = [
  { name: "how_do_i", title: "How do I ...", description: "Step-by-step guide for an ERP task. Uses how_to.", arguments: [{ name: "task", description: "What you want to do, e.g. open a service case", required: true }] },
  { name: "explain_module", title: "Explain a module", description: "What a module is for and how it connects. Uses module_overview.", arguments: [{ name: "module", description: "Module name (default: all)", required: false }] },
  { name: "what_does_it_mean", title: "What does this term mean", description: "Plain meaning of an ERP term. Uses glossary.", arguments: [{ name: "term", description: "The term or abbreviation", required: true }] },
  { name: "explain_this_error", title: "Explain this error", description: "What an ERP error means and how to fix it. Uses explain_error.", arguments: [{ name: "error", description: "The error text", required: true }] },
  { name: "my_first_week", title: "My first week", description: "A first-week learning path for a role. Uses onboarding.", arguments: [{ name: "role", description: "outlet-sales, 2990s, purchasing, warehouse, finance, after-sales or admin", required: false }] },
] as const;

/** The message for a help prompt, or null for a name that is not one. */
export function howtoPromptText(name: string, a: Record<string, unknown>): string | null {
  const v = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim().slice(0, 200) : "");
  const close = " Answer in my language, keep button names as the screen shows them, and give the links.";
  switch (name) {
    case "how_do_i":
      return `How do I ${v("task") || "do this"} in the ERP? Call how_to {question: "${v("task")}"} and walk me through it step by step, with what to fill, what to check before confirming and what happens after.${close}`;
    case "explain_module":
      return v("module") ? `Explain the ${v("module")} module. Call module_overview {module: "${v("module")}"}: what it is for, its key pages, who uses it and how it connects to the others.${close}` : `What modules does the ERP have? Call module_overview and list them with one line each.${close}`;
    case "what_does_it_mean":
      return `What does "${v("term")}" mean in the ERP? Call glossary {term: "${v("term")}"}.${close}`;
    case "explain_this_error":
      return `The ERP showed this error: "${v("error")}". Call explain_error {text} and tell me what it means, why it happened and how to fix it.${close}`;
    case "my_first_week":
      return `I am new. Call onboarding${v("role") ? ` {role: "${v("role")}"}` : ""} and give me my first-week plan, day by day.${close}`;
    default:
      return null;
  }
}
