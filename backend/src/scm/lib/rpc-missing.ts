
/**
 * True when a PostgREST error means the RPC does not exist yet. Anything else is
 * a real failure and must NOT silently fall back.
 */
export function isMissingRpc(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'PGRST202' || err.code === '42883') return true;
  return /could not find the function|schema cache|undefined function|does not exist/i.test(err.message ?? '');
}

/**
 * True when a THROWN error is the atomic-transaction client's signal that the
 * RPC is outside its proxy whitelist — pgTransactionSupabase.rpc() throws
 * `Unsupported SCM transaction RPC: <name>` for anything but its advisory-lock
 * / rebuild helpers (pg-supabase-transaction.ts). A caller that pre-flights an
 * RPC inside runScmPgCommand (e.g. assertAuditWritable during a PO-amendment
 * approve) hits this — it means "not callable in THIS client", NOT "the
 * operation failed", so it degrades exactly like a missing RPC. Kept beside
 * isMissingRpc for the same single-source-of-truth reason: the two "the RPC
 * isn't available, fall back" signals must never drift.
 */
export function isUnsupportedTransactionRpc(message: string | null | undefined): boolean {
  return /unsupported scm transaction rpc/i.test(message ?? '');
}
