import { COMPANY_MAIL_DOMAINS, EMAIL_RE, MAX_BODY_CHARS, MAX_RECIPIENTS, mayReceive } from "./mcp-actions";
import { actionRoute } from "./mcp-inner";
import { ASSR_NOTE_CATEGORIES } from "./assrNoteCategories";
import type { ActionSwitches } from "./mcp-store";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map(str).filter(Boolean);
const trim = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pick = (o: Obj, ...keys: string[]): string => {
  for (const k of keys) if (str(o[k])) return str(o[k]);
  return "";
};

/** Every kind an AI action can be. meeting / email follow the master switch only; the rest also need their own switch. */
export const ALL_ACTION_KINDS = ["meeting", "email", "mail_reply", "note"] as const;
export type AnyActionKind = (typeof ALL_ACTION_KINDS)[number];
export type WriteKind = "mail_reply" | "note";
export const isActionKind = (k: string): k is AnyActionKind => (ALL_ACTION_KINDS as readonly string[]).includes(k);

/** The propose tool that prepares each kind. */
export const PROPOSE_TOOL: Record<AnyActionKind, string> = { meeting: "propose_meeting", email: "propose_email", mail_reply: "propose_mail_reply", note: "propose_note" };

/** May this kind be proposed / confirmed right now? The master switch, and for the round-4b kinds their own switch too. */
export function kindAllowed(kind: AnyActionKind, sw: ActionSwitches): boolean {
  if (!sw.master) return false;
  if (kind === "mail_reply" || kind === "note") return sw[kind];
  return true;
}

/** Why a kind is refused, in one sentence for the person. */
export function kindOffText(kind: AnyActionKind, sw: ActionSwitches): string {
  if (!sw.master) return "AI actions are switched off by your admin.";
  const what = kind === "mail_reply" ? "Replying to Mail Center emails" : kind === "note" ? "Adding notes to service cases" : "This AI action";
  return `${what} through the AI is switched off by your admin.`;
}

export type WriteProposal =
  | { ok: true; kind: WriteKind; id: string; path: string; payload: Obj; summary: string; logLine: string; entity: { type: string; id: string } }
  | { ok: false; error: string };

export const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** thread_search → one thread from the Mail Center list (/api/mail-center/threads?q=), or the candidates to choose from. */
export function pickThread(list: unknown, query: string): { ok: true; id: string } | { ok: false; error: string } {
  const rows = (Array.isArray(list) ? arr(list) : arr(obj(list).threads)).filter((t) => THREAD_ID_RE.test(str(t.id)));
  if (rows.length === 1) return { ok: true, id: str(rows[0].id) };
  const lc = query.toLowerCase();
  const exact = rows.filter((t) => str(t.subject).toLowerCase() === lc || str(t.counterpartyEmail).toLowerCase() === lc);
  if (exact.length === 1) return { ok: true, id: str(exact[0].id) };
  if (rows.length === 0) return { ok: false, error: `No Mail Center email in your mailboxes matches "${query}".` };
  const lines = rows.slice(0, 5).map((t) => `- thread_id ${str(t.id)}: "${trim(str(t.subject), 80)}" with ${str(t.counterpartyName) || str(t.counterpartyEmail)} (last ${str(t.lastMessageAt).slice(0, 10)})`);
  return { ok: false, error: `"${query}" matches ${rows.length} emails. Ask the person which one, then propose again with its thread_id:\n${lines.join("\n")}` };
}

