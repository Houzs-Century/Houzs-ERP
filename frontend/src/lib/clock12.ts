/** "HH:MM" (24-hour) as the 12-hour label staff read: "00:00" -> "12:00 AM",
 *  "13:30" -> "1:30 PM". Anything else comes back unchanged. */
export function clock12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  if (h > 23) return hhmm;
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
