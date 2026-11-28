import { addDays, poDueDate } from "./mcp-brief";
import { rm } from "./mcp-quick";
import { daysBetween } from "./mcp-quick2";
import { fmtDate, fmtDateTime, fmtSen } from "../scm/shared/format";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const enc = encodeURIComponent;

/**
 * Round 4d: the morning brief and urgent alerts. Every default lives here and is
 * shown read-only to admins on System > AI Connector.
 */
export const BRIEF_SETTINGS = {
  defaultTime: "08:00",
  catchUpMinutes: 180,
  batchPerRun: 8,
  runBudgetMs: 120_000,
  testCooldownMinutes: 5,
} as const;

export type AlertThresholds = {
  soOverdueMinRm: number;
  poOverdueMinRm: number;
  newlyOverdueDays: number;
  slaNewlyPastHours: number;
  stockNegative: boolean;
  repeatAfterDays: number;
  maxLinesPerEmail: number;
  batchPerRun: number;
  runBudgetMs: number;
};

export const ALERT_THRESHOLDS: Readonly<AlertThresholds> = {
  soOverdueMinRm: 5000,
  poOverdueMinRm: 5000,
  newlyOverdueDays: 2,
  slaNewlyPastHours: 24,
  stockNegative: true,
  repeatAfterDays: 7,
  maxLinesPerEmail: 15,
  batchPerRun: 10,
  runBudgetMs: 120_000,
};

export type BriefDays = "weekdays" | "daily";
export type BriefPrefs = { briefEnabled: boolean; time: string; days: BriefDays; alertsEnabled: boolean };
export const DEFAULT_PREFS: BriefPrefs = { briefEnabled: false, time: BRIEF_SETTINGS.defaultTime, days: "weekdays", alertsEnabled: false };

const TIME_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;

/** The settings a person may save: a quarter-hour time in MYT, weekdays or every day, and the two switches. */
export function parseBriefPrefs(body: unknown, current: BriefPrefs): { ok: true; prefs: BriefPrefs } | { ok: false; error: string } {
  const b = obj(body);
  const next: BriefPrefs = { ...current };
  if ("briefEnabled" in b) {
    if (typeof b.briefEnabled !== "boolean") return { ok: false, error: "briefEnabled must be true or false" };
    next.briefEnabled = b.briefEnabled;
  }
  if ("alertsEnabled" in b) {
    if (typeof b.alertsEnabled !== "boolean") return { ok: false, error: "alertsEnabled must be true or false" };
    next.alertsEnabled = b.alertsEnabled;
  }
  if ("time" in b) {
    if (typeof b.time !== "string" || !TIME_RE.test(b.time)) return { ok: false, error: "time must be HH:MM on a quarter hour (00, 15, 30 or 45), Malaysia time" };
    next.time = b.time;
  }
  if ("days" in b) {
    if (b.days !== "weekdays" && b.days !== "daily") return { ok: false, error: "days must be weekdays or daily" };
    next.days = b.days;
  }
  return { ok: true, prefs: next };
}

