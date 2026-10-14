// ----------------------------------------------------------------------------
// posAlerts — the Houzs POS watchdog (spec section 10, layout E7). Every half
// hour, for each company with terminals:
//   1. compute the alerts each terminal should have (routes/lib/pos-alerts.ts)
//      and reconcile them with pos_alerts: open the new ones, auto-resolve the
//      ones no longer wanted (pending back to zero, device back);
//   2. email the alert address (General > alert email) once per alert, then
//      once a day while it stays open, and post an in-ERP notice to the POS
//      Admin holders the first time;
//   3. send the end-of-event summary ONCE per linked event, when the event is
//      over and every active terminal has nothing pending, with the summary
//      tables as a CSV attachment (opens in Excel).
// Best-effort per company: one company's failure never stops the others.
// ----------------------------------------------------------------------------
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { pos_alerts, pos_event_links, pos_settings, pos_terminals } from "../db/schema";
import { normalizePosSettingsGroup } from "../scm/shared/pos-settings";
import { publicUrl, sendEmail } from "./email";
import { postPersonalNotice } from "./personalNotice";
import { parsePermissions } from "./permissions";
import { ALERT_WORDS, alertSubject, emailDue, reconcileAlerts, summaryDue, wantedAlerts, type AlertType, type OpenAlert, type TerminalFacts } from "../routes/lib/pos-alerts";
import { aggregateSales, summaryCsv, summaryHtml } from "../routes/lib/pos-report";
import { loadReportSales } from "../routes/lib/pos-report-load";

type Db = ReturnType<typeof getDb>;

