// MobileScan — OCR scan order slip -> background DRAFT SO. Maps to prototype: #scan.
// Capture ONE front slip + ONE OR MORE payment slips (each payment slip = one
// payment; an order can take 2-3 payments). The front slip stays single; the
// payment slip is a multi-photo section with an add-more tile + a thumbnail /
// count list. Front + N payment slips = N+1 photos.
// Flow (2026-07-03): after OCR the slip becomes a DRAFT order created in the
// background (no review step); the operator returns to Orders and opens the
// draft there to review/finalise. Each queued order/slip => its own draft.
export function MobileScan({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: () => void }) {
  // Sample data — two captured payment slips (deposit + balance) alongside the
  // single front slip. Static mock; no real capture / OCR wired here.
  const paymentSlips = ['Deposit slip', 'Balance slip'];

  const CAMERA = (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
  );

  return (
    <div className="hz-m screen">
      <header className="hdr">
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#767b6e', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        <div className="scr-title">Scan order slip</div>
        <div style={{ fontSize: 11, color: '#767b6e', marginTop: 2 }}>Snap the slip — we OCR it and save a draft order to review in Orders.</div>
      </header>
      <div className="scroll">
        {/* FRONT SLIP — single. Seeds the order header (customer / items). */}
        <div style={{ letterSpacing: '.14em', textTransform: 'uppercase', color: '#9aa093', fontSize: 10.5, fontWeight: 700, marginBottom: 6 }}>Front slip</div>
        <div style={{ height: 130, borderRadius: 13, background: 'linear-gradient(135deg,#d7ded6,#c7d0c4)', position: 'relative', marginBottom: 18 }}>
          <span style={{ position: 'absolute', top: 8, right: 8, width: 20, height: 20, borderRadius: '50%', background: '#2f8a5b', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>&#10003;</span>
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#4a4f45', fontWeight: 700 }}>Front slip captured</span>
        </div>

        {/* PAYMENT SLIPS — one photo per payment. Add-more tile + thumbnail list
            with a per-slip remove. Each slip becomes its own payment on the SO. */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ letterSpacing: '.14em', textTransform: 'uppercase', color: '#9aa093', fontSize: 10.5, fontWeight: 700 }}>Payment slips</span>
          <span style={{ fontSize: 10.5, color: '#9aa093' }}>{paymentSlips.length} payments</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {paymentSlips.map((label, i) => (
            <div key={label} style={{ height: 96, borderRadius: 12, background: 'linear-gradient(135deg,#d7ded6,#c7d0c4)', position: 'relative' }}>
              <span style={{ position: 'absolute', top: 5, left: 5, height: 18, minWidth: 18, padding: '0 5px', borderRadius: 999, background: 'rgba(17,20,15,.62)', color: '#fff', fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
              <span style={{ position: 'absolute', top: 5, right: 5, width: 20, height: 20, borderRadius: '50%', background: 'rgba(178,58,58,.9)', color: '#fff', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>&times;</span>
              <span style={{ position: 'absolute', bottom: 6, left: 0, right: 0, textAlign: 'center', fontSize: 9.5, color: '#4a4f45', fontWeight: 700 }}>{label}</span>
            </div>
          ))}
          {/* Add-more tile — tapping captures another payment slip. */}
          <button style={{ height: 96, border: '1.5px dashed #16695f', borderRadius: 12, background: '#f4f6f3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, fontFamily: 'inherit', cursor: 'pointer' }}>
            {CAMERA}
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#16695f' }}>Add payment</span>
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: '#9aa093', textAlign: 'center', marginTop: 10 }}>
          1 front slip + {paymentSlips.length} payment slips &middot; each payment slip = one payment
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, background: '#f3ece0', border: '1px solid #e8dcc5', borderRadius: 11, padding: 11, marginTop: 12, fontSize: 11, color: '#6a4a1e', lineHeight: 1.5 }}>
          We read the slips and save a draft order in the background — one payment row per payment slip. Open the draft from Orders to review every field, correct anything the reader missed, then finalise.
        </div>
      </div>
      <div className="actbar"><button className="btn" onClick={onSubmit}>Scan &amp; save draft</button></div>
    </div>
  );
}
