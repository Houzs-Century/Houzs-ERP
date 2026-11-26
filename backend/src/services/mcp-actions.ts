// ---------------------------------------------------------------------------
// mcp-actions.ts — the pure half of the AI Connector's actions, document flow and
// print links (routes/mcp.ts does the calls; this checks and shapes).
//
// Owner 2026-11-26: the connector may book a meeting and send an email for the
// signed-in person, "confirm first, then do" — never orders, money, stock,
// approvals or deletes. propose_* checks the request here the way the real form
// would, routes/mcp.ts stores it (mcp_pending_actions) and returns the summary;
// confirm_action then calls the ERP's OWN route as the person
// (services/mcp-inner.ts ACTION_ALLOWLIST is the only door).
// ---------------------------------------------------------------------------
import { FETCH_KINDS } from "./mcp-quick";
import { fmtDateTime } from "../scm/shared/format";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map(str).filter(Boolean);

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_CONFIRMED_PER_DAY = 30;
export const ACTIONS_SETTING_KEY = "mcp_actions_enabled";
export const ACTIONS_OFF = "AI actions are switched off by your admin.";
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ActionKind = "meeting" | "email";
export type Proposal = { ok: true; kind: ActionKind; payload: Obj; summary: string; logLine: string } | { ok: false; error: string };


const MY_OFFSET_MS = 8 * 3600_000;

/** "2026-11-27T15:00" (Malaysia time) or any ISO with an offset → epoch ms; null when unreadable. */
export function parseWhen(raw: unknown): number | null {
  const s = str(raw);
  if (!s) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, se] = local;
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), se ? Number(se) : 0) - MY_OFFSET_MS;
    return Number.isFinite(t) ? t : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** "2026/11/27 15:00 to 16:30" in Malaysia time, in the ERP's one date format (scm/shared/format.ts). */
export function myRange(start: number, end: number): string {
  const a = fmtDateTime(new Date(start));
  const b = fmtDateTime(new Date(end));
  return a.slice(0, 10) === b.slice(0, 10) ? `${a} to ${b.slice(11)}` : `${a} to ${b}`;
}


export type MeetingPerson = { key: string; name: string; email: string | null };
export type MeetingRoom = { id: number; name: string; active: boolean };
export type MeetingBootstrap = { me: string; people: MeetingPerson[]; rooms: MeetingRoom[] };

export function readBootstrap(v: unknown): MeetingBootstrap {
  const b = obj(v);
  return {
    me: str(b.me),
    people: arr(b.people).map(obj).map((p) => ({ key: str(p.key), name: str(p.name), email: str(p.email) || null })).filter((p) => p.key),
    rooms: arr(b.rooms).map(obj).map((r) => ({ id: Number(r.id), name: str(r.name), active: r.active !== false })).filter((r) => Number.isInteger(r.id) && r.id > 0),
  };
}

type PersonPick = { ok: true; person: MeetingPerson } | { ok: false; why: string };

/** One attendee by email or name: exact email, exact name, else the ONE name containing it. */
export function pickPerson(q: string, people: MeetingPerson[]): PersonPick {
  const lc = q.toLowerCase();
  const byEmail = people.find((p) => (p.email ?? "").toLowerCase() === lc);
  if (byEmail) return { ok: true, person: byEmail };
  const exact = people.filter((p) => p.name.toLowerCase() === lc);
  if (exact.length === 1) return { ok: true, person: exact[0] };
  const near = exact.length > 1 ? exact : people.filter((p) => p.name.toLowerCase().includes(lc));
  if (near.length === 1) return { ok: true, person: near[0] };
  if (near.length === 0) return { ok: false, why: `No staff member matches "${q}".` };
  const names = near.slice(0, 5).map((p) => (p.email ? `${p.name} <${p.email}>` : p.name));
  return { ok: false, why: `"${q}" matches ${near.length} people (${names.join("; ")}${near.length > 5 ? "; ..." : ""}). Use their email.` };
}

