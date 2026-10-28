// ---------------------------------------------------------------------------
// governance.ts — the Agent Operating Spec, made executable.
//
// docs/agents/operating-spec.md is the owner's target operating model. Its
// section 11 is explicit: the decision-authority tables "should be converted
// into a machine-readable Agent configuration rather than copied as one
// unstructured prompt." This file is that conversion — the policy the LLM is
// NOT trusted to hold in its head.
//
// Nothing here calls an LLM or touches the database. It is pure policy:
//   • WHICH agents exist and how the code's families map to the spec IDs
//   • the per-decision-class autonomy matrix (spec §3.8–§8.8, §9.3)
//   • the Green/Amber/Red data-quality gate (spec §10.2)
//   • the decision-packet shape every agent must emit (spec §9.4 / §10.6)
//   • the runtime states (§10.5) and the stage-promotion gates (§10.4)
//   • canSelfApprove() — the Stage-2 gate, so "auto-approve" stops being the
//     blanket the spec forbids (§1.2: "never a blanket permission to approve
//     everything") and becomes per-decision-class policy.
//
// Design rule taken from the spec itself (§1.2, §10.1): permissions and
// approval are enforced by CODE, not prompt text. So a decision class marked
// `neverAutonomous` is refused here even at Stage 3, and RED data halts a
// material action here, regardless of what any prompt was talked into.
// ---------------------------------------------------------------------------

/** The seven agents the spec names (§2–§9), by their spec IDs. */
export type SpecAgentId =
  | 'HZS-OF-001'   // Order Fulfilment
  | 'HZS-DLV-002'  // Delivery Planning & Transport
  | 'HZS-COM-003'  // Customer Communication
  | 'HZS-REP-004'  // Retail Purchasing & Replenishment (the "Procurement Agent")
  | 'HZS-AR-005'   // Receivables, Collection & Delivery-Release
  | 'HZS-SI-006'   // Sales & Commercial Intelligence
  | 'GROUP-GCOA-001'; // Group Chief Operating Agent (orchestrator)

/** The families the CODE already runs (services/agent-console.ts). Not 1:1 with
 *  the spec: DOCUMENT/PMS have no spec agent, and OF/COM/GCOA have no family. */
export type AgentFamily =
  | 'DELIVERY' | 'DOCUMENT' | 'CS' | 'COLLECTION' | 'PROCUREMENT' | 'PMS' | 'OF' | 'SI';

/** Family → spec ID, for the families that map. The unmapped ones are honest
 *  absences, not forced fits:
 *   • DOCUMENT — a document-flow patrol; maps to no spec agent.
 *   • PMS      — roadshow/project analytics; the CLOSEST thing to HZS-SI-006 but
 *                not it (SI is company-wide commercial intelligence). Left
 *                unmapped so nobody mistakes one for the other.
 *   • CS       — computes delivery-promise dates; it is NOT the Communication
 *                agent (no WhatsApp/email, no reply→facts). HZS-COM-003 is a gap. */
export const FAMILY_TO_SPEC: Partial<Record<AgentFamily, SpecAgentId>> = {
  OF: 'HZS-OF-001',
  SI: 'HZS-SI-006',
  DELIVERY: 'HZS-DLV-002',
  COLLECTION: 'HZS-AR-005',
  PROCUREMENT: 'HZS-REP-004',
};

/**
 * Implementation status per spec agent.
 *
 * This replaced a binary `UNIMPLEMENTED_SPEC_AGENTS` list, which had gone
 * half-wrong within a day: #753 shipped the ERP Assistant, which IS the GCOA's
 * routing limb (§9.1 "route tasks to specialist Agents… provide one accountable
 * management view"), while the constant still flatly said GCOA did not exist. A
 * binary flag cannot describe an agent that is one-fifth built, so it lies in
 * whichever direction you set it — and a registry that lies about its own coverage
 * is the failure mode this file was written to prevent.
 *
 * PARTIAL is therefore a first-class state, and it carries its receipts: what
 * actually runs, and what the spec asks for that nothing does yet.
 */
