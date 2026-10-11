import type { PaymentDraft } from "../vendor/scm/components/PaymentsTable";
import {
  listScmHandoffInstances,
  removeScmHandoff,
  writeScmHandoff,
  type ScmHandoffKey,
} from "./scmHandoffStorage";
import { getBrowserStorageIdentity } from "./storageIdentity";

export type PaymentRetryKind = "so" | "si";
export type PaymentRetryHandoff = {
  documentId: string;
  drafts: PaymentDraft[];
};
const PAYMENT_RETRY_STATE_TTL_MS = 23 * 60 * 60 * 1_000;

const KEY: Record<PaymentRetryKind, ScmHandoffKey> = {
  so: "soPaymentRetry",
  si: "siPaymentRetry",
};
const instancePrefix = (documentId: string) => `${documentId}\n`;
const instanceId = (documentId: string, idempotencyKey: string) =>
  `${instancePrefix(documentId)}${idempotencyKey}`;

function sanitizeDraft(value: unknown): PaymentDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<PaymentDraft>;
  if (
    typeof draft.uid !== "string" || !draft.uid ||
    typeof draft.idempotencyKey !== "string" || !draft.idempotencyKey ||
    typeof draft.amountCenti !== "number" || !Number.isFinite(draft.amountCenti) || draft.amountCenti <= 0
  ) return null;
  const text = (input: unknown) => typeof input === "string" ? input : "";
  const method = draft.methodLabel;
  if (!(["Cash", "Merchant", "Online", "Installment"] as const).includes(method as never)) return null;
  return {
    uid: draft.uid,
    idempotencyKey: draft.idempotencyKey,
    paidAt: text(draft.paidAt),
    methodLabel: method!,
    merchantProvider: text(draft.merchantProvider),
    installmentMonthsLabel: text(draft.installmentMonthsLabel),
    onlineType: text(draft.onlineType),
    amountCenti: draft.amountCenti,
    accountSheet: text(draft.accountSheet),
    approvalCode: text(draft.approvalCode),
    collectedBy: text(draft.collectedBy),
    slipUploadSessionId: typeof draft.slipUploadSessionId === "string" ? draft.slipUploadSessionId : null,
    ...(typeof draft.receiptImageKey === "string" ? { receiptImageKey: draft.receiptImageKey } : {}),
  };
}

function sanitizePayload(value: unknown): PaymentRetryHandoff | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<PaymentRetryHandoff>;
  if (typeof payload.documentId !== "string" || !payload.documentId || !Array.isArray(payload.drafts)) return null;
  const drafts = payload.drafts.map(sanitizeDraft).filter((draft): draft is PaymentDraft => draft !== null);
  if (drafts.length === 0 || drafts.length !== payload.drafts.length) return null;
  if (new Set(drafts.map((draft) => draft.idempotencyKey)).size !== drafts.length) return null;
  return { documentId: payload.documentId, drafts };
}

export function paymentRetryNavigationState(
  kind: PaymentRetryKind,
  documentId: string,
  drafts: readonly PaymentDraft[],
): { paymentRetry: { kind: PaymentRetryKind; documentId: string; drafts: PaymentDraft[]; user: number; company: number; createdAt: number } } | undefined {
  const safe = sanitizePayload({ documentId, drafts });
  const identity = getBrowserStorageIdentity();
  return safe && identity
    ? { paymentRetry: { kind, ...safe, user: identity.userId, company: identity.companyId, createdAt: Date.now() } }
    : undefined;
}

export function readPaymentRetryNavigationState(
  value: unknown,
  kind: PaymentRetryKind,
  documentId: string,
): PaymentDraft[] {
  if (!value || typeof value !== "object") return [];
  const retry = (value as { paymentRetry?: unknown }).paymentRetry;
  if (!retry || typeof retry !== "object" || (retry as { kind?: unknown }).kind !== kind) return [];
  const identity = getBrowserStorageIdentity();
  const envelope = retry as { user?: unknown; company?: unknown; createdAt?: unknown };
  const age = typeof envelope.createdAt === "number" ? Date.now() - envelope.createdAt : Number.POSITIVE_INFINITY;
  if (
    !identity || envelope.user !== identity.userId || envelope.company !== identity.companyId ||
    age < 0 || age > PAYMENT_RETRY_STATE_TTL_MS
  ) return [];
  const safe = sanitizePayload(retry);
  return safe?.documentId === documentId ? safe.drafts : [];
}

export function consumePaymentRetryNavigationState(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("paymentRetry" in value)) return value;
  const { paymentRetry: _consumed, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : null;
}

/** Plan an SI edit against the IDs that existed when editing began. Rows added
 * or removed by another tab after that point are never interpreted as this
 * user's delete/re-create intent. */
export function planPaymentDraftFlush(
  baselineIds: Iterable<string>,
  currentPersistedIds: Iterable<string>,
  drafts: readonly PaymentDraft[],
): { deleteIds: string[]; draftsToPost: PaymentDraft[] } {
  const baseline = new Set(baselineIds);
  const persisted = new Set(currentPersistedIds);
  const draftIds = new Set(drafts.map((draft) => draft.uid));
  return {
    deleteIds: [...persisted].filter((id) => baseline.has(id) && !draftIds.has(id)),
    draftsToPost: drafts.filter((draft) => !baseline.has(draft.uid) && !persisted.has(draft.uid)),
  };
}

/** Temporary, identity-scoped retry UI only. The server payment ledger remains
 * the source of truth; original idempotency keys make replays safe. */
export function writePaymentRetryHandoff(
  kind: PaymentRetryKind,
  documentId: string,
  drafts: readonly PaymentDraft[],
): boolean {
  const safe = sanitizePayload({ documentId, drafts });
  if (!safe) return false;
  const written: string[] = [];
  for (const draft of safe.drafts) {
    const instance = instanceId(documentId, draft.idempotencyKey!);
    if (!writeScmHandoff(KEY[kind], { documentId, drafts: [draft] }, instance)) {
      for (const prior of written) removeScmHandoff(KEY[kind], prior);
      return false;
    }
    written.push(instance);
  }
  return true;
}

export function readPaymentRetryHandoff(
  kind: PaymentRetryKind,
  documentId: string,
): PaymentRetryHandoff | null {
  const drafts: PaymentDraft[] = [];
  for (const entry of listScmHandoffInstances<unknown>(KEY[kind], instancePrefix(documentId))) {
    const safe = sanitizePayload(entry.payload);
    if (!safe || safe.documentId !== documentId || safe.drafts.length !== 1) {
      removeScmHandoff(KEY[kind], entry.instanceId);
      continue;
    }
    drafts.push(safe.drafts[0]);
  }
  return drafts.length > 0 ? { documentId, drafts } : null;
}

export function completePaymentRetryDraft(
  kind: PaymentRetryKind,
  documentId: string,
  idempotencyKey: string,
): PaymentDraft[] {
  removeScmHandoff(KEY[kind], instanceId(documentId, idempotencyKey));
  return readPaymentRetryHandoff(kind, documentId)?.drafts ?? [];
}

export function clearPaymentRetryHandoff(kind: PaymentRetryKind, documentId: string): void {
  for (const entry of listScmHandoffInstances<unknown>(KEY[kind], instancePrefix(documentId))) {
    removeScmHandoff(KEY[kind], entry.instanceId);
  }
}