/** propose_meeting → the body routes/meetings.ts POST /meetings takes (frontend lib/meetings.ts draftBody), checked. */
export function proposeMeeting(args: Obj, boot: MeetingBootstrap, now: number): Proposal {
  const title = str(args.title).slice(0, 200);
  if (!title) return { ok: false, error: "A meeting needs a title." };
  if (!boot.me) return { ok: false, error: "Your meeting calendar could not be read. Try again in a moment." };
  const start = parseWhen(args.start);
  if (start === null) return { ok: false, error: 'Give start as "YYYY-MM-DDTHH:MM" (Malaysia time) or an ISO time with offset.' };
  const end = args.end === undefined || args.end === null || args.end === "" ? start + 60 * 60_000 : parseWhen(args.end);
  if (end === null) return { ok: false, error: 'Give end as "YYYY-MM-DDTHH:MM" (Malaysia time) or leave it out for one hour.' };
  if (end <= start) return { ok: false, error: "The meeting must end after it starts." };
  if (end - start > 12 * 3600_000) return { ok: false, error: "A meeting can be at most 12 hours long." };
  if (start < now - 5 * 60_000) return { ok: false, error: "That time has already passed." };
  if (start > now + 366 * 24 * 3600_000) return { ok: false, error: "Book at most a year ahead." };

  const wanted = strList(args.attendees).slice(0, 51);
  if (wanted.length > 50) return { ok: false, error: "At most 50 attendees." };
  const keys: string[] = [];
  const names: string[] = [];
  const guests: string[] = [];
  const problems: string[] = [];
  for (const w of wanted) {
    const pick = pickPerson(w, boot.people);
    if (pick.ok) {
      if (pick.person.key !== boot.me && !keys.includes(pick.person.key)) {
        keys.push(pick.person.key);
        names.push(pick.person.name);
      }
    } else if (EMAIL_RE.test(w)) {
      if (!guests.includes(w.toLowerCase())) guests.push(w.toLowerCase());
    } else {
      problems.push(pick.why);
    }
  }
  if (problems.length) return { ok: false, error: problems.join(" ") };

  let roomId: number | null = null;
  let roomName = "";
  const roomQ = str(args.room);
  if (roomQ) {
    const live = boot.rooms.filter((r) => r.active);
    const lc = roomQ.toLowerCase();
    const exact = live.filter((r) => r.name.toLowerCase() === lc);
    const near = exact.length ? exact : live.filter((r) => r.name.toLowerCase().includes(lc));
    if (near.length !== 1) {
      return { ok: false, error: near.length ? `"${roomQ}" matches ${near.map((r) => r.name).join(", ")}. Name one room.` : `No meeting room is called "${roomQ}". Rooms: ${live.map((r) => r.name).join(", ") || "none"}.` };
    }
    roomId = near[0].id;
    roomName = near[0].name;
  }
  const notes = str(args.notes).slice(0, 2000);
  const payload = {
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    roomId,
    organizer: boot.me,
    attendees: keys,
    videoType: "none",
    videoUrl: "",
    notes,
    guestEmails: guests,
    reminders: [{ min: 15, ch: ["erp", "email"] }],
    repeat: "none",
    repeatUntil: null,
  };
  const lines = [
    `Book a meeting: "${title}"`,
    `When: ${myRange(start, end)} (Malaysia time)`,
    `Where: ${roomName || "no room"}`,
    `Organiser: you`,
    `Staff invited: ${names.length ? names.join(", ") : "none"}`,
  ];
  if (guests.length) lines.push(`Outside guests (they get an email invitation): ${guests.join(", ")}`);
  if (notes) lines.push(`Notes: ${notes}`);
  const logLine = `meeting "${title}" ${myRange(start, end)}, ${keys.length + guests.length} invited`;
  return { ok: true, kind: "meeting", payload, summary: lines.join("\n"), logLine };
}


export const MAX_RECIPIENTS = 20;
export const MAX_BODY_CHARS = 20_000;

