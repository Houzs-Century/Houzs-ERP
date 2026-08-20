// ----------------------------------------------------------------------------
// ac-preflight — say it at SAVE time, not five minutes later in a queue nobody
// opens.
//
// THE DEFECT THIS CLOSES IS SILENCE, NOT PERMISSIVENESS. Owner, 2026-08-19:
// "开单的时候就挡住 AutoCount 一定会拒绝的形状,不要等到五分钟后在队列里默默失败".
// Today a salesperson presses Save, the document looks fine, `enqueueSoCreate`
// composes the WHOLE AutoCount payload three lines before the 201
// (routes/mfg-sales-orders.ts:5557), the composer refuses it, `noteReadFailure`
// files a `skipped` row — and the operator is handed a 201 and walks away
// believing the order is in the accounts. The system already knew. It did not
// say.
//
// ── WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────
// It is NOT a second opinion about what AutoCount accepts. Every judgement here
// comes from the composer itself — `resolveAcAgent` for the agent, and the
// composer's own thrown refusal for everything else. This module supplies only
// the two things the composer does not have: the OPERATOR'S SENTENCE, and the
// decision about whether the ERP may stop the save for it.
//
// That split is the whole point. The repo has paid for the other shape more
// than any other pattern this week — a checker that answers "is this sendable"
// with logic of its own drifts from the sender the first time either moves, and
// so-confirm-gate.ts:101 is the live proof: it accepts free-text `agent` ALONE,
// while `resolveAcAgent` only trusts `agent` through AGENT_MAP. Measured on
// origin/main @839fcaed0: `collectSoConfirmProblems` returns NO problem for
// `agent = "Unassigned"` with no salesperson, and `resolveAcAgent("Unassigned",
// null)` returns null. Same order, two verdicts, and the operator hears the
// looser one. `acAgentProblem` below is that same gate asking the composer's
// own question, so there is nothing left to drift.
//
// ── BLOCK OR WARN, PER CAUSE, WITH THE REASON ───────────────────────────────
// The owner's standing rule: a gate may only fail someone for something they
// could have caused. A block on a document the operator cannot fix is worse
// than the current silence — it stops the shop floor AND blames the wrong
// person. so-location-gate.ts:58-68 states the same trade-off from the other
// side. So the decision is made per cause, once, here:
//
//   BLOCK — the fix is a control on the screen the operator is already looking
//   at, and the sentence names that control.
//
//     · A salesperson AutoCount can be given (acAgentProblem).
//       WHY BLOCK: this is not a new gate. `salesperson_required` has refused a
//       salesperson-less confirm since the owner's 2026-08-08 ruling on
//       HC-SO-2607-008 — an order confirmed with the placeholder "Unassigned".
//       It simply asked a laxer question than the composer, so the very shape
//       that produced the ruling walked straight through it. The remedy is
//       unchanged and it is on the form: pick a salesperson.
//       NEWLY REFUSED SET, stated so the widening is not larger than it reads:
//       orders with NO salesperson link whose `agent` text is not an AutoCount
//       sales agent. An order carrying a salesperson passes exactly as before —
//       `resolveAcAgent` step 3 trusts any real `scm.staff.name` unmapped, so
//       no rep hired since the cutover is refused.
//
//   WARN — the ERP says plainly that the document will not reach the accounts
//   until X is fixed, and saves it anyway.
//
//     · A purchase-order line whose ERP code maps to several AutoCount items
//       and this PO's supplier owns none of them (or more than one).
//       WHY NOT BLOCK: the remedy is master data — retire the duplicate
//       AutoCount item, or record what this supplier calls the product in
//       `scm.supplier_material_bindings`. A buyer raising a PO owns neither,
//       and refusing the purchase order would stop procurement over an
//       accounting-map defect. MEASURED on origin/main: all 117 ambiguous ERP
//       codes in the compiled map refuse under a creditor that owns none of
//       their candidates, and 0 refuse when no supplier is named — so this is
//       the purchase path's problem alone, and it is live today.
//     · A supplier with no AutoCount creditor code (`scm.suppliers.code`).
//       WHY NOT BLOCK: the code is issued by accounts, not by the buyer.
//     · Everything else the composer can refuse — a line with no stock
//       location, a Desc2 over nvarchar(100), a sofa build that cannot be
//       folded, a line with no AutoCount DtlKey, a document the ERP could not
//       read. Each is either already blocked earlier by a gate that CAN name
//       the fix (so-location-gate for the location) or needs data the operator
//       on that screen does not own.
//
// WHERE THE WARNS ARE ASKED IS WHAT MAKES THEM SAFE: `acNotSentProblems` is
// handed the refusal the enqueue ALREADY threw, after the document is
// committed. It cannot refuse a save because there is no save left to refuse.
// The severity is expressed by the call site, not by a flag a caller could get
// wrong.
//
// ── ONE SENTENCE PER CAUSE, HERE ────────────────────────────────────────────
// Modelled on frontend/src/vendor/scm/lib/do-next-step.ts (2026-08-18): one
// module owns the wording, no surface invents a second one. The composer's own
// messages are kept as-is in the outbox row — they are written for whoever
// reads the queue and they name the foreign key, the SDK call and the remedy in
// engineering terms. These are the same facts addressed to the person holding
// the document, and every one of them ends in a NEXT STEP, because "ERP item
// code X maps to two AutoCount items" tells an operator nothing about what to
// do next.
// ----------------------------------------------------------------------------
import type { SaveProblem } from '../shared/so-save-problems';
import {
  resolveAcAgent,
  KeylessLineError,
  SofaCollapseError,
  MissingLocationError,
  MissingAgentError,
  MissingSalesLocationError,
  MissingCreditorError,
  Desc2TooLongError,
  AcSoToPoAlignmentError,
} from '../../services/autocount-writeback';
import { ItemCodeError } from '../../services/autocount-item-code';
import { AcReadError } from './autocount-read';

