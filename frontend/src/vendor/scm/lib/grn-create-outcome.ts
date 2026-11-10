/* What the New GRN form says once a receipt is saved.

   A non-draft POST /grns posts the receipt in the same request and answers 201
   with `movementErrors` (the stock IN was refused) and `recountError` (the PO's
   received qty was not recounted) in the BODY — the receipt stands either way
   (grns.ts postGrnAndRollup). The form announced "inventory + PO received qty
   updated" without reading either, so a receipt whose PO still showed the goods
   as outstanding was reported as done. The follow-up PATCH /:id/post is an
   idempotent no-op on an already-POSTED receipt and carries neither. */
import { inBandFailureText, type InBandFailure } from './mutation-error';

export function grnCreatedOutcome(grnNumber: string, asDraft: boolean, res: InBandFailure): { title: string; body: string } {
  if (asDraft) return { title: `GRN ${grnNumber} saved as draft`, body: 'Saved as a draft — no stock moved yet. Open it and Confirm to receive the goods.' };
  const problem = inBandFailureText(res);
  if (problem) return { title: `GRN ${grnNumber} created — NOT everything was recorded`, body: problem };
  return { title: `GRN ${grnNumber} created`, body: 'Received & posted — inventory + PO received qty updated.' };
}