export interface SpecAgentStatus {
  status: 'FULL' | 'PARTIAL' | 'NONE';
  /** Spec limbs that have running code, with where it lives. */
  implemented: readonly string[];
  /** Spec limbs with NO implementation. Empty for FULL. */
  missing: readonly string[];
}

export const SPEC_AGENT_STATUS: Record<SpecAgentId, SpecAgentStatus> = {
  'HZS-OF-001':  { status: 'FULL',    implemented: ['order-fulfilment.ts + of-agent.ts patrol'], missing: [] },
  'HZS-DLV-002': { status: 'FULL',    implemented: ['delivery family + delivery-planning'], missing: [] },
  'HZS-REP-004': { status: 'FULL',    implemented: ['procurement family + procurement-execute'], missing: [] },
  'HZS-AR-005':  { status: 'PARTIAL', implemented: ['release-gate.ts (§7.10 delivery-release)'],
                   missing: ['receipt→invoice matching (§7.4) — needs a bank feed, which does not exist yet'] },
  'HZS-SI-006':  { status: 'FULL',    implemented: ['si-agent.ts patrol over SO + PMS'], missing: [] },
  'HZS-COM-003': { status: 'PARTIAL', implemented: ['assistant.ts — INTERNAL staff chat only'],
                   missing: ['customer-facing channels (WhatsApp/email inbound→reply); the owner deferred these deliberately'] },
  'GROUP-GCOA-001': {
    status: 'PARTIAL',
    implemented: ['assistant.ts — routes a question to specialists, gathers their own briefs, words ONE answer (§9.1 routing + single management view)'],
    missing: [
      'measurable operating plans with owners/milestones/thresholds (§9.1)',
      'enterprise dependency graph order→material→production→delivery→collection (§9.1)',
      'daily/weekly control-tower review (§9.1)',
      'cross-functional conflict resolution, e.g. delivery urgency vs payment risk (§9.1)',
      'execution verification + recovery tasks when an approved action did not land (§9.1)',
    ],
  },
};

/** Spec agents with NO code at all. Derived, so it can no longer drift from the
 *  status map the way a hand-maintained list did. */
export const UNIMPLEMENTED_SPEC_AGENTS: readonly SpecAgentId[] =
  (Object.keys(SPEC_AGENT_STATUS) as SpecAgentId[]).filter((a) => SPEC_AGENT_STATUS[a].status === 'NONE');

// ---------------------------------------------------------------------------
// Autonomy matrix — spec §3.8–§8.8 and §9.3, transcribed verbatim.
// ---------------------------------------------------------------------------

/** The three-stage model, §1.3. */
export type AutonomyStage = 1 | 2 | 3;

/** One decision class's authority across the stages. The strings are the spec's
 *  own wording; `neverAutonomous` is the "Never autonomous" column, which is a
 *  hard stop at EVERY stage — the whole point of encoding this is that Stage 3
 *  does not mean "anything goes." */
export interface DecisionAuthority {
  stage1: string;
  stage2: string;
  stage3: string;
  neverAutonomous: string;
}

type Matrix = Record<string, DecisionAuthority>;

const OF: Matrix = {
  READINESS_STATUS:   { stage1: 'Recommend', stage2: 'Self-certify rule-based', stage3: 'Automatic', neverAutonomous: 'Ignore blocker' },
  MISSING_DATA_TASK:  { stage1: 'Create draft', stage2: 'Auto-create', stage3: 'Automatic', neverAutonomous: 'Invent specification' },
  FULFILMENT_SOURCE:  { stage1: 'Recommend', stage2: 'Select within stock/approved source rules', stage3: 'Automatic standard sourcing', neverAutonomous: 'New supplier/contract' },
  COMMITTED_DATE_CHANGE: { stage1: 'Recommend', stage2: 'No self-approval unless customer already selected option', stage3: 'Certified reschedule workflow with customer consent', neverAutonomous: 'Silent date change' },
  DELIVERY_RELEASE:   { stage1: 'Recommend', stage2: 'Approve when all policy gates green', stage3: 'Automatic certified release', neverAutonomous: 'Override payment/quality hold' },
};

