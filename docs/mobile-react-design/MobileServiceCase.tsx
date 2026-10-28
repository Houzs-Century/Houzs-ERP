import { useState } from 'react';
import { Badge } from './MobileSoList';

// MobileServiceCase — after-sales case detail (+ new). Maps to prototype: #service, #service-new.
// Detail (redesigned): 9-stage pipeline (h-scroll), then a stack of sections, each with the
// section title on the LEFT and its Edit control pinned to the FAR RIGHT of the header
// (title · Edit · chevron). Sections: Issue, Product info, Verification, Resolution,
// QC inspection, Reference & logistics, Customer, PIC, SLA, Timeline.
// New: SO lookup, product, issue category, priority, issue no, description, attachments.
//
// Self-contained reference: mock data only, no hooks/APIs. The complaint text appears
// ONCE as the Complaint field of the Issue section — there is no separate "reported issue"
// banner. "Add product item" is a picker of AVAILABLE catalogue items (the Add control is
// hidden when nothing is available), not a free-text box.

const INK = '#11140f';
const MUTED = '#767b6e';
const GREY = '#9aa093';
const BROWN = '#a16a2e';
const GREEN = '#2f8a5b';
const RED = '#b23a3a';
const FIELD_BG = '#f4f6f3';

export interface ServiceCaseItem {
  item_code: string;
  item_description: string;
  qty: number;
}

export interface ServiceCase {
  case_no: string;
  stage: 'Pending pickup' | 'Item ready' | 'Delivery' | 'Completed';
  priority: 'Low' | 'Medium' | 'High';
  // Issue
  complaint_issue: string;
  issue_category: string;
  status: string;
  // Product
  items: ServiceCaseItem[];
  po_no: string;
  // Verification
  verification_outcome: string;
  verified_root_cause: string;
  // Resolution
  resolution_method: string;
  supplier_name: string;
  supplier_code: string;
  customer_pickup_date: string;
  supplier_pickup_date: string;
  // QC
  inspection_result: string;
  qc_inspection_date: string;
  // Reference & logistics
  ref_no: string;
  delivery_order: string;
  do_date: string;
  // Customer
  customer_name: string; phone: string; email: string; address: string;
  location: string; sales_agent: string; so_doc_no: string; complained_date: string;
  // PIC
  pic_name: string; created_by: string;
  // SLA
  deadline: string; sla_label: string; sla_overdue?: boolean;
}

const STAGES = ['Review', 'Verify', 'Solution', 'Inspection', 'Item Pickup', 'Supplier', 'Item Ready', 'Delivery', 'Completed'];

// Catalogue of items still available to add to this case (the picker source).
// When empty, the "Add item" control is hidden entirely.
const AVAILABLE_ITEMS: ServiceCaseItem[] = [
  { item_code: 'AK-GUARDIAN MATT (Q)', item_description: 'Guardian pocket-spring mattress — Queen', qty: 1 },
  { item_code: 'HZ-DIVAN-STORAGE (K)', item_description: 'Storage divan base — King', qty: 1 },
];