/** Malaysia time (UTC+8, no daylight saving) for an instant: the day, minutes past midnight and weekday (0 = Sunday). */
export function mytClock(nowMs: number): { day: string; minutes: number; weekday: number } {
  const d = new Date(nowMs + 8 * 3600_000);
  return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

const minutesOf = (hhmm: string): number => {
  const m = TIME_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 8 * 60;
};

/**
 * Is this person's brief due now? On, a sending day, at or after their time but
 * no more than catchUpMinutes late (a stalled cron never sends a "morning" brief
 * in the evening), and not already sent today.
 */
export function briefDue(sub: { prefs: BriefPrefs; lastBriefDay: string | null }, nowMs: number): boolean {
  if (!sub.prefs.briefEnabled) return false;
  const t = mytClock(nowMs);
  if (sub.prefs.days === "weekdays" && (t.weekday === 0 || t.weekday === 6)) return false;
  if (sub.lastBriefDay === t.day) return false;
  const at = minutesOf(sub.prefs.time);
  return t.minutes >= at && t.minutes < at + BRIEF_SETTINGS.catchUpMinutes;
}

/** The Monday brief carries the data-gaps list. */
export const isMondayMyt = (nowMs: number): boolean => mytClock(nowMs).weekday === 1;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const safeUrl = (u: string, origin: string): string | null => (u.startsWith(origin + "/") ? u : null);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_KEYS = ["doc", "so", "po", "case", "item", "supplier", "customer", "employee", "title"];

/** One brief / gap row as one line: the document (linked) and its other plain facts. */
export function rowLine(row: Obj, origin: string): string {
  const labelKey = LABEL_KEYS.find((k) => str(row[k]));
  const label = labelKey ? str(row[labelKey]) : "";
  const url = safeUrl(str(row.url), origin);
  const facts = Object.entries(row)
    .filter(([k, v]) => k !== labelKey && k !== "url" && k !== "overdue" && v !== null && v !== "" && (typeof v === "string" || typeof v === "number"))
    .map(([k, v]) => (typeof v === "number" && /rm$/i.test(k) ? fmtSen(Math.round(v * 100)) : typeof v === "string" && ISO_DAY.test(v) ? fmtDate(v) : String(v)))
    .map(escapeHtml);
  const head = label ? (url ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${escapeHtml(label)}</a>` : `<strong>${escapeHtml(label)}</strong>`) : "";
  const late = row.overdue === true ? ' <span style="color:#b91c1c;font-weight:600">overdue</span>' : "";
  return [head, ...facts].filter(Boolean).join(" &middot; ") + late;
}

type Section = { title: string; count: number; overdue?: number; valueRm?: number; note?: string; top: Obj[]; link?: string; url?: string };

function sectionHtml(s: Section, origin: string): string {
  const extra = [s.overdue ? `${s.overdue} overdue` : "", s.valueRm ? fmtSen(Math.round(s.valueRm * 100)) : ""].filter(Boolean).join(", ");
  const more = s.count > s.top.length ? `<div style="color:#6b7280;font-size:12px;margin-top:4px">and ${s.count - s.top.length} more${safeUrl(str(s.url), origin) ? ` &middot; <a href="${escapeHtml(str(s.url))}" style="color:#1d4ed8">open the list</a>` : ""}</div>` : "";
  const lines = s.top.map((r) => `<li style="margin:2px 0">${rowLine(r, origin)}</li>`).join("");
  return `<tr><td style="padding:12px 0;border-top:1px solid #e5e7eb">
<div style="font-size:15px;font-weight:600;color:#111827">${escapeHtml(s.title)} <span style="background:#eef2ff;color:#3730a3;border-radius:10px;padding:1px 8px;font-size:12px">${s.count}</span>${extra ? ` <span style="color:#6b7280;font-size:12px">${escapeHtml(extra)}</span>` : ""}</div>
${s.note ? `<div style="color:#6b7280;font-size:12px;margin-top:2px">${escapeHtml(s.note)}</div>` : ""}
${lines ? `<ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#374151">${lines}</ul>` : ""}${more}
</td></tr>`;
}

function shell(p: { heading: string; intro: string; body: string; unsubscribeUrl: string; settingsUrl: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:16px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;padding:20px 24px">
<tr><td><div style="font-size:20px;font-weight:700;color:#111827">${escapeHtml(p.heading)}</div><div style="color:#4b5563;font-size:13px;margin-top:4px">${escapeHtml(p.intro)}</div></td></tr>
${p.body}
<tr><td style="padding-top:16px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px">Only what your own ERP login can see. Change the time or switch this off on <a href="${escapeHtml(p.settingsUrl)}" style="color:#6b7280">System &gt; AI Connector</a>, or <a href="${escapeHtml(p.unsubscribeUrl)}" style="color:#6b7280">unsubscribe</a>.</td></tr>
</table></td></tr></table></body></html>`;
}

const prettyDay = (day: string): string => fmtDate(day);

export type BriefEmailInput = { name: string; today: string; brief: unknown; gaps: unknown | null; origin: string; unsubscribeUrl: string; settingsUrl: string };

/** The morning brief as an email: waiting counts, each section's count and first 5 with links, the Monday data gaps, and what the person cannot see. */
export function briefEmail(p: BriefEmailInput): { subject: string; html: string; items: number } {
  const b = obj(p.brief);
  const waiting = arr(b.waitingForYou).filter((w) => num(w.count) > 0);
  const sections = arr(b.sections).map((s) => ({ ...s, title: str(s.title), count: num(s.count), overdue: num(s.overdue), top: arr(s.top) }) as Section);
  const items = waiting.reduce((n, w) => n + num(w.count), 0) + sections.reduce((n, s) => n + s.count, 0);
  const parts: string[] = [];
  if (waiting.length) {
    const rows = waiting.map((w) => `<li style="margin:2px 0">${escapeHtml(str(w.title))}: <strong>${num(w.count)}</strong></li>`).join("");
    parts.push(`<tr><td style="padding:12px 0;border-top:1px solid #e5e7eb"><div style="font-size:15px;font-weight:600;color:#111827">Waiting for you</div><ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#374151">${rows}</ul></td></tr>`);
  }
  for (const s of sections) parts.push(sectionHtml(s, p.origin));
  if (!waiting.length && !sections.length) parts.push(`<tr><td style="padding:12px 0;border-top:1px solid #e5e7eb;font-size:14px;color:#065f46">Nothing due, overdue or waiting for you right now.</td></tr>`);
  if (p.gaps !== null) {
    const g = obj(p.gaps);
    const gs = arr(g.gaps).map((s) => ({ ...s, title: str(s.title), count: num(s.count), valueRm: num(s.valueRm), note: str(s.note), top: arr(s.top), url: str(s.url) }) as Section);
    parts.push(`<tr><td style="padding:16px 0 4px;border-top:2px solid #111827"><div style="font-size:17px;font-weight:700;color:#111827">Data gaps (every Monday)</div><div style="color:#6b7280;font-size:12px">Records missing something the ERP needs.</div></td></tr>`);
    for (const s of gs) parts.push(sectionHtml(s, p.origin));
    if (!gs.length) parts.push(`<tr><td style="padding:8px 0;font-size:13px;color:#065f46">No gaps found in what you can see.</td></tr>`);
    const gapsHidden = Array.isArray(g.notAvailable) ? (g.notAvailable as unknown[]).map(str).filter(Boolean) : [];
    if (gapsHidden.length) parts.push(`<tr><td style="padding:6px 0;font-size:12px;color:#6b7280">${gapsHidden.map(escapeHtml).join("<br>")}</td></tr>`);
  }
  const notAvailable = Array.isArray(b.notAvailable) ? (b.notAvailable as unknown[]).map(str).filter(Boolean) : [];
  if (notAvailable.length) parts.push(`<tr><td style="padding:10px 0;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${notAvailable.map(escapeHtml).join("<br>")}</td></tr>`);
  const who = p.name.trim() ? p.name.trim().split(/\s+/)[0] : "there";
  return {
    subject: `Your ERP brief, ${prettyDay(p.today)}: ${items ? `${items} to look at` : "all clear"}`,
    html: shell({ heading: `Good morning, ${who}`, intro: `Your Houzs ERP brief for ${prettyDay(p.today)}. Each list shows its count and the first 5.`, body: parts.join("\n"), unsubscribeUrl: p.unsubscribeUrl, settingsUrl: p.settingsUrl }),
    items,
  };
}

export type Alert = { key: string; kind: "so_overdue" | "po_overdue" | "sla" | "stock_negative"; label: string; detail: string; url: string };

/** Open SOs that became overdue in the last `newlyOverdueDays` days and are worth at least soOverdueMinRm. Key: SO + its delivery date. */
export function soAlerts(rows: readonly Obj[], today: string, origin: string, t: AlertThresholds): Alert[] {
  const from = addDays(today, -t.newlyOverdueDays);
  return rows
    .filter((o) => !o.on_hold)
    .map((o) => ({ o, date: str(o.customer_delivery_date).slice(0, 10), valueRm: rm(o.local_total_sen) }))
    .filter((x) => x.date && x.date < today && x.date >= from && x.valueRm >= t.soOverdueMinRm)
    .map(({ o, date, valueRm }) => ({
      key: `so_overdue:${str(o.doc_no)}:${date}`,
      kind: "so_overdue" as const,
      label: str(o.doc_no),
      detail: `${str(o.debtor_name)}, delivery date ${fmtDate(date)} (${daysBetween(date, today) ?? 0} day(s) late), ${fmtSen(Math.round(valueRm * 100))}`,
      url: `${origin}/scm/sales-orders/${enc(str(o.doc_no))}`,
    }));
}

/** Outstanding POs whose supplier date passed in the last `newlyOverdueDays` days, worth at least poOverdueMinRm. Key: PO + its supplier date. */
export function poAlerts(rows: readonly Obj[], today: string, origin: string, t: AlertThresholds): Alert[] {
  const from = addDays(today, -t.newlyOverdueDays);
  return rows
    .filter((p) => !p.on_hold)
    .map((p) => ({ p, date: poDueDate(p), valueRm: rm(p.total_sen) }))
    .filter((x) => x.date && x.date < today && x.date >= from && x.valueRm >= t.poOverdueMinRm)
    .map(({ p, date, valueRm }) => ({
      key: `po_overdue:${str(p.id)}:${date}`,
      kind: "po_overdue" as const,
      label: str(p.po_number),
      detail: `${str(obj(p.supplier).name) || "(no supplier)"}, supplier date ${fmtDate(date)}, ${fmtSen(Math.round(valueRm * 100))}`,
      url: `${origin}/scm/purchase-orders/${enc(str(p.id))}`,
    }));
}

/** Open service cases whose deadline passed within the last slaNewlyPastHours. Key: case + its deadline. */
export function slaAlerts(drill: unknown, nowMs: number, origin: string, t: AlertThresholds): Alert[] {
  const since = nowMs - t.slaNewlyPastHours * 3600_000;
  return arr(obj(drill).cases)
    .map((c) => ({ c, at: Date.parse(str(c.deadline_at)) }))
    .filter((x) => Number.isFinite(x.at) && x.at <= nowMs && x.at > since)
    .map(({ c }) => ({
      key: `sla:${str(c.id)}:${str(c.deadline_at).slice(0, 16)}`,
      kind: "sla" as const,
      label: str(c.assr_no) || `#${str(c.id)}`,
      detail: `${str(c.customer_name)}, ${str(c.stage)}${str(c.priority) ? `, ${str(c.priority)}` : ""}, deadline ${fmtDateTime(str(c.deadline_at))}`,
      url: `${origin}/assr?focus=${enc(str(c.id))}`,
    }));
}

/** Items whose stock ledger is below zero. Key: the item code (repeats only after repeatAfterDays). */
export function stockAlerts(products: unknown, origin: string): Alert[] {
  return arr(obj(products).products)
    .filter((p) => num(p.total_qty) < 0)
    .map((p) => ({
      key: `stock_negative:${str(p.item_code)}`,
      kind: "stock_negative" as const,
      label: str(p.item_code),
      detail: `${str(p.product_name)}, on hand ${num(p.total_qty)}`,
      url: `${origin}/scm/inventory?search=${enc(str(p.item_code))}`,
    }));
}

/**
 * Debounce: drop alerts whose key was emailed to this person within
 * repeatAfterDays (so never twice in one day), drop duplicate keys, keep at most
 * maxLinesPerEmail. `recentlySent` = this person's keys sent in that window.
 */
export function freshAlerts(candidates: readonly Alert[], recentlySent: ReadonlySet<string>, t: AlertThresholds): Alert[] {
  const seen = new Set<string>();
  const out: Alert[] = [];
  for (const a of candidates) {
    if (!a.key || recentlySent.has(a.key) || seen.has(a.key)) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out.slice(0, t.maxLinesPerEmail);
}

/** First day (MYT) of the debounce window that ends today. */
export const debounceSince = (today: string, t: AlertThresholds): string => addDays(today, -(t.repeatAfterDays - 1));

const ALERT_TITLES: Record<Alert["kind"], string> = {
  so_overdue: "Sales orders that just became overdue",
  po_overdue: "Purchase orders that just passed the supplier date",
  sla: "Service cases that just passed their deadline",
  stock_negative: "Items with stock below zero",
};

/** The urgent-alert email: one block per kind, each line linked to the ERP. */
export function alertEmail(p: { name: string; alerts: readonly Alert[]; origin: string; unsubscribeUrl: string; settingsUrl: string }): { subject: string; html: string } {
  const kinds = (Object.keys(ALERT_TITLES) as Alert["kind"][]).filter((k) => p.alerts.some((a) => a.kind === k));
  const body = kinds
    .map((k) => {
      const lines = p.alerts
        .filter((a) => a.kind === k)
        .map((a) => {
          const url = safeUrl(a.url, p.origin);
          const head = url ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${escapeHtml(a.label)}</a>` : `<strong>${escapeHtml(a.label)}</strong>`;
          return `<li style="margin:2px 0">${head} &middot; ${escapeHtml(a.detail)}</li>`;
        })
        .join("");
      return `<tr><td style="padding:12px 0;border-top:1px solid #e5e7eb"><div style="font-size:15px;font-weight:600;color:#111827">${escapeHtml(ALERT_TITLES[k])}</div><ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#374151">${lines}</ul></td></tr>`;
    })
    .join("\n");
  const n = p.alerts.length;
  return {
    subject: `ERP alert: ${n} item${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`,
    html: shell({ heading: "Urgent ERP alerts", intro: "New since the last check. Each item is emailed once.", body, unsubscribeUrl: p.unsubscribeUrl, settingsUrl: p.settingsUrl }),
  };
}
