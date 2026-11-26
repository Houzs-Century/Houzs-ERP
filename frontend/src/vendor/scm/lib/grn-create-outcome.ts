import { inBandFailureText, type InBandFailure } from './mutation-error';

export function grnCreatedOutcome(grnNumber: string, asDraft: boolean, res: InBandFailure): { title: string; body: string } {
  if (asDraft) return { title: `GRN ${grnNumber} saved as draft`, body: 'Saved as a draft — no stock moved yet. Open it and Confirm to receive the goods.' };
  const problem = inBandFailureText(res);
  if (problem) return { title: `GRN ${grnNumber} created — NOT everything was recorded`, body: problem };
  return { title: `GRN ${grnNumber} created`, body: 'Received & posted — inventory + PO received qty updated.' };
}