/** propose_email → the body routes/mail-center.ts POST /compose takes, checked the way Compose checks it. */
export function proposeEmail(args: Obj, senders: string[]): Proposal {
  const to = strList(args.to);
  const cc = strList(args.cc);
  const subject = str(args.subject).slice(0, 300);
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (to.length === 0) return { ok: false, error: "Give at least one recipient (to)." };
  if (to.length + cc.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` };
  const bad = [...to, ...cc].find((a) => !EMAIL_RE.test(a));
  if (bad) return { ok: false, error: `Not a valid email address: ${bad}` };
  if (!subject) return { ok: false, error: "The email needs a subject." };
  if (!body) return { ok: false, error: "The email needs a message." };
  if (body.length > MAX_BODY_CHARS) return { ok: false, error: `The message is too long (at most ${MAX_BODY_CHARS} characters).` };

  const allowed = senders.map((s) => s.toLowerCase());
  if (allowed.length === 0) return { ok: false, error: "You have no mailbox you may send from in the Mail Center. Ask your admin." };
  const asked = str(args.from_mailbox).toLowerCase();
  let from: string;
  if (asked) {
    if (!allowed.includes(asked)) return { ok: false, error: `You may not send from ${asked}. You may send from: ${allowed.join(", ")}.` };
    from = asked;
  } else if (allowed.length === 1) {
    from = allowed[0];
  } else {
    return { ok: false, error: `Which mailbox should it come from? Pass from_mailbox, one of: ${allowed.join(", ")}.` };
  }
  const payload = { fromAddress: from, to, cc, subject, text: body };
  const preview = body.length > 1500 ? `${body.slice(0, 1500)}\n[... ${body.length - 1500} more characters]` : body;
  const lines = [`Send an email (it leaves the company)`, `From: ${from}`, `To: ${to.join(", ")}`];
  if (cc.length) lines.push(`Cc: ${cc.join(", ")}`);
  lines.push(`Subject: ${subject}`, "", preview);
  const logLine = `email to ${to[0]}${to.length + cc.length > 1 ? ` +${to.length + cc.length - 1}` : ""}: "${subject.slice(0, 80)}"`;
  return { ok: true, kind: "email", payload, summary: lines.join("\n"), logLine };
}

/** The ERP's answer to a confirmed action, in one sentence. */
export function actionOutcome(kind: ActionKind, status: number, body: unknown): { ok: boolean; text: string } {
  const b = obj(body);
  if (status >= 200 && status < 300) {
    if (kind === "meeting") {
      const ids = arr(b.ids).map(Number).filter((n) => Number.isInteger(n));
      return { ok: true, text: `Done: the meeting is booked${ids.length ? ` (meeting ${ids.join(", ")})` : ""}. Invitations go out from the ERP.` };
    }
    return { ok: true, text: b.queued === true ? "Done: the email is queued and will be sent in a moment." : "Done: the email was sent. It is in the Mail Center under that mailbox." };
  }
  const err = str(b.error) || str(b.message);
  if (status === 409 && kind === "meeting") {
    return { ok: false, text: `Not booked: that time clashes${err ? ` (${err})` : ""}. Propose another time.` };
  }
  if (status === 401 || status === 403) return { ok: false, text: `Not done: the ERP says you may not do this${err ? ` (${err})` : ""}.` };
  return { ok: false, text: `Not done: the ERP answered ${status}${err ? ` (${err})` : ""}.` };
}


/** Relationship-map node types (scm/routes/document-flow.ts) → words, detail endpoint and ERP page. */
export const FLOW_TYPES: Record<string, { word: string; fetch: string | null; page: ((id: string) => string) | null }> = {
  so: { word: "Sales order", fetch: "sales_order", page: FETCH_KINDS.sales_order.page },
  do: { word: "Delivery order", fetch: "delivery_order", page: FETCH_KINDS.delivery_order.page },
  si: { word: "Sales invoice", fetch: "sales_invoice", page: FETCH_KINDS.sales_invoice.page },
  payment: { word: "Customer payment", fetch: null, page: null },
  po: { word: "Purchase order", fetch: "purchase_order", page: FETCH_KINDS.purchase_order.page },
  grn: { word: "Goods received note", fetch: "grn", page: FETCH_KINDS.grn.page },
  pi: { word: "Purchase invoice", fetch: "purchase_invoice", page: FETCH_KINDS.purchase_invoice.page },
  dr: { word: "Delivery return", fetch: "delivery_return", page: FETCH_KINDS.delivery_return.page },
  pr: { word: "Purchase return", fetch: null, page: (id) => `/scm/purchase-returns/${encodeURIComponent(id)}` },
  cso: { word: "Consignment order", fetch: null, page: (id) => `/scm/consignment-orders/${encodeURIComponent(id)}` },
  cdo: { word: "Consignment note", fetch: null, page: (id) => `/scm/consignment-notes/${encodeURIComponent(id)}` },
  cdr: { word: "Consignment return", fetch: null, page: (id) => `/scm/consignment-returns/${encodeURIComponent(id)}` },
  pco: { word: "Purchase consignment order", fetch: null, page: (id) => `/scm/purchase-consignment-orders/${encodeURIComponent(id)}` },
  pcr: { word: "Purchase consignment receive", fetch: null, page: (id) => `/scm/purchase-consignment-receives/${encodeURIComponent(id)}` },
  pcrn: { word: "Purchase consignment return", fetch: null, page: (id) => `/scm/purchase-consignment-returns/${encodeURIComponent(id)}` },
};

/** A relationship-map node type's entry, or null for one this file does not know. */
export const flowSpec = (t: string) => (Object.prototype.hasOwnProperty.call(FLOW_TYPES, t) ? FLOW_TYPES[t] : null);

/** /api/search hit types that anchor a relationship map. */
export const SEARCH_TO_FLOW: Record<string, string> = {
  sales_order: "so",
  delivery_order: "do",
  sales_invoice: "si",
  purchase_order: "po",
  grn: "grn",
  purchase_invoice: "pi",
  delivery_return: "dr",
};

/** "sales_order:HC-SO-1" or "so:HC-SO-1" → the flow anchor; null for a plain number (search it). */
export function flowAnchorFromId(raw: string): { type: string; id: string } | null {
  const m = /^([a-z_]{2,40}):([A-Za-z0-9._-]{1,80})$/.exec(raw.trim());
  if (!m) return null;
  const type = Object.prototype.hasOwnProperty.call(SEARCH_TO_FLOW, m[1]) ? SEARCH_TO_FLOW[m[1]] : Object.prototype.hasOwnProperty.call(FLOW_TYPES, m[1]) ? m[1] : null;
  return type ? { type, id: m[2] } : null;
}

/** The search hit the number names: an exact title match first, else the first hit that has a map. */
export function flowAnchorFromSearch(body: unknown, query: string): { type: string; id: string; title: string } | null {
  const hits = arr(obj(body).hits).map(obj).filter((h) => Object.prototype.hasOwnProperty.call(SEARCH_TO_FLOW, str(h.type)) && str(h.id));
  const lc = query.trim().toLowerCase();
  const h = hits.find((x) => str(x.title).toLowerCase() === lc) ?? (hits.length > 0 ? hits[0] : undefined);
  return h ? { type: SEARCH_TO_FLOW[str(h.type)], id: str(h.id), title: str(h.title) } : null;
}

const DATE_KEYS = ["so_date", "do_date", "invoice_date", "po_date", "grn_date", "received_at", "return_date", "doc_date", "soDate", "doDate", "invoiceDate", "poDate", "receivedAt", "returnDate", "date", "created_at", "createdAt"];
const AMOUNT_KEYS = ["grand_total_sen", "grandTotalSen", "total_sen", "totalSen", "net_total_sen", "netTotalSen", "total_amount_sen", "totalAmountSen", "amount_sen", "amountSen"];

/** A document's date and amount (RM) from its detail reply: top level, then one level down. */
export function pickDateAmount(detail: unknown): { date: string | null; amountRM: number | null } {
  const top = obj(detail);
  const levels = [top, ...Object.values(top).filter((v) => v && typeof v === "object" && !Array.isArray(v)).map(obj)];
  let date: string | null = null;
  let amountRM: number | null = null;
  for (const level of levels) {
    if (date === null) {
      for (const k of DATE_KEYS) {
        const v = str(level[k]);
        if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
          date = v.slice(0, 10);
          break;
        }
      }
    }
    if (amountRM === null) {
      for (const k of AMOUNT_KEYS) {
        const n = Number(level[k]);
        if (level[k] !== null && level[k] !== undefined && level[k] !== "" && Number.isFinite(n)) {
          amountRM = Math.round(n) / 100;
          break;
        }
      }
    }
  }
  return { date, amountRM };
}

export type FlowLink = { type: string; number: string; status: string | null; date: string | null; amountRM: number | null; url: string | null; isAnchor: boolean; nodeType: string; id: string };

const EDGE_WORD: Record<string, string> = { full: "full transfer", partial: "partial transfer", value: "bought for", payment: "payment" };

/** The relationship map as links (in chain order) and readable steps. `extra` carries date / amount per node key. */
export function shapeFlow(body: unknown, origin: string, extra: Map<string, { date: string | null; amountRM: number | null }>): { links: FlowLink[]; steps: string[]; incomplete: string[] } {
  const b = obj(body);
  const order = Object.keys(FLOW_TYPES);
  const nodes = arr(b.nodes).map(obj);
  const byKey = new Map<string, FlowLink>();
  for (const n of nodes) {
    const nodeType = str(n.type);
    const spec = flowSpec(nodeType);
    const id = str(n.id);
    const key = str(n.key) || `${nodeType}:${id}`;
    const more = extra.get(key) ?? { date: null, amountRM: null };
    byKey.set(key, {
      type: spec?.word ?? nodeType,
      number: str(n.label) || id,
      status: str(n.status) || null,
      date: more.date,
      amountRM: more.amountRM,
      url: spec?.page && id ? origin + spec.page(id) : null,
      isAnchor: n.isAnchor === true,
      nodeType,
      id,
    });
  }
  const links = [...byKey.values()].sort((x, y) => order.indexOf(x.nodeType) - order.indexOf(y.nodeType) || x.number.localeCompare(y.number));
  const steps: string[] = [];
  for (const e of arr(b.edges).map(obj)) {
    const from = byKey.get(str(e.from));
    const to = byKey.get(str(e.to));
    if (!from || !to) continue;
    const kind = str(e.kind);
    steps.push(`${from.type} ${from.number} -> ${to.type} ${to.number}${EDGE_WORD[kind] ? ` (${EDGE_WORD[kind]})` : ""}`);
  }
  const incomplete = arr(b.degraded).map(str).filter(Boolean);
  return { links, steps, incomplete };
}


export const EXPORT_TTL_MS = 15 * 60 * 1000;
export const EXPORT_PREFIX = "mcp-exports/";
export const EXPORT_KEY_RE = /^[A-Za-z0-9_-]{40,64}$/;

/** Documents get_pdf knows. `print` = the ERP's own server-side print route; otherwise the PDF is made in the browser. */
export const PDF_KINDS: Record<string, { print: ((id: string) => string) | null; financeOnly: boolean }> = {
  sales_order: { print: null, financeOnly: false },
  delivery_order: { print: null, financeOnly: false },
  sales_invoice: { print: null, financeOnly: false },
  purchase_order: { print: null, financeOnly: false },
  grn: { print: null, financeOnly: false },
  purchase_invoice: { print: null, financeOnly: false },
  credit_note: { print: null, financeOnly: false },
  delivery_return: { print: null, financeOnly: false },
  payment_voucher: { print: null, financeOnly: false },
  assr_case: { print: (id) => `/api/assr-print/${encodeURIComponent(id)}?variant=customer`, financeOnly: false },
  project: { print: (id) => `/api/projects-print/${encodeURIComponent(id)}`, financeOnly: true },
};

export const pdfKind = (t: string) => (Object.prototype.hasOwnProperty.call(PDF_KINDS, t) ? PDF_KINDS[t] : null);

/** Is an export link still alive? Missing or unreadable expiry = expired. */
export function exportAlive(expiresAt: string | undefined, now: number): boolean {
  const t = Date.parse(expiresAt ?? "");
  return Number.isFinite(t) && t > now;
}