export function MobileServiceCase({ svc, onBack }: { svc: ServiceCase; onBack: () => void }) {
  const cur = STAGES.indexOf(
    svc.stage === 'Pending pickup' ? 'Item Pickup'
      : svc.stage === 'Item ready' ? 'Item Ready'
        : svc.stage === 'Delivery' ? 'Delivery'
          : 'Completed',
  );
  const [available] = useState<ServiceCaseItem[]>(AVAILABLE_ITEMS);

  return (
    <div className="hz-m screen">
      <header className="hdr">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#16695f', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>&lsaquo; Service Cases</button>
          <Badge status={svc.stage} />
        </div>
        <div className="eyebrow" style={{ marginTop: 7 }}>{svc.case_no} · {svc.priority}</div>
        <div className="scr-title">{svc.customer_name}</div>
      </header>

      {/* Adequate bottom padding so the last section clears the fixed action bar. */}
      <div className="scroll" style={{ paddingBottom: 96 }}>
        {/* 9-stage pipeline (horizontal scroll) */}
        <div className="card"><div className="card-b">
          <div className="fld-l" style={{ marginBottom: 8 }}>Workflow</div>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
            {STAGES.map((s, i) => (
              <span key={s} style={{ flex: 'none', fontSize: 10, fontWeight: 700, padding: '5px 9px', borderRadius: 20, background: i < cur ? '#e2f0e9' : i === cur ? '#f6efd9' : FIELD_BG, color: i < cur ? GREEN : i === cur ? '#8a6a2e' : GREY }}>{s}</span>
            ))}
          </div>
        </div></div>

        {/* Issue — complaint shows ONCE here (no separate reported-issue banner) */}
        <Section title="Issue" editable>
          <Row l="Complaint" v={svc.complaint_issue} multiline />
          <Row l="Issue category" v={svc.issue_category} />
          <Row l="Priority" v={svc.priority} />
          <Row l="Status" v={svc.status} />
        </Section>

        {/* Product info — Add item is a picker of AVAILABLE products, hidden when none */}
        <Section title="Product info" action={available.length ? '+ Add item' : undefined}>
          {svc.items.map((it) => (
            <div key={it.item_code} style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid #e3e6e0', borderRadius: 10, padding: '10px 11px', marginBottom: 7 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="money" style={{ fontSize: 10, fontWeight: 700, color: BROWN }}>{it.item_code}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: INK, marginTop: 2 }}>{it.item_description}</div>
              </div>
              <span style={{ fontSize: 11, color: MUTED }}>&times;{it.qty}</span>
            </div>
          ))}
          {svc.items.length === 0 && <div style={{ fontSize: 12, color: GREY, padding: '2px 0' }}>No items recorded.</div>}
          {/* Add-item picker: choose from AVAILABLE catalogue items (not free text) */}
          {available.length > 0 && (
            <div className="fld" style={{ marginTop: 4 }}>
              <span className="fld-l">Add product item</span>
              <select className="fld-i" defaultValue="">
                <option value="" disabled>Select an available item…</option>
                {available.map((it) => (
                  <option key={it.item_code} value={it.item_code}>{it.item_code} — {it.item_description}</option>
                ))}
              </select>
            </div>
          )}
          <Row l="PO No" v={svc.po_no} mono />
        </Section>

        {/* Verification (brown accent, "on receipt") */}
        <Section title="Verification" note="on receipt" accent={BROWN} editable>
          <Row l="Outcome" v={svc.verification_outcome} />
          <Row l="Root cause" v={svc.verified_root_cause} multiline />
        </Section>

        {/* Resolution — BOTH a customer pickup date AND a supplier pickup date */}
        <Section title="Resolution" editable>
          <Row l="Resolution method" v={svc.resolution_method} />
          <Row l="Customer pickup date" v={svc.customer_pickup_date} />
          <Row l="Supplier pickup date" v={svc.supplier_pickup_date} />
          <div className="fld-l" style={{ marginTop: 8 }}>Supplier</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid #e3e6e0', borderRadius: 10, padding: '10px 11px', marginTop: 5 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{svc.supplier_name}</div>
              <div className="money" style={{ fontSize: 10, color: GREY }}>{svc.supplier_code}</div>
            </div>
          </div>
        </Section>

        {/* QC inspection (green accent, "after repair") */}
        <Section title="QC inspection" note="after repair" accent={GREEN} editable>
          <Row l="QC result" v={svc.inspection_result} />
          <Row l="QC inspection date" v={svc.qc_inspection_date} />
        </Section>

        {/* Reference & logistics */}
        <Section title="Reference & logistics" editable>
          <Row l="Ref No" v={svc.ref_no} />
          <Row l="Delivery order" v={svc.delivery_order} mono />
          <Row l="DO date" v={svc.do_date} />
        </Section>

        {/* Customer — Ref No + Address in addition to Customer/Phone/Email/Location/Agent/SO No/Date */}
        <Section title="Customer" editable>
          <Row l="Customer" v={svc.customer_name} />
          <Row l="Phone" v={svc.phone} />
          <Row l="Email" v={svc.email} />
          <Row l="Address" v={svc.address} multiline />
          <Row l="Location" v={svc.location} />
          <Row l="Agent" v={svc.sales_agent} />
          <Row l="Ref No" v={svc.ref_no} />
          <Row l="SO No" v={svc.so_doc_no} mono />
          <Row l="Date" v={svc.complained_date} />
        </Section>

        {/* PIC */}
        <Section title="PIC" action="Assign">
          <Row l="Assigned to" v={svc.pic_name} />
          <Row l="Created by" v={svc.created_by} />
        </Section>

        {/* SLA banner */}
        <div style={{ background: svc.sla_overdue ? '#f8eaea' : FIELD_BG, border: `1px solid ${svc.sla_overdue ? '#f0d4d4' : '#e3e6e0'}`, borderRadius: 13, padding: '12px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: svc.sla_overdue ? RED : MUTED }}>SLA</div>
          <div style={{ fontSize: 12, color: svc.sla_overdue ? '#7a2222' : '#414539', marginTop: 5 }}>Deadline {svc.deadline} · {svc.priority}</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: svc.sla_overdue ? RED : GREEN, marginTop: 2 }}>{svc.sla_label}</div>
        </div>
      </div>

      <div className="actbar">
        <button className="btn btn-ghost" style={{ flex: 1 }}>Print</button>
        <button className="btn" style={{ flex: 1.4 }}>Advance stage &rarr;</button>
      </div>
    </div>
  );
}

