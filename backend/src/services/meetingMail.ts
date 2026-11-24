// Meeting emails through this ERP's Mail Center (owner 2026-11-25).
//
// The Houzs IT Hub writes every meeting email (invitation, change, cancellation, reminder, guest booking). This
// Worker collects the ones for meetings made under each of its companies, sends them with sendEmail (this ERP's
// own provider and verified domains, logged in email_log like every other email), and tells the hub what happened;
// the organiser sees it in the meeting detail. It runs by itself: right after a meeting is booked, changed or
// cancelled here (routes/meetings.ts), and from the 5-minute cron, which carries the reminders.
//
// The hub hands each email out once (locked, with a 10-minute lease) and offers a failed one again, up to 5 tries,
// so sendEmail's own outbox retry is off here: two retry loops would send a second copy.
import type { Env } from "../types";
import { sendEmail } from "./email";

export type HubMail = { id: number; from: string; to: string[]; subject: string; html: string; text: string };
/** Send one email; null when it went, else the reason it did not. */
export type SendOne = (m: HubMail) => Promise<string | null>;

const HUB_TIMEOUT_MS = 20_000;
const COMPANY = /^[A-Z0-9]{2,12}$/;
const KEY_NAME = /^IT_HUB_API_KEY_([A-Z0-9]{2,12})$/;

/** Collect the waiting emails from the hub with one company's key, send each, and report the results. */
export async function collectAndSend(base: string, key: string, send: SendOne): Promise<{ sent: number; failed: number }> {
  const call = (path: string, body: unknown) =>
    fetch(`${base}/api/v1/sys/meetings${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "X-Reporter-Id": "mail", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
  const res = await call("/mail/claim", {});
  if (!res.ok) throw new Error(`the hub answered ${res.status}`);
  const mail = ((await res.json()) as { mail?: HubMail[] }).mail ?? [];
  const results: { id: number; error: string | null }[] = [];
  for (const m of mail) {
    let error: string | null;
    try {
      error = await send(m);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({ id: m.id, error });
  }
  if (results.length) {
    const done = await call("/mail/results", { results });
    if (!done.ok) throw new Error(`the hub did not take the results (${done.status})`);
  }
  return { sent: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length };
}

/** This ERP's Mail Center as the sender, under the company's branding. */
export function viaMailCenter(env: Env, company: string): SendOne {
  return async (m) => {
    const r = await sendEmail(env, {
      to: m.to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      from: m.from,
      purpose: "meeting",
      refType: "meeting_mail",
      refId: m.id,
      companyCode: company,
      outboxRetry: false,
    });
    return r.status === "sent" ? null : r.reason ?? "not sent";
  };
}

/** One company's waiting meeting emails; nothing when meetings is not connected for it. */
export async function sendMeetingMail(env: Env, company: string): Promise<{ sent: number; failed: number }> {
  const base = (env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");
  const raw = COMPANY.test(company) ? (env as unknown as Record<string, unknown>)[`IT_HUB_API_KEY_${company}`] : undefined;
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!base || !key) return { sent: 0, failed: 0 };
  return collectAndSend(base, key, viaMailCenter(env, company));
}

/** The cron: every company that has a hub key. One company failing does not stop the others. */
export async function sendAllMeetingMail(env: Env): Promise<{ sent: number; failed: number }> {
  const total = { sent: 0, failed: 0 };
  for (const name of Object.keys(env as unknown as Record<string, unknown>)) {
    const company = KEY_NAME.exec(name)?.[1];
    if (!company) continue;
    try {
      const r = await sendMeetingMail(env, company);
      total.sent += r.sent;
      total.failed += r.failed;
    } catch (e) {
      console.warn(`[meeting-mail] ${company}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return total;
}
