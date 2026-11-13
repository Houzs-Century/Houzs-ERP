import { assrExchangePoText } from "../vendor/scm/lib/assr/case-fields";
import { writeScmHandoff } from "../lib/scmHandoffStorage";

const INK = "#11140f";
const MUTED = "#767b6e";

type CaseRow = {
  id: number;
  company_id?: number | string | null;
  item_code?: string | null;
  item_name?: string | null;
  item_group?: string | null;
  assr_no?: string | null;
  stage?: string | null;
  exchange_pos?: unknown;
};

/* Mobile case-detail "Exchange PO": the case's own REAL exchange purchase orders
   (read-only), plus a "Raise exchange PO" button that seeds the mobile New-PO
   form for a one-to-one exchange and carries the case id so the created PO stamps
   assr_case_id. onRaise opens the PO-create screen (MobileApp); it is undefined —
   and the button hidden — with no create permission. Its own module because
   MobileServiceCase.tsx sits at its file-size ceiling. */
export function MobileExchangePoRow({ c, onRaise }: { c: CaseRow; onRaise?: () => void }) {
  const text = assrExchangePoText(c);
  const canRaise = !!onRaise && !!c.item_code && c.stage !== "completed" && c.stage !== "voided";
  if (!text && !canRaise) return null;
  return (
    <>
      {text && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: "1px solid #f4f5f2" }}>
          <span style={{ fontSize: 11, color: MUTED, flex: "none" }}>Exchange PO</span>
          <span className="money" style={{ fontSize: 12.5, fontWeight: 600, color: INK, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
        </div>
      )}
      {canRaise && (
        <button
          onClick={() => {
            writeScmHandoff("exchangePoSeed", {
              assrCaseId: Number(c.id),
              itemCode: c.item_code,
              itemName: c.item_name ?? undefined,
              itemGroup: c.item_group ?? undefined,
            });
            onRaise!();
          }}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", height: 40, marginTop: 8, borderRadius: 10, border: "1px solid var(--hz-c-primary)", background: "var(--hz-c-surface)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
        >
          Raise exchange PO
        </button>
      )}
    </>
  );
}
