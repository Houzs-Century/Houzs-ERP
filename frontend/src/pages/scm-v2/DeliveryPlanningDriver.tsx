import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { MobileDeliveryPlanning } from "../../mobile/MobileDeliveryPlanning";
import { MobilePOD } from "../../mobile/MobilePOD";
import { ConfirmProvider } from "../../vendor/scm/components/ConfirmDialog";
// The driver run-sheet is a mobile-first surface (styles live under `.hz-m` in
// mobile.css). The desktop admin board (DeliveryPlanning) is a separate page;
// this route brings the SAME driver run-sheet to a browser so a driver — or an
// admin previewing it — can work it on desktop. Row scope is already the
// caller's own jobs server-side (resolveDeliveryScope): this page adds none.
import "../../mobile/mobile.css";

/* A desktop host for the mobile driver run-sheet. MobileApp drives the phone's
   run-sheet -> POD hand-off through its own screen stack; the desktop shell has
   none, so we mirror that one hand-off with local state: onPod opens MobilePOD,
   and confirming re-enters the run-sheet via completedDoNumber so it advances to
   the next open stop, exactly like the phone. ConfirmProvider is normally
   supplied by MobileApp — the desktop shell has none, and MobilePOD's useConfirm
   throws without it, so we provide it here. */
export function DeliveryPlanningDriver() {
  const navigate = useNavigate();
  const [podDoNumber, setPodDoNumber] = useState<string | null>(null);
  const [completedDoNumber, setCompletedDoNumber] = useState<string | null>(null);

  const frame: CSSProperties = {
    display: "flex",
    justifyContent: "center",
    height: "calc(100dvh - 72px)",
    minHeight: 560,
  };
  // A phone-width column; both child screens are `.hz-m` height:100% and fill it.
  const column: CSSProperties = {
    width: "100%",
    maxWidth: 440,
    height: "100%",
    overflow: "hidden",
    borderRadius: 14,
    border: "1px solid #d6d9d2",
    boxShadow: "0 6px 24px rgba(17,24,16,.12)",
  };

  const inner = podDoNumber ? (
    <div style={column}>
      <MobilePOD
        docNo={podDoNumber}
        onBack={() => setPodDoNumber(null)}
        onDone={() => {
          setCompletedDoNumber(podDoNumber);
          setPodDoNumber(null);
        }}
      />
    </div>
  ) : (
    <div style={column}>
      <MobileDeliveryPlanning
        onBack={() => navigate("/scm")}
        completedDoNumber={completedDoNumber}
        onPod={(doNumber) => setPodDoNumber(doNumber)}
      />
    </div>
  );

  return (
    <ConfirmProvider>
      <div style={frame}>{inner}</div>
    </ConfirmProvider>
  );
}
