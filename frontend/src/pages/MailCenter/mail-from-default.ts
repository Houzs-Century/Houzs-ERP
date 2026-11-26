
export type FromDefaultAddress = {
  address: string;
  assignedUserId?: string | number | null;
};

export type FromDefaultUser = {
  id?: string | number | null;
  email?: string | null;
};

function localPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at).toLowerCase() : "";
}

export function pickDefaultFromAddress(
  addresses: FromDefaultAddress[] | undefined,
  user: FromDefaultUser | null | undefined,
): string {
  const list = addresses ?? [];
  if (list.length === 0) return "";

  const userId = String(user?.id ?? "").trim();
  const userEmail = (user?.email ?? "").trim().toLowerCase();
  const userLocal = localPart(userEmail);

  if (userId) {
    const byAssignment = list.find(
      (a) => String(a.assignedUserId ?? "") === userId,
    );
    if (byAssignment?.address) return byAssignment.address;
  }

  if (!userEmail) return "";

  const byEmail = list.find(
    (a) => (a.address ?? "").toLowerCase() === userEmail,
  );
  if (byEmail?.address) return byEmail.address;

  if (userLocal) {
    const byLocal = list.find(
      (a) => localPart((a.address ?? "").toLowerCase()) === userLocal,
    );
    if (byLocal?.address) return byLocal.address;
  }

  return "";
}
