/* One delivery-run job, as both the phone run-sheet and the desktop job panel
   see it: its /delivery-jobs address, its label, and what the crew / office is
   shown for it by job type. Shared so the two screens cannot drift. */

export type JobRef = { sourceType: "dp" | "project" | "assr"; sourceId: string; leg: string };

type JobRow = {
  row_type?: string | null;
  so_doc_no: string;
  dp_job_type?: string | null;
  assr_id?: number | null;
  job_kind?: string | null;
};

/** The /delivery-jobs address of a board row, or null for a sales-order row. */
export function jobRefOf(o: JobRow): JobRef | null {
  if (o.row_type === "dp" && o.so_doc_no.startsWith("DP:") && o.dp_job_type)
    return { sourceType: "dp", sourceId: o.so_doc_no.slice(3), leg: o.dp_job_type };
  if (o.row_type === "project" && o.so_doc_no.startsWith("PRJ:")) {
    const [id, leg] = o.so_doc_no.slice(4).split("#");
    if (id && leg) return { sourceType: "project", sourceId: id, leg };
  }
  if (o.row_type === "assr" && o.assr_id != null && o.job_kind)
    return { sourceType: "assr", sourceId: String(o.assr_id), leg: o.job_kind };
  return null;
}

export const jobKey = (r: JobRef) => `${r.sourceType}:${r.sourceId}:${r.leg}`;

/** "Setup · PRJ-CODE" style card subtitle for a non-DO stop (null for an SO row). */
export function jobLabelOf(o: JobRow & { ref?: string | null; dp_no?: string | null }): string | null {
  const r = jobRefOf(o);
  if (!r) return null;
  const doc = r.sourceType === "dp" ? o.dp_no : o.ref;
  return [LEG_LABEL[r.leg] ?? r.leg, doc].filter(Boolean).join(" · ");
}

export type JobProgress = {
  source_type: string; source_id: string; leg: string;
  departed_at: string | null; arrived_at: string | null; completed_at: string | null;
  pod_photo_keys?: string[];
  departed_by?: number | null; arrived_by?: number | null; completed_by?: number | null;
  pod_notes?: string | null; pod_lat?: number | null; pod_lng?: number | null;
};

export const LEG_LABEL: Record<string, string> = {
  SETUP: "Setup", DISMANTLE: "Dismantle", SUPPLIER_PICKUP: "Supplier pickup", TRANSFER: "Transfer item",
  LORRY_SERVICE: "Lorry service", customer_pickup: "Service pickup", inspection: "Inspection", delivery: "Service / delivery back",
};

export type JobCtx = Record<string, unknown> & { kind: string; title?: string | null; ref?: string | null };
export type JobResponse = { job: JobRef & { trip_id: string | null }; context: JobCtx; progress: JobProgress | null; people?: Record<string, string> };

export const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
export const hm = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : null;

/* What the crew needs to see, by job type (owner, 2026-10-08). */
export function detailRows(c: JobCtx): Array<[string, string | null]> {
  const common: Array<[string, string | null]> = [
    ["Address", str(c.address)], ["State", str(c.state)],
    ["Contact", [str(c.contact_name), str(c.contact_phone)].filter(Boolean).join(" · ") || null],
  ];
  switch (c.kind) {
    case "SETUP": case "DISMANTLE":
      return [["Venue", str(c.venue)], ...common, ["Booth", str(c.booth_no)], ["Size (sqm)", str(c.size_sqm)],
        ["Window", [hm(str(c.window_start)), hm(str(c.window_end))].filter(Boolean).join(" – ") || null],
        ["Organizer / brand", [str(c.organizer), str(c.brand)].filter(Boolean).join(" · ") || null],
        ["Contractor", str(c.contractor)], ["Remark", str(c.remark)]];
    case "customer_pickup": case "inspection": case "delivery":
      return [["Address", str(c.address)], ["Location", str(c.state)],
        ["Contact", [str(c.contact_name), str(c.contact_phone)].filter(Boolean).join(" · ") || null], ["Date", str(c.date)], ["Product", str(c.product)], ["Issue", str(c.issue)],
        ["Category", str(c.issue_category)], ["Sales order", str(c.so_doc_no)]];
    case "TRANSFER":
      return [["From", str(c.from_warehouse)], ["To", str(c.to_warehouse)], ["Transfer no.", str(c.transfer_no)],
        ["Date", str(c.date)], ["Remark", str(c.remark)]];
    case "LORRY_SERVICE":
      return [["Lorry", str(c.lorry_plate)], ["Workshop", str(c.workshop)], ["Work order", str(c.work_order_no)],
        ["Problem", str(c.problem)], ...common, ["Date", str(c.date)], ["Remark", str(c.remark)]];
    default:
      return [...common, ["Date", str(c.date)], ["Remark", str(c.remark)]];
  }
}