/** propose_mail_reply → the body routes/mail-center.ts POST /threads/:id/reply takes, with the recipients fixed so what is shown is what is sent. */
export function proposeMailReply(args: Obj, detail: unknown, senders: readonly string[], me: string | null): WriteProposal {
  const d = obj(detail);
  const thread = obj(d.thread);
  const id = str(thread.id);
  if (!THREAD_ID_RE.test(id)) return { ok: false, error: "That Mail Center email could not be read. Check the thread_id." };
  const text = typeof args.body === "string" ? args.body.trim() : "";
  if (!text) return { ok: false, error: "The reply needs a message (body)." };
  if (text.length > MAX_BODY_CHARS) return { ok: false, error: `The reply is too long (at most ${MAX_BODY_CHARS} characters).` };

  const messages = arr(d.messages);
  const inbound = messages.filter((m) => str(m.direction) === "inbound");
  const lastIn = inbound.length ? inbound[inbound.length - 1] : null;
  const last = messages.length ? messages[messages.length - 1] : null;
  const mailbox = str(thread.mailboxAddress).toLowerCase();
  const mine = new Set([mailbox, ...senders.map((s) => s.toLowerCase())].filter(Boolean));

  let to = strList(args.to);
  if (to.length === 0) to = strList(lastIn ? str(lastIn.fromAddress) || str(thread.counterpartyEmail) : str(thread.counterpartyEmail));
  let cc = strList(args.cc);
  if (cc.length === 0 && args.reply_all === true && lastIn) {
    const onTo = new Set(to.map((a) => a.toLowerCase()));
    cc = [...strList(lastIn.toAddresses), ...strList(lastIn.ccAddresses)].filter((a, i, all) => !onTo.has(a.toLowerCase()) && !mine.has(a.toLowerCase()) && all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i);
  }
  if (to.length === 0) return { ok: false, error: "This email has no address to reply to. Reply in the Mail Center." };
  if (to.length + cc.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
  const bad = [...to, ...cc].find((a) => !EMAIL_RE.test(a));
  if (bad) return { ok: false, error: `Not a valid email address: ${bad}` };
  const onThread = new Set([str(thread.counterpartyEmail), ...messages.flatMap((m) => [str(m.fromAddress), ...strList(m.toAddresses), ...strList(m.ccAddresses)])].map((a) => a.toLowerCase()));
  const outside = [...to, ...cc].find((a) => !onThread.has(a.toLowerCase()) && !mayReceive(a, me));
  if (outside) return { ok: false, error: `For now the AI may reply only to people already on this email, company addresses (@${COMPANY_MAIL_DOMAINS.join(", @")}) or you. ${outside} is not: reply in the Mail Center.` };

  const route = actionRoute("mail_reply", id);
  if (!route) return { ok: false, error: "That Mail Center email cannot be replied to through the AI." };
  const subject = str(thread.subject) || "(no subject)";
  const payload: Obj = { text, to, cc, afterMessageId: last ? str(last.id) || null : null };
  const preview = text.length > 1500 ? `${text.slice(0, 1500)}\n[... ${text.length - 1500} more characters]` : text;
  const lines = [
    "Reply to a Mail Center email (it leaves the company)",
    `Thread: "${subject}" with ${str(thread.counterpartyName) ? `${str(thread.counterpartyName)} <${str(thread.counterpartyEmail)}>` : str(thread.counterpartyEmail) || "(unknown)"}`,
    `From mailbox: ${mailbox || "(the thread's mailbox)"}`,
  ];
  if (lastIn) lines.push(`Replying to: ${str(lastIn.fromName) || str(lastIn.fromAddress)}, ${str(lastIn.receivedAt || lastIn.createdAt).slice(0, 16).replace("T", " ")}: "${trim(str(lastIn.textBody).replace(/\s+/g, " "), 300)}"`);
  if (last && str(last.direction) === "outbound") lines.push(`Note: the last message in this thread is already from us (${str(last.sentByName) || str(last.fromName) || "a colleague"}, ${str(last.createdAt).slice(0, 10)}).`);
  lines.push(`To: ${to.join(", ")}`);
  if (cc.length) lines.push(`Cc: ${cc.join(", ")}`);
  lines.push(`Subject: ${/^re:/i.test(subject) ? subject : `Re: ${subject}`}`, "", preview);
  const logLine = `mail reply on "${trim(subject, 80)}" to ${to[0]}${to.length + cc.length > 1 ? ` +${to.length + cc.length - 1}` : ""}`;
  return { ok: true, kind: "mail_reply", id, path: route.path, payload, summary: lines.join("\n"), logLine, entity: { type: "email_thread", id } };
}

export const NOTE_CATEGORIES = ASSR_NOTE_CATEGORIES;
export const MAX_NOTE_CHARS = 4000;

/** "123", "assr_case:123" → the case id; anything else is a case number to look up. */
export function caseIdFrom(raw: unknown): { id: string } | { number: string } | null {
  const s = str(raw);
  if (!s) return null;
  const m = /^(?:assr_case:)?(\d{1,12})$/.exec(s);
  if (m) return { id: m[1] };
  return /^[A-Za-z0-9._/-]{2,40}$/.test(s) ? { number: s } : null;
}

/** A case number → its id from the case list (/api/assr?search=): the exact number only. */
export function caseIdFromList(list: unknown, number: string): string | null {
  const lc = number.toLowerCase();
  const hit = arr(obj(list).data).find((c) => str(c.assr_no).toLowerCase() === lc);
  return hit && /^\d{1,12}$/.test(str(hit.id)) ? str(hit.id) : null;
}

/** propose_note (service case) → the body routes/assr.ts POST /:id/notes takes, checked the way the case page checks it. */
export function proposeNote(args: Obj, detail: unknown): WriteProposal {
  const d = obj(detail);
  const kase = Object.keys(obj(d.case)).length ? obj(d.case) : d;
  const id = str(kase.id);
  if (!/^\d{1,12}$/.test(id)) return { ok: false, error: "That service case could not be read. Check the case number." };
  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (!note) return { ok: false, error: "The note is empty." };
  if (note.length > MAX_NOTE_CHARS) return { ok: false, error: `The note is too long (at most ${MAX_NOTE_CHARS} characters).` };
  const rawCat = str(args.category).toLowerCase();
  if (rawCat && !(NOTE_CATEGORIES as readonly string[]).includes(rawCat)) return { ok: false, error: `category is one of: ${NOTE_CATEGORIES.join(", ")}.` };
  const category = rawCat || "service";
  const route = actionRoute("note", id);
  if (!route) return { ok: false, error: "That service case cannot take a note through the AI." };
  const number = pick(kase, "assr_no", "assrNo") || `#${id}`;
  const customer = pick(kase, "customer_name", "customerName");
  const stage = pick(kase, "stage");
  const lines = [
    `Add a note to service case ${number}${customer ? ` (${customer}` : ""}${customer && stage ? `, stage ${stage})` : customer ? ")" : stage ? ` (stage ${stage})` : ""}`,
    `Category: ${category}`,
    "It appears on the case timeline under your name.",
    "",
    note.length > 1500 ? `${note.slice(0, 1500)}\n[... ${note.length - 1500} more characters]` : note,
  ];
  return { ok: true, kind: "note", id, path: route.path, payload: { note, category }, summary: lines.join("\n"), logLine: `note on case ${number}: "${trim(note.replace(/\s+/g, " "), 80)}"`, entity: { type: "service_case", id } };
}

/** The ERP's answer to a confirmed reply / note, in one sentence. */
export function writeOutcome(kind: WriteKind, status: number, body: unknown): { ok: boolean; text: string } {
  const b = obj(body);
  const err = str(b.error) || str(b.message);
  if (status >= 200 && status < 300) {
    if (kind === "note") return { ok: true, text: "Done: the note is on the service case timeline." };
    return { ok: true, text: b.queued === true ? "Done: the reply is queued and will be sent in a moment. It shows in the thread in the Mail Center." : "Done: the reply was sent. It shows in the thread in the Mail Center." };
  }
  if (status === 409 && kind === "mail_reply") return { ok: false, text: `Not sent: ${err || "someone else already replied"} since this reply was drafted. Read the thread in the Mail Center before replying again.` };
  if (status === 404) return { ok: false, text: `Not done: the ERP could not find it, or it is not in your scope${err ? ` (${err})` : ""}.` };
  if (status === 401 || status === 403) return { ok: false, text: `Not done: the ERP says you may not do this${err ? ` (${err})` : ""}.` };
  return { ok: false, text: `Not done: the ERP answered ${status}${err ? ` (${err})` : ""}.` };
}

const actionHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const CONFIRM_RULE = "Show this summary to the person and ask them to confirm. Only call confirm_action after they explicitly say yes.";
const COMPANY = { type: "string", enum: ["HOUZS", "2990"], description: "Which company's data (default HOUZS)" };

/** Round 4b action tools (owner 2026-11-26). Each is OFF until an admin turns its own switch on. */
export const WRITE_TOOLS = [
  {
    name: "propose_mail_reply",
    title: "Propose a reply to a Mail Center email (the person confirms)",
    description: `Prepare a reply in one of the person's own Mail Center threads, sent through the Mail Center like the Reply button. Nothing is sent yet: it returns the thread, the recipients and the draft, and a confirmationId. ${CONFIRM_RULE} Give thread_id, or thread_search (subject, sender name or email) to find it; if several match you get the list to choose from. To defaults to the last sender; reply_all adds the others on that email. Plain text, no attachments.`,
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "The Mail Center thread id" },
        thread_search: { type: "string", description: "Subject, sender name or email, to find the thread when there is no thread_id" },
        body: { type: "string", description: "The reply, plain text" },
        reply_all: { type: "boolean", description: "Also copy everyone else on the last email (default false)" },
        to: { type: "array", items: { type: "string" }, description: "Override who it goes to (default: the last sender)" },
        cc: { type: "array", items: { type: "string" } },
        company: COMPANY,
      },
      required: ["body"],
      additionalProperties: false,
    },
    annotations: actionHint,
  },
  {
    name: "propose_note",
    title: "Propose a note on a service case (the person confirms)",
    description: `Prepare a note on an after-sales service case (ASSR), the same as Add note on the case page. Nothing is written yet: it returns a summary and a confirmationId. ${CONFIRM_RULE} Sales orders, purchase orders and customers have no note feature in the ERP, so only service cases take notes.`,
    inputSchema: {
      type: "object",
      properties: {
        record_type: { type: "string", enum: ["service_case"], description: "What the note goes on (only service cases have notes)" },
        id: { type: "string", description: "The case: its number (e.g. from search) or an id such as assr_case:123" },
        note: { type: "string", description: "The note, plain text" },
        category: { type: "string", enum: [...NOTE_CATEGORIES], description: "Which timeline tab it belongs to (default service)" },
        company: COMPANY,
      },
      required: ["id", "note"],
      additionalProperties: false,
    },
    annotations: actionHint,
  },
];
