import { Meetings } from "../pages/Meetings";

export function MobileMeetings({ onBack }: { onBack: () => void }) {
  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <button onClick={onBack} className="back" style={{ marginBottom: 4 }}><span className="chev">‹</span> Back</button>
            <div className="eyebrow">Team</div>
            <div className="scr-title">Meetings</div>
          </div>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Meetings embedded />
      </div>
    </div>
  );
}