const DLV: Matrix = {
  TRIP_GROUPING:      { stage1: 'Recommend', stage2: 'Self-approve within hard constraints', stage3: 'Automatic certified optimiser', neverAutonomous: 'Break hard constraints' },
  VEHICLE_DRIVER_ASSIGNMENT: { stage1: 'Recommend', stage2: 'Within roster/capacity/safety rules', stage3: 'Automatic', neverAutonomous: 'Unsafe or unqualified assignment' },
  TIME_WINDOW_PROPOSAL: { stage1: 'Draft', stage2: 'Confirm from customer-approved options', stage3: 'Automatic consent workflow', neverAutonomous: 'Unilateral change' },
  OUTSOURCE_TRIP:     { stage1: 'Recommend', stage2: 'Within approved vendor/rate/limit', stage3: 'Automatic standard lane', neverAutonomous: 'New vendor/high spend' },
  EMERGENCY_REPLAN:   { stage1: 'Recommend', stage2: 'Auto-replan reversible sequence', stage3: 'Automatic', neverAutonomous: 'Conceal customer impact' },
};

const COM: Matrix = {
  TEMPLATE_SELECTION: { stage1: 'Recommend', stage2: 'Self-select approved template', stage3: 'Automatic', neverAutonomous: 'Use unapproved legal wording' },
  ROUTINE_REMINDER:   { stage1: 'Draft', stage2: 'Auto-send by cadence/consent', stage3: 'Automatic', neverAutonomous: 'Harassment/opt-out breach' },
  UPDATE_STRUCTURED_FIELD: { stage1: 'Propose', stage2: 'High-confidence low-risk field with audit', stage3: 'Automatic certified extraction', neverAutonomous: 'Price/refund/contract change' },
  DELIVERY_CONFIRMATION: { stage1: 'Record proposal', stage2: 'Auto-record explicit customer choice', stage3: 'Automatic', neverAutonomous: 'Infer silence as consent' },
  // §5.8: this class has "No approval" at BOTH stage 2 and 3 — it never leaves
  // classify-only. Encoded as neverAutonomous with the stages saying the same.
  COMPLAINT_RESOLUTION: { stage1: 'Classify only', stage2: 'No approval', stage3: 'No approval', neverAutonomous: 'Promise remedy' },
};

const REP: Matrix = {
  NET_REPLENISHMENT:  { stage1: 'Calculate', stage2: 'Self-certify', stage3: 'Automatic', neverAutonomous: 'Ignore reservation' },
  WAREHOUSE_TRANSFER: { stage1: 'Recommend', stage2: 'Approve within policy', stage3: 'Automatic standard transfer', neverAutonomous: 'Transfer legal/tax exception' },
  HOOKKA_PRODUCTION_REQUEST: { stage1: 'Draft', stage2: 'Auto-create within capacity agreement', stage3: 'Automatic', neverAutonomous: 'Override Hookka priority' },
  EXTERNAL_PO:        { stage1: 'Approval', stage2: 'Low-value catalogue within limit', stage3: 'Automatic certified repeat', neverAutonomous: 'New/high-value supplier' },
  AGEING_ACTION:      { stage1: 'Recommend', stage2: 'No price/discount approval', stage3: 'Auto-task only', neverAutonomous: 'Write-off/markdown' },
};

const AR: Matrix = {
  BALANCE_CALCULATION: { stage1: 'Calculate', stage2: 'Self-certify', stage3: 'Automatic', neverAutonomous: 'Alter ledger' },
  RECEIPT_MATCH:      { stage1: 'Propose', stage2: 'Auto-match exact/high-confidence low-risk', stage3: 'Automatic certified rules', neverAutonomous: 'Ambiguous/high-value match' },
  ROUTINE_REMINDER:   { stage1: 'Draft', stage2: 'Auto-send approved cadence', stage3: 'Automatic', neverAutonomous: 'Disputed/opt-out contact' },
  DELIVERY_HOLD:      { stage1: 'Recommend', stage2: 'Automatic policy hold', stage3: 'Automatic', neverAutonomous: 'Use hold as punishment' },
  DELIVERY_RELEASE:   { stage1: 'Recommend', stage2: 'Self-release all gates green within policy', stage3: 'Automatic', neverAutonomous: 'Override credit exception' },
};

