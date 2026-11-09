import { useState } from "react";
import { ALLOWED_SLIP_MIMES } from "../vendor/scm/lib/slip";
import { DELIVERY_ISSUE_KINDS, DELIVERY_ISSUE_MAX_PHOTOS, DELIVERY_ISSUE_NOTE_MAX, type DeliveryIssueKind } from "../vendor/scm/lib/delivery-issue-kinds";
import {
  deliveryIssueSummary, useDoDeliveryIssues, useSoDeliveryIssues, type DeliveryIssue, type DeliveryIssueDraft,
} from "../vendor/scm/lib/delivery-issue-queries";
import { fmtDateTime } from "@2990s/shared";

export const EMPTY_ISSUE_DRAFT: DeliveryIssueDraft = { kinds: [], note: "", photos: [] };

/* "Delivered with issue" — the crew ticks what went wrong, adds a note and
   photos. Controlled: MobilePOD and MobileJobStop own the draft and send it
   (vendor/scm/lib/delivery-issue-queries.ts) after the delivery itself is saved,
   so a problem never blocks the delivery. */
export function DeliveryIssueForm({ value, onChange, disabled }: {
  value: DeliveryIssueDraft; onChange: (d: DeliveryIssueDraft) => void; disabled: boolean;
}) {
  const [photoError, setPhotoError] = useState<string | null>(null);
  const toggle = (k: DeliveryIssueKind) => onChange({
    ...value, kinds: value.kinds.includes(k) ? value.kinds.filter((x) => x !== k) : [...value.kinds, k],
  });
  return (
    <div data-testid="delivery-issue-form" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="fld-l">What is wrong? (tick all that apply)</div>
      {DELIVERY_ISSUE_KINDS.map((k) => {
        const on = value.kinds.includes(k.value);
        return (
          <label key={k.value} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer", border: on ? "1.5px solid var(--red)" : "1px solid var(--line-card)" }}>
            <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(k.value)} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{k.label}</span>
          </label>
        );
      })}
      <textarea
        value={value.note}
        disabled={disabled}
        maxLength={DELIVERY_ISSUE_NOTE_MAX}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
        placeholder={value.kinds.includes("other") ? "Describe the problem (required for Other)" : "Note for the office (optional)"}
        rows={2}
        style={{ width: "100%", fontFamily: "inherit", fontSize: 12.5, borderRadius: 8, padding: 8, border: "1px solid var(--line)" }}
      />
      <label className="btn-ghost" style={{ display: "block", textAlign: "center", cursor: disabled ? "default" : "pointer" }}>
        {value.photos.length ? "Add another problem photo" : "Take problem photo"}
        <input
          type="file"
          accept={ALLOWED_SLIP_MIMES.filter((m) => m.startsWith("image/")).join(",")}
          capture="environment"
          multiple
          disabled={disabled}
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!picked.length) return;
            if (picked.some((f) => !ALLOWED_SLIP_MIMES.includes(f.type as (typeof ALLOWED_SLIP_MIMES)[number]))) {
              setPhotoError("Please use JPEG, PNG or WebP photos.");
              return;
            }
            setPhotoError(null);
            onChange({ ...value, photos: [...value.photos, ...picked].slice(0, DELIVERY_ISSUE_MAX_PHOTOS) });
          }}
        />
      </label>
      {value.photos.map((f, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--mut)" }}>
          <span className="tnum">{i + 1}. {f.name}</span>
          <button type="button" disabled={disabled} onClick={() => onChange({ ...value, photos: value.photos.filter((_, j) => j !== i) })}
            style={{ border: "none", background: "none", color: "var(--red)", fontFamily: "inherit", fontSize: 11, fontWeight: 700 }}>Remove</button>
        </div>
      ))}
      {photoError && <div style={{ fontSize: 10.5, color: "var(--red)" }}>{photoError}</div>}
    </div>
  );
}

/** The issues already reported on this delivery, with their Service Case number. */
export function MobileDeliveryIssues({ issues }: { issues: DeliveryIssue[] | undefined }) {
  if (!issues?.length) return null;
  return (
    <div data-testid="delivery-issues" className="card" style={{ padding: 12, marginBottom: 12, borderLeft: "3px solid var(--red)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span className="badge b-red">Delivered with issue</span>
      </div>
      {issues.map((i) => (
        <div key={i.id} style={{ fontSize: 12.5, padding: "4px 0", borderTop: "1px solid var(--line-card)" }}>
          <div style={{ fontWeight: 700, color: "var(--ink)" }}>{deliveryIssueSummary(i)}</div>
          {i.note && <div style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{i.note}</div>}
          <div style={{ fontSize: 11, color: "var(--mut)" }} className="tnum">
            {fmtDateTime(i.reported_at)}
            {i.assr_no ? ` · Service case ${i.assr_no}` : " · Service case not linked"}
            {i.photo_keys.length ? ` · ${i.photo_keys.length} photo${i.photo_keys.length === 1 ? "" : "s"}` : ""}
            {i.do_number ? ` · ${i.do_number}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mobile DO detail (MobileModuleDetail) — desktop twin DoDeliveryIssuesCard. */
export function MobileDoDeliveryIssues({ doId }: { doId: string | null | undefined }) {
  return <MobileDeliveryIssues issues={useDoDeliveryIssues(doId).data} />;
}

/** Mobile SO detail (MobileSODetail) — desktop twin SoDeliveryIssuesCard. */
export function MobileSoDeliveryIssues({ docNo }: { docNo: string | null | undefined }) {
  return <MobileDeliveryIssues issues={useSoDeliveryIssues(docNo).data} />;
}