/** Which document the refusal is about — only used to pick the noun in a
 *  sentence, never to decide anything. */
export type AcDocKind = 'sales order' | 'purchase order' | 'document';

/**
 * The one code every "saved, but the accounts will not see it" problem carries.
 *
 * ONE code and not one per cause, on purpose: a consumer branching on the code
 * wants to know "did this reach AutoCount", and the reason it did not is in the
 * message. The old single-error contract's mistake was the opposite — one
 * sentence for five causes — and that is fixed by the message, not the code.
 */
export const AC_NOT_SENT = 'ac_not_sent';

/** The code the confirm gate raises when no AutoCount sales agent can be named.
 *  Kept as `salesperson_required` — the SAME code the gate has always used, so
 *  no consumer branching on it has to change and no surface has to learn a new
 *  word for a rule that has not changed. */
export const SALESPERSON_REQUIRED = 'salesperson_required';

/**
 * Can this order name a sales agent the account book will accept?
 *
 * ASKS THE COMPOSER, and that is the entire content of this function. The
 * alternative — repeating "salesperson_id or agent is non-blank" here — is what
 * produced the disagreement described in the header.
 *
 * `salespersonName` is the name behind `salesperson_id`, when the caller
 * already holds it. It is OPTIONAL and defaults to null because the two call
 * sites reach here with a blank `salespersonId`, where the composer would read
 * null anyway — so neither pays a query for this.
 */
export function acAgentIsSendable(
  agent: string | null | undefined,
  salespersonName: string | null = null,
): boolean {
  return resolveAcAgent(agent, salespersonName) !== null;
}

/**
 * The confirm gate's salesperson problem, or null when the order names one.
 *
 * Two sentences for two situations, because they send the operator to different
 * places: an order with NOTHING has to have a salesperson picked; an order
 * carrying placeholder text has to have that text replaced, and being told to
 * "assign a salesperson" when the field visibly says "Unassigned" is the circle
 * so-location-gate.ts warns about.
 */
export function acAgentProblem(
  facts: {
    salespersonId: string | number | null | undefined;
    agent: string | null | undefined;
    salespersonName?: string | null;
  },
): SaveProblem | null {
  const linked = facts.salespersonId != null && String(facts.salespersonId).trim() !== '';
  if (linked) return null;
  if (acAgentIsSendable(facts.agent, facts.salespersonName ?? null)) return null;

  const placeholder = String(facts.agent ?? '').trim();
  return {
    code: SALESPERSON_REQUIRED,
    message: placeholder
      ? `"${placeholder}" is not a salesperson this order can be credited to — it is text, not a `
        + 'person on the team. Pick a salesperson from the Salesperson list, then save again.'
      : 'A salesperson must be assigned before this order can be confirmed.',
    field: 'Salesperson',
  };
}