const SI: Matrix = {
  INSIGHT_CLASSIFICATION: { stage1: 'Recommend', stage2: 'Self-publish', stage3: 'Automatic', neverAutonomous: 'Hide adverse result' },
  FOLLOW_UP_TASK:     { stage1: 'Draft', stage2: 'Auto-create low-risk task', stage3: 'Automatic', neverAutonomous: 'Spam customer' },
  DEMAND_SIGNAL:      { stage1: 'Calculate', stage2: 'Self-certify', stage3: 'Automatic', neverAutonomous: 'Convert to firm order' },
  DISCOUNT_EXCEPTION: { stage1: 'Flag', stage2: 'No approval', stage3: 'No approval', neverAutonomous: 'Approve discount' },
  EXPERIMENT_PROPOSAL: { stage1: 'Recommend', stage2: 'Small internal test within budget policy', stage3: 'Automatic certified test', neverAutonomous: 'Material campaign spend' },
};

/** GCOA (§9.3) is a decision-RIGHTS table, not a stage table — some rights are
 *  autonomous at all stages, some never. Encoded in the same shape: a right that
 *  is "Never directly" / "No" becomes neverAutonomous at every stage. */
const GCOA: Matrix = {
  ROUTING_DECOMPOSITION: { stage1: 'Autonomous (all stages)', stage2: 'Autonomous', stage3: 'Autonomous', neverAutonomous: 'Routing that changes policy ownership' },
  PRIORITISATION:     { stage1: 'Recommend', stage2: 'Autonomous', stage3: 'Autonomous', neverAutonomous: 'Change committed dates / material spend / contract without approval' },
  LOW_RISK_SEQUENCING: { stage1: 'Recommend', stage2: 'Within policy', stage3: 'Within policy', neverAutonomous: 'Any exception outside thresholds' },
  CROSS_COMPANY_TRANSFER: { stage1: 'Prepare and simulate', stage2: 'Prepare and simulate', stage3: 'Prepare and simulate', neverAutonomous: 'Execute before legal/tax/pricing/accounting certified' },
  FINANCIAL_COMMITMENT: { stage1: 'Never directly', stage2: 'Never directly', stage3: 'Never directly', neverAutonomous: 'Commit funds outside authorised Finance/Procurement workflow' },
  EMERGENCY_STOP:     { stage1: 'Autonomous (safety/fraud/dup/corruption)', stage2: 'Autonomous', stage3: 'Autonomous', neverAutonomous: 'Skip the post-action review' },
  POLICY_THRESHOLD_CHANGE: { stage1: 'No', stage2: 'No', stage3: 'No', neverAutonomous: 'Change policy/threshold without board/management approval' },
};

export const AUTHORITY: Record<SpecAgentId, Matrix> = {
  'HZS-OF-001': OF,
  'HZS-DLV-002': DLV,
  'HZS-COM-003': COM,
  'HZS-REP-004': REP,
  'HZS-AR-005': AR,
  'HZS-SI-006': SI,
  'GROUP-GCOA-001': GCOA,
};

/** Classes EVERY agent shares — the policy is identical whoever the agent is, so
 *  they live once here rather than repeated in every matrix.
 *
 *  CONFIG_TUNING — owner-authorised 2026-07-18 (decision "B") as a first-class
 *  governed class: an agent self-approving a change to its OWN whitelisted
 *  operational parameter (lead-time buffers, chase-days, transit-days …). It is
 *  reversible and bounded (the whitelist enforces the range), so it self-approves
 *  at Stage 2 — but it is refused at Stage 1 and on RED data, and it may NEVER
 *  reach a policy/threshold/control that needs board approval. So "auto-tune" is
 *  no longer an ungoverned blanket (§1.2) for the families that only self-approve
 *  config. */
const SHARED: Matrix = {
  CONFIG_TUNING: {
    stage1: 'Propose',
    stage2: 'Self-approve a whitelisted operational parameter within its bounds',
    stage3: 'Automatic',
    neverAutonomous: 'Change a policy / threshold / control requiring board approval',
  },
};