// A titled section. Header layout: title on the LEFT, then the Edit/action control
// (and any note) pinned to the FAR RIGHT via margin-left:auto, then the chevron.
function Section({
  title,
  children,
  editable,
  action,
  note,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  editable?: boolean;
  action?: string;
  note?: string;
  accent?: string;
}) {
  const rightLabel = action ?? (editable ? 'Edit' : undefined);
  return (
    <div className="card" style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <div className="card-h" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="card-t">{title}</span>
        {note && <span style={{ marginLeft: 'auto', fontSize: 10, color: GREY }}>{note}</span>}
        {rightLabel && (
          <button
            className="tinybtn"
            style={{ marginLeft: note ? 8 : 'auto', color: BROWN, background: 'none', border: 'none', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
          >
            {rightLabel}
          </button>
        )}
        <span style={{ marginLeft: rightLabel || note ? 0 : 'auto', color: '#c2c6bd', fontSize: 15, lineHeight: 1 }}>&rsaquo;</span>
      </div>
      <div className="card-b">{children}</div>
    </div>
  );
}

function Row({ l, v, red, mono, multiline }: { l: string; v: string; red?: boolean; mono?: boolean; multiline?: boolean }) {
  return (
    <div className="row" style={{ alignItems: multiline ? 'flex-start' : 'center' }}>
      <span className="row-l">{l}</span>
      <span
        className={`row-v${mono ? ' money' : ''}`}
        style={{
          ...(red ? { color: RED } : undefined),
          ...(multiline ? { whiteSpace: 'normal', textAlign: 'right', lineHeight: 1.4 } : undefined),
        }}
      >
        {v || '—'}
      </span>
    </div>
  );
}

// New Service Case
export function MobileServiceCaseNew({ onCancel, onCreate }: { onCancel: () => void; onCreate: () => void }) {
  return (
    <div className="hz-m screen">
      <header className="hdr">
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#767b6e', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        <div className="scr-title">New Service Case</div>
      </header>
      <div className="scroll" style={{ paddingBottom: 96 }}>
        <div className="card"><div className="card-b">
          <div className="fld"><span className="fld-l">Customer / SO lookup *</span><input className="fld-i" placeholder="Search SO no or customer" /></div>
          <div className="fld"><span className="fld-l">Product *</span><input className="fld-i" placeholder="Auto-filled from SO line" /></div>
          <div style={{ display: 'flex', gap: 9 }}>
            <div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Issue category *</span><input className="fld-i" defaultValue="Product defect" /></div></div>
            <div style={{ flex: 1 }}><div className="fld"><span className="fld-l">Priority *</span><input className="fld-i" defaultValue="Medium" /></div></div>
          </div>
          <div className="fld"><span className="fld-l">Issue number</span><input className="fld-i" placeholder="Customer complaint / ticket ref" /></div>
          <div className="fld"><span className="fld-l">Issue description *</span><textarea className="fld-i" rows={3} style={{ resize: 'none' }} placeholder="Describe the defect / fault" /></div>
        </div></div>
        <div className="card"><div className="card-h"><span className="card-t">Attachments</span><span className="card-sub">0 / 5</span></div><div className="card-b">
          <button style={{ width: '100%', border: '1px dashed #c2c6bd', borderRadius: 11, padding: 18, background: FIELD_BG, fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: '#16695f', cursor: 'pointer' }}>+ Add photo / video / PDF</button>
          <div style={{ fontSize: 10, color: GREY, marginTop: 7, textAlign: 'center' }}>JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to 5</div>
        </div></div>
      </div>
      <div className="actbar"><button className="btn" style={{ flex: 1 }} onClick={onCreate}>Create case</button></div>
    </div>
  );
}
