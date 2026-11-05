// HC-0157 A: a member with no company address claims their own (once) in Mail
// Center, desktop and phone alike. The server re-checks everything; the
// pattern here only explains a bad entry before the round trip.
import { useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { queryClient } from "../../lib/queryClient";

export type MailClaimOffer = {
  domain: string;
  address: string | null;
  suggestion: string;
  department: { id: number; name: string } | null;
  departments: Array<{ id: number; name: string }>;
};

const CLAIM_KEY = "/api/mail-center/claim";
const LOCAL_PART_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function localPartProblem(local: string): string | null {
  const v = local.trim().toLowerCase();
  if (!v) return null;
  if (v.length < 2 || v.length > 40 || !LOCAL_PART_RE.test(v)) {
    return "Use 2 to 40 letters or digits, with single dots, dashes or underscores between them.";
  }
  return null;
}

/** The claim form's state and submit, shared by the desktop rail and the phone. */
export function useMailClaim() {
  const offer = useQuery<MailClaimOffer>(CLAIM_KEY, () => api.get(CLAIM_KEY), [], { staleTime: 60_000 });
  const [local, setLocal] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = offer.data ?? null;
  const value = local ?? data?.suggestion ?? "";
  const needsDepartment = data != null && data.department == null;
  const problem = localPartProblem(value);
  const ready = !!data && !busy && !!value.trim() && !problem && (!needsDepartment || departmentId != null);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(CLAIM_KEY, { localPart: value.trim().toLowerCase(), departmentId: needsDepartment ? departmentId : null });
      // My mailbox, "What may I see" and the From list all change.
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "uq" && String(q.queryKey[1]).startsWith("/api/mail-center"),
      });
    } catch (e) {
      setError((e instanceof Error ? e.message : "Could not claim that address").replace(/^\d+:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return {
    offer: data,
    value,
    setValue: (v: string) => setLocal(v),
    departmentId,
    setDepartmentId,
    needsDepartment,
    problem,
    error,
    busy,
    ready,
    submit,
  };
}