/** The authority row for one agent + decision class. Falls back to the SHARED
 *  classes (CONFIG_TUNING) before null, so every agent owns them. Null still means
 *  "this agent has no such class" — a caller bug worth surfacing, not a silent
 *  "allowed". */
export function authorityFor(agent: SpecAgentId, decisionClass: string): DecisionAuthority | null {
  return AUTHORITY[agent]?.[decisionClass] ?? SHARED[decisionClass] ?? null;
}

/** A class is never-autonomous when its stage-2 AND stage-3 cells both refuse.
 *  Two classes (COM COMPLAINT_RESOLUTION, SI DISCOUNT_EXCEPTION) say "No
 *  approval" at both stages — they never self-execute no matter the stage. */
export function isNeverAutonomous(a: DecisionAuthority): boolean {
  const blocked = (s: string) => /^no approval$/i.test(s.trim());
  return blocked(a.stage2) && blocked(a.stage3);
}

// ---------------------------------------------------------------------------
// Data-quality gate — spec §10.2.
// ---------------------------------------------------------------------------

export type DataQuality = 'GREEN' | 'AMBER' | 'RED';

export interface DataQualitySignals {
  /** A required source record was missing / unreadable. */
  missingSource?: boolean;
  /** Ledger vs order, stock vs moves, etc. did not reconcile. */
  reconciliationFailed?: boolean;
  /** A duplicate record was detected. */
  duplicate?: boolean;
  /** The record's company dimension disagrees with the scope (cross-company). */
  companyMismatch?: boolean;
  /** Any integrity alarm the domain raised. */
  integrityAlert?: boolean;
  /** The snapshot the agent read is older than its freshness budget. */
  staleSnapshot?: boolean;
  /** Non-critical fields conflicted, or minor gaps. */
  minorGaps?: boolean;
}

export interface DataQualityVerdict {
  status: DataQuality;
  /** RED: a material (irreversible/business-writing) action MUST NOT proceed. */
  mustStop: boolean;
  /** AMBER: may analyse, but must disclose uncertainty and NOT execute anything
   *  irreversible. */
  mustDisclose: boolean;
  /** GREEN only: may recommend or execute within authority. */
  mayExecuteIrreversible: boolean;
  reasons: string[];
}

/**
 * §10.2 verbatim:
 *  RED   — missing source, reconciliation failure, duplicate, company mismatch
 *          or integrity alert → stop material action and escalate.
 *  AMBER — minor gaps, stale snapshot or conflicting non-critical fields →
 *          analyse; disclose uncertainty; restrict irreversible execution.
 *  GREEN — complete, current, reconciled and source-linked.
 */
export function dataQualityGate(sig: DataQualitySignals): DataQualityVerdict {
  const red: string[] = [];
  if (sig.missingSource) red.push('missing source record');
  if (sig.reconciliationFailed) red.push('reconciliation failed');
  if (sig.duplicate) red.push('duplicate record');
  if (sig.companyMismatch) red.push('company dimension mismatch');
  if (sig.integrityAlert) red.push('integrity alert');
  if (red.length) {
    return { status: 'RED', mustStop: true, mustDisclose: true, mayExecuteIrreversible: false, reasons: red };
  }
  const amber: string[] = [];
  if (sig.staleSnapshot) amber.push('stale snapshot');
  if (sig.minorGaps) amber.push('minor gaps / non-critical conflict');
  if (amber.length) {
    return { status: 'AMBER', mustStop: false, mustDisclose: true, mayExecuteIrreversible: false, reasons: amber };
  }
  return { status: 'GREEN', mustStop: false, mustDisclose: false, mayExecuteIrreversible: true, reasons: [] };
}

// ---------------------------------------------------------------------------
// canSelfApprove — the Stage-2 gate (spec §1.2, §1.3, and each agent's §*.8).
// ---------------------------------------------------------------------------