/**
 * What the operator is told when the document saved but will not reach the
 * accounts — one entry per reason, each ending in a next step.
 *
 * INPUT IS THE COMPOSER'S OWN THROWN REFUSAL. Nothing is re-decided here: by
 * the time an error reaches this function the composer has already refused, and
 * this only chooses the words. An error the composer did not raise as a named
 * refusal returns [] — this function must never invent a problem out of an
 * exception it does not recognise, because an operator who is warned about
 * something that did not happen stops reading warnings.
 */
export function acNotSentProblems(e: unknown, docKind: AcDocKind = 'document'): SaveProblem[] {
  const problem = (message: string, extra?: { line?: string; field?: string }): SaveProblem[] => [
    { code: AC_NOT_SENT, message, ...(extra ?? {}) },
  ];
  const saved = `Saved. This ${docKind} is in the ERP, but it has NOT reached the accounts`;

  if (e instanceof ItemCodeError) {
    /* EVERY failing line, not the first. The composer's own class was built
       this way for the same reason (autocount-item-code.ts:294-304): an
       operator who fixes one and re-saves into the next is how a divergence
       outlives everyone who remembers it. */
    return e.failures.map((f) => ({
      code: AC_NOT_SENT,
      line: f.erpItemCode,
      field: 'Supplier',
      message:
        `${saved}: the accounts hold more than one item under "${f.erpItemCode}", and this `
        + `${docKind}'s supplier owns none of them — so the accounts cannot tell which one you `
        + 'mean. Raise this order against the supplier the product is actually bought from, or '
        + 'ask for the duplicate AutoCount item to be retired. Until then the order stays in the '
        + 'ERP only.',
    }));
  }

  if (e instanceof MissingCreditorError) {
    return problem(
      `${saved}: this supplier has no AutoCount creditor code, and the accounts cannot file a `
      + 'purchase order against a supplier they do not hold. Ask accounts to give this supplier '
      + 'its creditor code, then re-raise the order.',
      { field: 'Supplier' },
    );
  }

  if (e instanceof MissingAgentError) {
    /* Reachable here only on a path the confirm gate does not cover — the gate
       refuses this shape before the save wherever it runs. Kept because a
       refusal that has no sentence is the defect this module exists to close,
       not because this line is expected to fire. */
    return problem(
      `${saved}: it names no salesperson the accounts recognise. Assign a salesperson on the `
      + 'order, then re-raise it.',
      { field: 'Salesperson' },
    );
  }

  if (e instanceof MissingLocationError || e instanceof MissingSalesLocationError) {
    return problem(
      `${saved}: at least one line has no warehouse, and the accounts refuse a line that does not `
      + 'say where the stock comes from. Set the delivery State (it decides the warehouse) or the '
      + 'warehouse on the line, then re-raise the order.',
      { field: 'Sales Location' },
    );
  }

  if (e instanceof Desc2TooLongError) {
    return problem(
      `${saved}: a line's Further Description is longer than the accounts can store, and cutting a `
      + 'specification short would send a wrong instruction rather than a short one. Shorten the '
      + 'description on that line, then re-raise the order.',
      { field: 'Further Description' },
    );
  }

  if (e instanceof SofaCollapseError) {
    return problem(
      `${saved}: the accounts hold a sofa build as ONE line, and this build cannot be folded into `
      + 'one without inventing text nobody chose. Ask for this build to be checked before it is '
      + 'billed.',
      { field: 'Sofa build' },
    );
  }

  if (e instanceof AcSoToPoAlignmentError) {
    /* The operator's version of "DtlKeys and Details are matched by position".
       They cannot act on index alignment, and they should not have to: what
       they can act on is that this order was raised FROM a sales order whose
       sofa build the accounts already hold folded, while the ERP's record of
       that is only half there. */
    return problem(
      `${saved}: it was raised from a sales order, and one of its sofa builds does not line up `
      + 'with how the accounts already hold that build — sending it would put the supplier cost '
      + 'on the wrong line. Ask for this build\'s line keys to be checked, then re-raise the '
      + 'order.',
      { field: 'Sofa build' },
    );
  }

  if (e instanceof KeylessLineError) {
    return problem(
      `${saved}: a line has no link back to the account book, and sending it would append a `
      + 'duplicate to the live ledger. Ask for this document\'s line keys to be backfilled.',
    );
  }

  if (e instanceof AcReadError) {
    return problem(
      `${saved}: the ERP could not finish reading this ${docKind} to send it. Nothing is lost — `
      + 'tell IT, and it can be re-sent once they have looked.',
    );
  }

  /* Anything else is not a refusal the composer named, and this module does not
     guess at one. autocount-outbox.ts's own handler takes the same view. */
  return [];
}
