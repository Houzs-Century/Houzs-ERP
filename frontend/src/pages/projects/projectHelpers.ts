export function composeDefaultProjectName(p: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  event_type_slug?: string | null;
}): string {
  const state = (p.state || "").trim();
  const brand = (p.brand || "").trim();
  const organizer = (p.organizer || "").trim();
  const venue = (p.venue || "").trim();
  const isSolo = (p.event_type_slug || "").toLowerCase() === "solo";
  const orgSlot = organizer || (isSolo ? "SOLO" : "");

  const head: string[] = [];
  // State leads the name UPPERCASE (owner 2026-07-24): the 2026-07-22 canonical
  // migration stores states Title Case ("Selangor"), but the event-name/bar
  // convention is all-caps ("SELANGOR [AKEMI] SOLO @ …") to match the older
  // UPPERCASE-stored names still on non-solo projects.
  if (state) head.push(state.toUpperCase());
  if (brand) head.push(`[${brand}]`);
  if (orgSlot) head.push(orgSlot);
  const left = head.join(" ");
  if (!venue) return left;
  if (!left) return `@ ${venue}`;
  return `${left} @ ${venue}`;
}

export function upcaseLeadingState(name: string, state?: string | null): string {
  const s = (state || "").trim();
  if (s && name.toLowerCase().startsWith(s.toLowerCase())) {
    return s.toUpperCase() + name.slice(s.length);
  }
  return name;
}

export function viewableMime(name: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "heic", "bmp"].includes(ext)) {
    return `image/${ext === "jpg" ? "jpeg" : ext}`;
  }
  if (ext === "svg") return "image/svg+xml";
  if (ext === "pdf") return "application/pdf";
  if (ext === "mp4" || ext === "webm") return `video/${ext}`;
  if (ext === "mov") return "video/quicktime";
  return null;
}


export function googleCalendarUrl(p: {
  name: string;
  code: string;
  start_date: string | null;
  end_date: string | null;
  venue: string | null;
  venue_address: string | null;
  organizer: string | null;
}): string {
  const fmt = (d: string) => d.replace(/-/g, "");
  const start = p.start_date ? fmt(p.start_date) : "";
  const endRaw = p.end_date || p.start_date || "";
  const endDate = endRaw ? new Date(endRaw) : null;
  if (endDate) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate ? endDate.toISOString().slice(0, 10).replace(/-/g, "") : start;
  const dates = `${start}/${end}`;
  const details = [
    `Project: ${p.code}`,
    p.organizer && `Organizer: ${p.organizer}`,
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: p.name,
    dates,
    details,
    location: [p.venue, p.venue_address].filter(Boolean).join(", "),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