export interface SelfApproveRequest {
  agent: SpecAgentId;
  decisionClass: string;
  /** The stage the operator has certified this agent+class to. Below 2 → no
   *  self-approval by definition (Stage 1 = human approves). */
  stage: AutonomyStage;
  /** The freshness/integrity verdict for the records this action rests on. */
  dataQuality: DataQuality;
  /** A size proxy for the action (units, RM-centi, drops…). Compared to `limit`
   *  to honour "within limit / low-value" stage-2 cells. Omit if the class has
   *  no size dimension. */
  valueProxy?: number;
  /** The stage-2 ceiling for `valueProxy`. Omit = no ceiling on size. */
  limit?: number;
  /** For classes whose neverAutonomous cell is "new supplier/vendor", whether
   *  the counterparty is already known/approved. */
  counterpartyKnown?: boolean;
}

export interface SelfApproveVerdict {
  ok: boolean;
  /** Present when ok=false: the single reason, for the run summary + audit. */
  reason?: string;
}

/**
 * The one function the auto-approve paths must call before executing on their
 * own. It refuses in the cases the spec says are never the agent's to take
 * alone, so turning a family's `auto_approve` on can no longer mean "approve
 * everything" (§1.2). Every refusal names itself so it lands in the run summary.
 *
 * Order matters: the hardest stops first, so the reason is the most serious one.
 */
export function canSelfApprove(req: SelfApproveRequest): SelfApproveVerdict {
  const a = authorityFor(req.agent, req.decisionClass);
  if (!a) {
    return { ok: false, reason: `${req.agent} has no decision class '${req.decisionClass}' — refusing to self-approve an unknown action` };
  }
  // Classes that never self-execute at any stage (e.g. complaint resolution).
  if (isNeverAutonomous(a)) {
    return { ok: false, reason: `'${req.decisionClass}' is never autonomous (${a.neverAutonomous}) — human decision only` };
  }
  // RED data halts every material action, whatever the stage (§10.2).
  const dq = req.dataQuality;
  if (dq === 'RED') {
    return { ok: false, reason: 'data-quality is RED — must stop and escalate, no self-approval' };
  }
  // Stage 1 means a human approves, by definition (§1.3).
  if (req.stage < 2) {
    return { ok: false, reason: 'agent is at Stage 1 for this class — approval is the human role' };
  }
  // AMBER may analyse but not execute anything irreversible (§10.2). Self-
  // approval executes, so AMBER blocks it.
  if (dq === 'AMBER') {
    return { ok: false, reason: 'data-quality is AMBER — may analyse but not self-execute an irreversible action' };
  }
  // "New/high-value supplier" and "New vendor/high spend" are the neverAutonomous
  // cells for EXTERNAL_PO / OUTSOURCE_TRIP — an unknown counterparty is exactly
  // that case, so it is never self-approved. The spec joins the words with a
  // slash ("New/high-value supplier"), so match "new" and "supplier|vendor"
  // independently rather than as an adjacent phrase.
  if (req.counterpartyKnown === false
      && /\bnew\b/i.test(a.neverAutonomous)
      && /(supplier|vendor)/i.test(a.neverAutonomous)) {
    return { ok: false, reason: `counterparty is new — '${a.neverAutonomous}' is never autonomous` };
  }
  // Stage-2 "within limit / low-value" cells: over the ceiling is a human call.
  if (req.limit != null && req.valueProxy != null && req.valueProxy > req.limit) {
    return { ok: false, reason: `size ${req.valueProxy} exceeds the Stage-2 self-approval limit ${req.limit} — human approval required` };
  }
  return { ok: true };
}

/**
 * The CONFIG_TUNING gate — the same policy for EVERY family, so it takes no
 * spec-agent id (families like DOCUMENT / PMS / CS have no spec agent, yet still
 * self-tune config). Owner decision "B", 2026-07-18: bring every family's
 * `auto_approve` config self-approval under governance.
 *
 * The whitelist + numeric bounds (applyConfigProposalValue) already stop a bad
 * value; this adds the autonomy discipline the flag was missing — no self-tune at
 * Stage 1, and none on RED data. Behaviour-preserving for the normal case (a
 * green, Stage-2 family self-tunes as before), so it tightens without disabling
 * the owner's config auto-tuning.
 */
