/** The timeline tabs a service-case note can go on (routes/assr.ts POST /:id/notes); also offered by the AI Connector's propose_note. */
export const ASSR_NOTE_CATEGORIES = ["service", "customer", "supplier", "sales"] as const;
export type AssrNoteCategory = (typeof ASSR_NOTE_CATEGORIES)[number];

/** A requested category as the note route stores it: "purchasing" and anything unknown land on "service". */
export function assrNoteCategory(v: string | undefined): AssrNoteCategory {
  if (v === "purchasing") return "service";
  return (ASSR_NOTE_CATEGORIES as readonly string[]).includes(v ?? "") ? (v as AssrNoteCategory) : "service";
}
