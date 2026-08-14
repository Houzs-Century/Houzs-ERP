-- Zero-cost receipt acknowledgement.
--
-- A GRN line may legitimately be free: GWP pillows, demo units, display
-- furniture. The zero-cost gate (scm/lib/zero-cost-receipt-guard.ts) allows
-- those automatically, because a SKU that has never been received at a non-zero
-- cost has no price to be missing. This column is the escape hatch for the
-- other case -- a SKU that normally costs money arriving free this once -- so an
-- operator can say so instead of inventing a price to get past the refusal,
-- which is what a gate with no override eventually trains people to do.
--
-- Default false: every existing line keeps the guard's protection, and the
-- column only ever weakens the check for a line somebody deliberately ticked.
ALTER TABLE scm.grn_items
  ADD COLUMN IF NOT EXISTS zero_cost_ack boolean NOT NULL DEFAULT false;

-- Why this line was received free, in the operator's words. Nullable: the
-- acknowledgement is the decision, the reason is the audit trail for it.
ALTER TABLE scm.grn_items
  ADD COLUMN IF NOT EXISTS zero_cost_reason text;

-- WHO decided, and when. An override with no name on it is not an audit trail,
-- it is an anonymous hole in the gate: the whole point of preferring a recorded
-- zero over a typed-in fake price is that somebody's judgement is attached to
-- it. Both are stamped by the route on the transition to true and cleared when
-- the tick is removed, so they can never outlive the decision they describe.
ALTER TABLE scm.grn_items
  ADD COLUMN IF NOT EXISTS zero_cost_ack_by uuid;
ALTER TABLE scm.grn_items
  ADD COLUMN IF NOT EXISTS zero_cost_ack_at timestamptz;

COMMENT ON COLUMN scm.grn_items.zero_cost_ack IS
  'Operator confirmed this line really was received free; suppresses the zero-cost receipt gate for this line only.';
COMMENT ON COLUMN scm.grn_items.zero_cost_reason IS
  'Why the line was received at zero cost, recorded next to the line that carries it.';
COMMENT ON COLUMN scm.grn_items.zero_cost_ack_by IS
  'The user who ticked zero_cost_ack. NULL whenever zero_cost_ack is false.';
COMMENT ON COLUMN scm.grn_items.zero_cost_ack_at IS
  'When zero_cost_ack was ticked. NULL whenever zero_cost_ack is false.';
