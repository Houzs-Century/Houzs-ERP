import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { fieldPhotoContext, uploadFieldPhoto } from "../../vendor/scm/lib/slip";
import { serverFieldPhotoRestore, useFieldPhotos } from "../../lib/fieldPhotos";
import { useUpdateMfgDeliveryOrderStatus } from "../../vendor/scm/lib/delivery-order-queries";
import { DO_SHIPPED_STATES, doHasArrived } from "../../vendor/shared/do-shipped-states";
import { FieldPhotos } from "../FieldPhotos";
import type { DoPodFields } from "../../pages/scm-v2/DoProofOfDeliveryCard";

/* The office uploading a Delivery Order's POD for a crew that could not (owner,
   2026-11-17: every job can take a POD upload). The same two moves a job has:
     on the road  -> "Complete": the DO's own POD flip (PATCH …/status DELIVERED
                     with the photos), the path the crew's phone takes
     delivered    -> "Add photos": POST …/pod-photos, appends, moves nothing
   A draft has shipped nothing, so it is confirmed first; a cancelled DO takes none.
   Photos upload on pick into the DO's stop context, as on the phone. */

const MAX_PHOTOS = 20;
const DO_POD_MAX = 40;

export function DoPodUpload({ h }: { h: DoPodFields }) {
  const qc = useQueryClient();
  const status = (h.status ?? "").toUpperCase();
  const delivered = doHasArrived(status) || !!h.delivered_at;
  const onRoad = !delivered && (DO_SHIPPED_STATES as readonly string[]).includes(status);
  const had = h.pod_photo_keys?.length ?? (h.pod_r2_key ? 1 : 0);
  const context = fieldPhotoContext({ kind: "do", doId: h.id });
  const picked = useFieldPhotos({
    stampLabel: null,
    max: delivered ? Math.max(0, Math.min(MAX_PHOTOS, DO_POD_MAX - had)) : MAX_PHOTOS,
    upload: (file) => uploadFieldPhoto({ file, context }),
    restore: serverFieldPhotoRestore(context),
  });
  const deliver = useUpdateMfgDeliveryOrderStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!delivered && !onRoad) {
    return (
      <div className="mt-3 text-[12.5px] text-ink-muted">
        {status === "CANCELLED" ? "This delivery order is cancelled; it takes no POD." : "Confirm the delivery order first; its POD can be uploaded once it has shipped."}
      </div>
    );
  }

  const save = async () => {
    const gate = picked.gate("Choose at least one photo.");
    if (!gate.ok) { setError(gate.reason); return; }
    setBusy(true); setError(null);
    try {
      if (delivered) {
        await authedFetch(`/delivery-orders-mfg/${encodeURIComponent(h.id)}/pod-photos`, {
          method: "POST", body: JSON.stringify({ photoKeys: gate.keys }),
        });
      } else {
        await deliver.mutateAsync({ id: h.id, status: "DELIVERED", evidence: { podKey: gate.keys[0], podKeys: gate.keys } });
      }
      picked.clear();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mfg-delivery-order-detail", h.id] }),
        qc.invalidateQueries({ queryKey: ["fleet-do-pod", h.id] }),
      ]);
    } catch (e) {
      setError((e as Error).message || "Could not save. The photos are uploaded; try again.");
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 rounded-lg border border-border p-4" data-testid="do-pod-upload">
      <div className="mb-1 text-[12.5px] text-ink-muted">
        {delivered ? "Add more photos to this delivery order's POD" : "Upload the POD for the crew (marks the delivery order delivered)"}
      </div>
      <FieldPhotos api={picked} disabled={busy} title="Photos" />
      <button type="button" disabled={busy || !picked.photos.length} onClick={save}
        className="mt-2 w-full rounded-md bg-accent py-2 text-[13px] font-semibold text-white disabled:opacity-50">
        {busy ? "Saving…" : delivered ? `Add ${picked.photos.length || ""} photo${picked.photos.length === 1 ? "" : "s"}` : "Mark delivered with these photos"}
      </button>
      {error && <div className="mt-2 text-[12.5px] text-red-600 dark:text-red-300">{error}</div>}
    </div>
  );
}