export function canSelfTuneConfig(req: { stage: AutonomyStage; dataQuality: DataQuality }): SelfApproveVerdict {
  if (req.dataQuality === 'RED') {
    return { ok: false, reason: 'data-quality is RED — no self-tuning until it clears' };
  }
  if (req.stage < 2) {
    return { ok: false, reason: 'agent is at Stage 1 — a parameter change is the human role' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Decision packet — the required output shape (§9.4 + §10.6). Encoded so agents
// emit a structured packet, not a summary string. Not yet persisted; the shape
// is fixed here first so every agent converges on ONE structure.
// ---------------------------------------------------------------------------

export interface DecisionOption {
  label: string;
  /** "do nothing" MUST always be one of the options (§9.4). */
  isDoNothing?: boolean;
  note?: string;
}

export interface DecisionPacket {
  agent: SpecAgentId;
  decisionClass: string;
  /** Exactly what is proposed or executed. */
  statement: string;
  /** Business reason + triggering event. */
  reason: string;
  /** Source records with timestamps + freshness. */
  evidence: Array<{ ref: string; at?: string; freshness?: DataQuality }>;
  /** Options considered, including do-nothing. */
  options: DecisionOption[];
  /** Financial / customer / capacity / service / compliance / data-quality. */
  impact: string;
  /** The policy + approval rule applied. */
  policy: string;
  /** 0..1, plus the assumptions and unresolved uncertainties. */
  confidence: number;
  assumptions: string[];
  /** Reversibility, rollback method, verification test. */
  reversible: boolean;
  rollback: string;
  verification: string;
  /** Who executes, who approves (if required), and the deadline. */
  executor: SpecAgentId | 'HUMAN';
  approver?: 'HUMAN' | 'AGENT_AUTO';
  approvalRequired: boolean;
  /** Filled after execution: what happened + whether the benefit was realised. */
  outcome?: string;
}

// ---------------------------------------------------------------------------
// Runtime states (§10.5) and kill-switch scope (§10.6 kill switch).
// ---------------------------------------------------------------------------

export const RUNTIME_STATES = [
  'IDLE', 'OBSERVING', 'ANALYSING', 'WAITING_FOR_DATA', 'WAITING_FOR_APPROVAL',
  'APPROVED', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'FAILED_RECOVERABLE',
  'ESCALATED', 'SUSPENDED',
] as const;
export type RuntimeState = typeof RUNTIME_STATES[number];

/** §10.6: the kill switch must be able to disable at each of these scopes. The
 *  code today has AGENT (per-family) and ALL; CLASS/TOOL/COMPANY/BRANCH are the
 *  spec's additional scopes, named here so the gap is explicit. */
export type KillScope = 'ALL' | 'AGENT' | 'CLASS' | 'TOOL' | 'COMPANY' | 'BRANCH';

// ---------------------------------------------------------------------------
// Stage-promotion gates (§10.4) — the readiness bar to move S1→S2 and S2→S3.
// Encoded so promotion is a checked decision, not a vibe.
// ---------------------------------------------------------------------------

export interface PromotionGate {
  minAcceptanceOrAccuracy: number; // fraction 0..1
  minCases: number;
  controls: string;
  exceptions: string;
  businessOutcome: string;
  signOff: string;
}

export const PROMOTION_GATES: { s1ToS2: PromotionGate; s2ToS3: PromotionGate } = {
  s1ToS2: {
    minAcceptanceOrAccuracy: 0.95,
    minCases: 100,
    controls: 'permission, approval, idempotency, rollback and audit tested',
    exceptions: 'known exception taxonomy and escalation owners',
    businessOutcome: 'measured improvement without material adverse impact',
    signOff: 'process owner + Risk/Finance/IT as applicable',
  },
  s2ToS3: {
    minAcceptanceOrAccuracy: 0.99,
    minCases: 500,
    controls: 'automated monitoring, recovery and kill switch tested',
    exceptions: 'exception rate stable and within risk appetite',
    businessOutcome: 'sustained SLA, cost, cash or quality benefit',
    signOff: 'executive owner + control owners + production readiness review',
  },
};
