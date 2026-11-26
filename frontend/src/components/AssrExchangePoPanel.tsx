import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { AssrExchangePoLine } from "./AssrExchangePoLine";
import { writeScmHandoff } from "../lib/scmHandoffStorage";

type ExchangeCaseRow = {
  id: number;
  company_id?: number | string | null;
  item_code?: string | null;
  item_name?: string | null;
  assr_no?: string | null;
  stage?: string | null;
  exchange_pos?: unknown;
};

export function AssrExchangePoPanel({ caseRow }: { caseRow: ExchangeCaseRow }) {
  const navigate = useNavigate();
  const canRaise =
    !!caseRow.item_code && caseRow.stage !== "completed" && caseRow.stage !== "voided";
  return (
    <>
      <AssrExchangePoLine row={caseRow} />
      {canRaise && (
        <button
          onClick={() => {
            writeScmHandoff("poNewDraft", {
              notes: `Exchange PO for service case ${caseRow.assr_no || caseRow.id}`,
              lines: [{
                rid: `assr-${caseRow.id}-${Date.now()}`,
                materialKind: "mfg_product",
                itemCode: caseRow.item_code ?? "",
                materialName: caseRow.item_name || caseRow.item_code || "",
                notes: "",
                qty: 1,
                unitPriceSen: 0,
                variants: {},
              }],
            });
            navigate(`/scm/purchase-orders/new?fromAssrCase=${caseRow.id}`);
          }}
          className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
        >
          <Plus size={12} /> Raise exchange PO
        </button>
      )}
    </>
  );
}
