import { useEffect, useState, type FormEvent } from "react";
import { correlatedFetch } from "../lib/requestCorrelation";
import { DAY_NAMES, addDays, fmtDay, fmtRange, isoDay, ms, startOfDay } from "../lib/meetings";

/**
 * /book/:code — a guest books a meeting room through a link someone sent them.
 *
 * NO LOGIN: the link code is the only thing needed, and the guest only ever sees free
 * times, never other meetings or who booked them (backend routes/meetings.ts proxies
 * to the IT Hub as a guest). A booking is confirmed straight away; its page has a
 * private address (/book/:code?b=<token>) the guest keeps to see or cancel it.
 */

const apiBase = (): string => (import.meta.env.VITE_API_URL as string) || (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

type LinkInfo = { code: string; name: string; length: number; days: number[]; from: number; to: number; until: string | null; location: string };
type Slot = { start: string; end: string };
type Booking = { code: string; start: string; end: string; cancelled?: boolean; room: string | { name: string; floor: string; location: string } | null; floor?: string | null; location?: string | null };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await correlatedFetch(`${apiBase()}/api/public/meetings${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  let body: (T & { error?: string }) | null = null;
  try {
    body = (await res.json()) as T & { error?: string };
  } catch {
    // Not JSON (a gateway page): answered below as a failure, never as an empty result.
  }
  if (!res.ok || !body) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body;
}

const INPUT = "h-11 w-full rounded-lg border border-border bg-surface px-3 text-[14px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none";

export function MeetingBook() {
  const parts = window.location.pathname.split("/");
  const code = decodeURIComponent(parts[2] ?? "");
  // Read once: booking writes ?b=<token> into the address, which must not refetch the page.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("b"));
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", company: "" });
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);

  useEffect(() => {
    if (token) {
      call<{ booking: Booking }>(`/bookings/${token}`).then((r) => setBooking(r.booking)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    call<{ link: LinkInfo }>(`/links/${encodeURIComponent(code)}`).then((r) => setLink(r.link)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [code, token]);

  const days: number[] = [];
  if (link) for (let i = 1; days.length < 10 && i < 45; i++) {
    const d = addDays(startOfDay(Date.now()), i);
    if (link.days.includes(new Date(d).getDay()) && (!link.until || isoDay(d) <= link.until)) days.push(d);
  }
  const chosen: number | null = day ?? days.at(0) ?? null;
  useEffect(() => {
    if (!link || chosen === null) return;
    setSlots(null);
    call<{ slots: Slot[] }>(`/links/${encodeURIComponent(code)}/slots?day=${isoDay(chosen)}`).then((r) => setSlots(r.slots)).catch(() => setSlots([]));
  }, [link, chosen, code]);

  const book = async (e: FormEvent) => {
    e.preventDefault();
    if (!slot) return;
    if (!form.name.trim() || !form.phone.trim() || !/^[^@\s]+@[^@\s]+$/.test(form.email)) { setFormError("Fill in your name, phone and a valid email."); return; }
    setSending(true);
    setFormError(null);
    try {
      const r = await call<{ token: string; booking: Booking }>(`/links/${encodeURIComponent(code)}/book`, { method: "POST", body: JSON.stringify({ start: slot.start, ...form }) });
      window.history.replaceState(null, "", `/book/${encodeURIComponent(code)}?b=${r.token}`);
      setBooking(r.booking);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setSlot(null);
      if (chosen !== null) call<{ slots: Slot[] }>(`/links/${encodeURIComponent(code)}/slots?day=${isoDay(chosen)}`).then((r) => setSlots(r.slots)).catch(() => setSlots([]));
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    const t = new URLSearchParams(window.location.search).get("b");
    if (!t) return;
    setSending(true);
    try {
      await call(`/bookings/${t}/cancel`, { method: "POST" });
      setBooking((b) => (b ? { ...b, cancelled: true } : b));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-[100dvh] bg-bg px-4 pb-10">
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-3.5 pt-6">{children}</div>
    </div>
  );

  if (error) return shell(<div className="rounded-2xl border border-border bg-surface p-6"><h1 className="text-[20px] font-bold">This booking link is not active</h1><p className="mt-2 text-ink-secondary">{/not active/i.test(error) ? "" : `${error} `}Ask the person who sent it for a new link.</p></div>);

  if (booking) {
    const room = typeof booking.room === "string" ? { name: booking.room, floor: booking.floor ?? "", location: booking.location ?? "" } : booking.room;
    return shell(
      <>
        <div className="rounded-2xl border border-border bg-surface p-5">
          {booking.cancelled ? (
            <><h1 className="text-[22px] font-bold">Booking cancelled</h1><p className="mt-1 text-ink-secondary">Your host has been told. You can book a new time with the same link.</p></>
          ) : (
            <>
              <h1 className="text-[22px] font-bold">You are booked</h1>
              <p className="mb-3 mt-1 text-ink-secondary">Confirmed. Your host has been told.</p>
              {[["When", `${fmtDay(ms(booking.start))}, ${fmtRange(ms(booking.start), ms(booking.end))}`], ["Where", [room?.name, room?.floor, room?.location].filter(Boolean).join(", ")], ["Booking no.", booking.code]].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-t border-border/60 py-2.5"><span className="text-ink-muted">{k}</span><b className="text-right">{v}</b></div>
              ))}
            </>
          )}
        </div>
        {!booking.cancelled && <button type="button" disabled={sending} onClick={() => void cancel()} className="h-12 rounded-xl border border-border bg-surface font-medium text-err">Cancel booking</button>}
        {formError && <p className="text-err">{formError}</p>}
        {!booking.cancelled && <p className="text-center text-[12.5px] text-ink-muted">Bookmark this page to see or cancel your booking later. To change the time, cancel and book again.</p>}
      </>,
    );
  }

  if (!link) return shell(<p className="text-ink-muted">Loading...</p>);

  return shell(
    <>
      <div className="rounded-2xl bg-sidebar p-5 text-white">
        <h1 className="text-[22px] font-bold">Book: {link.name}</h1>
        <div className="mt-1 text-[13.5px] opacity-85">{link.length} minutes{link.location ? ` · ${link.location}` : ""}</div>
      </div>
      <form onSubmit={(e) => void book(e)} className="flex flex-col gap-3">
        <div className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">1. Pick a day</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5">
          {days.map((d) => (
            <button key={d} type="button" onClick={() => { setDay(d); setSlot(null); }}
              className={`flex h-[58px] flex-col items-center justify-center rounded-xl border text-[11.5px] ${d === chosen ? "border-primary bg-primary text-white" : "border-border bg-surface text-ink-secondary"}`}>
              {DAY_NAMES[new Date(d).getDay()].toUpperCase()}<b className={`text-[17px] ${d === chosen ? "text-white" : "text-ink"}`}>{new Date(d).getDate()}</b>
            </button>
          ))}
        </div>
        <div className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">2. Pick a time</div>
        {slots === null ? <p className="text-ink-muted">Loading free times...</p> : slots.length === 0 ? <p className="text-ink-secondary">No free time on this day. Try another day.</p> : (
          <div className="grid grid-cols-2 gap-1.5">
            {slots.map((s) => (
              <button key={s.start} type="button" onClick={() => setSlot(s)} className={`h-11 rounded-lg border font-medium ${slot?.start === s.start ? "border-primary bg-primary-soft font-bold text-primary-ink" : "border-border bg-surface text-ink"}`}>{fmtRange(ms(s.start), ms(s.end))}</button>
            ))}
          </div>
        )}
        <p className="text-[12.5px] text-ink-secondary">Only free times are shown. You will not see other bookings.</p>
        <div className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">3. Your details</div>
        <input className={INPUT} placeholder="Name" aria-label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={INPUT} placeholder="Phone" aria-label="Phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input className={INPUT} placeholder="Email" aria-label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className={INPUT} placeholder="Company (optional)" aria-label="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
        {formError && <p className="text-err">{formError}</p>}
        <button disabled={!slot || sending} className="h-[50px] rounded-xl bg-primary text-[15px] font-semibold text-white disabled:opacity-50">
          {sending ? "Booking..." : slot ? `Book ${fmtDay(ms(slot.start))}, ${fmtRange(ms(slot.start), ms(slot.end))}` : "Pick a time first"}
        </button>
      </form>
    </>,
  );
}
