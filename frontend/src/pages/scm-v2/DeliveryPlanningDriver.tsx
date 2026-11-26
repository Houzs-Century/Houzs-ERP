import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { MobileDeliveryPlanning } from "../../mobile/MobileDeliveryPlanning";
import { MobilePOD } from "../../mobile/MobilePOD";
import { ConfirmProvider } from "../../vendor/scm/components/ConfirmDialog";
import "../../mobile/mobile.css";

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
  const column: CSSProperties = {
    width: "100%",
    maxWidth: 440,
    height: "100%",
    overflow: "hidden",
    borderRadius: 14,
    border: "1px solid var(--hz-c-border)",
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
