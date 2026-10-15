/* "Supervisor PIN" (P4 / P5 / P12 / P16): any cashier with the Supervisor
 * role, verified offline; the supervisor's name is returned for the audit
 * fields (override_by, void_by). */
import { useState } from "react";
import { PinPad } from "../PinPad";
import { verifyPin } from "../pin";
import type { BundleCashier } from "../types";
import { Modal } from "./Modal";

export async function findSupervisor(pin: string, cashiers: readonly BundleCashier[]): Promise<BundleCashier | null> {
  for (const c of cashiers) if (c.role === "SUPERVISOR" && (await verifyPin(pin, c.pin_hash))) return c;
  return null;
}

export function SupervisorPin({ why, cashiers, onOk, onClose }: { why: string; cashiers: readonly BundleCashier[]; onOk: (s: BundleCashier) => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const supers = cashiers.filter((c) => c.role === "SUPERVISOR");
  return (
    <Modal title="Supervisor PIN" onClose={onClose} width={360}>
      <p className="muted" style={{ marginTop: 0 }}>{why}</p>
      {supers.length === 0 ? (
        <p className="err">No supervisor is assigned to this event. Assign one in the ERP, then refresh the catalog.</p>
      ) : (
        <PinPad
          title="Supervisor, enter your PIN"
          shakeKey={shake}
          error={error}
          disabled={busy}
          onSubmit={(pin) => {
            setBusy(true);
            findSupervisor(pin, supers).then((s) => { if (s) onOk(s); else { setError("Not a supervisor PIN"); setShake((k) => k + 1); } }).finally(() => setBusy(false));
          }}
        />
      )}
    </Modal>
  );
}