/** pos_terminals joined with the event's name and dates, as the rules want. */
export async function loadTerminalFacts(db: Db, companyId: number): Promise<TerminalFacts[]> {
  const rows = await db.execute<{
    id: number | string; code: string; device_name: string | null; active: boolean; project_id: number | string | null; event_name: string | null; event_start: string | null; event_end: string | null;
    prepared_at: string | Date | null; last_seen_at: string | Date | null; last_sync_at: string | Date | null; pending_count: number | string; pending_amount_sen: number | string;
    last_known_pending_count: number | string; last_known_pending_sen: number | string; db_empty_at: string | Date | null;
  }>(sql`
    SELECT t.id, t.code, t.device_name, t.active, t.project_id, p.name AS event_name, p.start_date::text AS event_start, p.end_date::text AS event_end,
           t.prepared_at, t.last_seen_at, t.last_sync_at, t.pending_count, t.pending_amount_sen, t.last_known_pending_count, t.last_known_pending_sen, t.db_empty_at
      FROM pos_terminals t
      LEFT JOIN projects p ON p.id = t.project_id AND p.company_id = t.company_id
     WHERE t.company_id = ${companyId}
     ORDER BY t.code`);
  const iso = (v: string | Date | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
  return rows.map((r) => ({
    id: Number(r.id), code: r.code, device_name: r.device_name, active: !!r.active, project_id: r.project_id == null ? null : Number(r.project_id), event_name: r.event_name, event_start: r.event_start, event_end: r.event_end,
    prepared_at: iso(r.prepared_at), last_seen_at: iso(r.last_seen_at), last_sync_at: iso(r.last_sync_at), pending_count: Number(r.pending_count), pending_amount_sen: Number(r.pending_amount_sen),
    last_known_pending_count: Number(r.last_known_pending_count), last_known_pending_sen: Number(r.last_known_pending_sen), db_empty_at: iso(r.db_empty_at),
  }));
}

export async function generalSettings(db: Db, companyId: number) {
  const rows = await db.select({ value: pos_settings.value }).from(pos_settings).where(and(eq(pos_settings.company_id, companyId), eq(pos_settings.group, "general"))).limit(1);
  return normalizePosSettingsGroup("general", rows.length ? rows[0].value : null);
}

/** Active users whose role holds pos.manage, or everything ("*"): the owner
 *  and admins the spec says see the alert inside the ERP. */
async function posAdminUserIds(env: Env): Promise<number[]> {
  const rows = await env.DB.prepare(`SELECT u.id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'active'`).all<{ id: number; permissions: string | null }>();
  return rows.results.filter((r) => { const p = parsePermissions(r.permissions); return p.includes("*") || p.includes("pos.manage"); }).map((r) => Number(r.id));
}

const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function alertHtml(env: Env, type: AlertType, t: TerminalFacts, detail: Record<string, unknown>, repeat: boolean): string {
  const w = ALERT_WORDS[type];
  const lines: string[] = [];
  if (type === "DATA_LOST") {
    lines.push(`The device reconnected with an EMPTY local database. Its last report showed <b>${Number(detail.last_known_pending_count ?? 0)}</b> unsynced bill(s), ${rm(Number(detail.last_known_pending_sen ?? 0))}, that never reached the ERP.`);
    lines.push(`Recover them from the device's backup file (houzs_pos_${t.code}_backup.json) with POS Admin &gt; Import backup, then acknowledge the alert on Sync Status.`);
  } else if (type === "PENDING_STALE") {
    lines.push(`<b>${t.pending_count}</b> bill(s), ${rm(t.pending_amount_sen)}, have waited on the device for ${Number(detail.days_since_sync ?? 0)} day(s) without a successful sync.`);
    lines.push("Connect the device to the internet and open the POS app: the sync engine sends them on its own. If the device is lost, import its backup file.");
  } else {
    lines.push(`The event ended on ${String(detail.event_end ?? "").slice(0, 10)} and the terminal still shows <b>${t.pending_count}</b> pending bill(s), ${rm(t.pending_amount_sen)}${detail.never_synced ? ", and never synced during the event" : ""}.`);
    lines.push("Sync the device or import its backup so the event's sales and stock are complete.");
  }
  return `<div style="font-family:Arial,sans-serif;color:#222">
<h2 style="margin:0 0 6px;color:${w.level === "CRITICAL" ? "#b91c1c" : "#b45309"}">${w.level}: ${esc(w.title)}</h2>
<p><b>Terminal</b> ${esc(t.code)}${t.device_name ? ` (${esc(t.device_name)})` : ""} · <b>Event</b> ${esc(t.event_name ?? "no event")}<br/>
<b>Last seen</b> ${t.last_seen_at ?? "never"} · <b>Last sync</b> ${t.last_sync_at ?? "never"}</p>
${lines.map((l) => `<p>${l}</p>`).join("")}
<p><a href="${publicUrl(env, "/pos-admin?tab=sync")}">Open POS Admin &gt; Sync Status</a></p>
<p style="color:#777;font-size:12px">${repeat ? "This alert is still open; the ERP re-sends it once a day until it resolves." : "The ERP sends this once, then once a day while it stays open, and resolves it on its own at zero pending."}</p></div>`;
}

const utf8B64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export type PosAlertRun = { companies: number; opened: number; resolved: number; emailed: number; summaries: number; errors: number };

export async function runPosAlerts(env: Env, nowMs = Date.now()): Promise<PosAlertRun> {
  const db = getDb(env);
  const out: PosAlertRun = { companies: 0, opened: 0, resolved: 0, emailed: 0, summaries: 0, errors: 0 };
  const companies = await db.execute<{ company_id: number | string }>(sql`SELECT DISTINCT company_id FROM pos_terminals`);
  const nowIso = new Date(nowMs).toISOString();
  for (const row of companies) {
    const companyId = Number(row.company_id);
    out.companies += 1;
    try {
      const general = await generalSettings(db, companyId);
      const terminals = await loadTerminalFacts(db, companyId);
      const byId = new Map(terminals.map((t) => [t.id, t]));
      const thresholds = { pendingDays: general.alert_pending_days, eventEndDays: general.alert_event_end_days };
      const wanted = terminals.flatMap((t) => wantedAlerts(t, thresholds, nowMs));
      const openRows = await db.select().from(pos_alerts).where(and(eq(pos_alerts.company_id, companyId), isNull(pos_alerts.resolved_at)));
      const open: OpenAlert[] = openRows.map((a) => ({ id: a.id, type: a.type as AlertType, terminal_id: a.terminal_id, project_id: a.project_id, email_sent_at: a.email_sent_at, last_resent_at: a.last_resent_at }));
      const { toOpen, toResolve } = reconcileAlerts(open, wanted);
      if (toResolve.length) {
        await db.update(pos_alerts).set({ resolved_at: nowIso }).where(inArray(pos_alerts.id, toResolve.map((a) => a.id)));
        out.resolved += toResolve.length;
      }
      const adminIds = toOpen.length ? await posAdminUserIds(env) : [];
      for (const w of toOpen) {
        const [ins] = await db.insert(pos_alerts).values({ company_id: companyId, type: w.type, terminal_id: w.terminal_id, project_id: w.project_id, detail: w.detail }).returning({ id: pos_alerts.id });
        out.opened += 1;
        const t = byId.get(w.terminal_id);
        if (t) {
          await postPersonalNotice(env, { userIds: adminIds, category: "WARNING", title: alertSubject(w.type, t.code, t.event_name), body: `${ALERT_WORDS[w.type].level}: ${t.pending_count} pending bill(s), ${rm(t.pending_amount_sen)}. See POS Admin > Sync Status.`, source: `pos_alert:${ins.id}`, expiresDays: 14 });
        }
        open.push({ id: ins.id, type: w.type, terminal_id: w.terminal_id, project_id: w.project_id, email_sent_at: null, last_resent_at: null });
      }
      const stillOpen = open.filter((a) => !toResolve.some((r) => r.id === a.id));
      for (const a of stillOpen) {
        if (!emailDue(a, nowMs)) continue;
        const t = a.terminal_id == null ? undefined : byId.get(a.terminal_id);
        if (!t) continue;
        const detail = wanted.find((w) => w.type === a.type && w.terminal_id === a.terminal_id)?.detail ?? {};
        const res = await sendEmail(env, { to: general.alert_email, subject: alertSubject(a.type, t.code, t.event_name), html: alertHtml(env, a.type, t, detail, !!a.email_sent_at), purpose: "generic", refType: "pos_alert", refId: a.id });
        if (res.status === "sent") {
          await db.update(pos_alerts).set(a.email_sent_at ? { last_resent_at: nowIso } : { email_sent_at: nowIso }).where(eq(pos_alerts.id, a.id));
          out.emailed += 1;
        }
      }
      out.summaries += await sendDueSummaries(env, db, companyId, general.alert_email, terminals, nowMs);
    } catch (e) {
      out.errors += 1;
      console.error(`[pos-alerts] company ${companyId}`, e);
    }
  }
  return out;
}

async function sendDueSummaries(env: Env, db: Db, companyId: number, to: string, terminals: TerminalFacts[], nowMs: number): Promise<number> {
  const events = await db.execute<{ id: number | string; project_id: number | string; name: string; end_date: string | null; summary_sent_at: string | Date | null }>(sql`
    SELECT l.id, l.project_id, p.name, p.end_date::text AS end_date, l.summary_sent_at
      FROM pos_event_links l JOIN projects p ON p.id = l.project_id AND p.company_id = l.company_id
     WHERE l.company_id = ${companyId} AND l.summary_sent_at IS NULL AND p.end_date IS NOT NULL`);
  let sent = 0;
  for (const ev of events) {
    const pid = Number(ev.project_id);
    const mine = terminals.filter((t) => t.project_id === pid);
    if (!summaryDue({ end_date: ev.end_date, summary_sent_at: null }, mine, nowMs)) continue;
    const sales = await loadReportSales(db, companyId, { projectId: pid });
    const totals = aggregateSales(sales);
    const res = await sendEmail(env, {
      to, subject: `[POS SUMMARY] ${ev.name}`, html: summaryHtml(ev.name, totals), purpose: "generic", refType: "pos_summary", refId: pid, outboxRetry: false,
      attachments: [{ filename: `pos_summary_${ev.name.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40)}.csv`, content: utf8B64(summaryCsv(ev.name, totals)) }],
    });
    if (res.status === "sent" || res.status === "skipped") {
      await db.update(pos_event_links).set({ summary_sent_at: new Date(nowMs).toISOString() }).where(eq(pos_event_links.id, Number(ev.id)));
      sent += 1;
    }
  }
  return sent;
}
