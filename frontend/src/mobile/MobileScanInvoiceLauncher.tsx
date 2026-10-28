// The "Scan invoice" entry rendered above the mobile Purchase Invoices list
// (MobileModuleList's aboveList) — the mobile sibling of the desktop list's
// "Scan invoice" menu item. Kept in its own tiny module so it can be imported
// eagerly with the list while the heavy scanner screen (MobileScanInvoice) stays
// lazy-loaded until the operator actually opens it.

export function ScanInvoiceLauncher({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", height: 46,
        borderRadius: 12, border: "1px solid #16695f", background: "#fff", color: "#16695f",
        fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
        justifyContent: "center", marginBottom: 12,
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
      Scan invoice
    </button>
  );
}
