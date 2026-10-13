// A JS mirror of the two functions in backend/src/scm/shared/phone.ts that the
// stored-phone backfill needs. THAT FILE IS THE SOURCE OF TRUTH — this is a
// copy only because a .mjs script cannot import TypeScript, and compiling the
// whole backend to run one backfill is worse than a copy that is pinned.
//
// The pin is backend/tests/phoneNormaliseMirror.test.ts: it imports the TS
// module AND this file and asserts they agree on a corpus. If somebody changes
// the rule in one place, that test fails rather than the backfill silently
// writing a different canonical form from the one the API writes.

/** Strip every character except digits. */
const onlyDigits = (s) => String(s).replace(/\D+/g, '');

/** Mirror of collapseDoubledMalaysianPrefix() in backend/src/scm/shared/phone.ts. */
export function collapseDoubledMalaysianPrefix(digits) {
  if (!digits.startsWith('60')) return digits;
  const national = digits.slice(2);
  const stripped = national.replace(/^(?:60|0)+/, '');
  const mobile = stripped.startsWith('1');
  const plausible = mobile ? stripped.length === 9 || stripped.length === 10 : stripped.length === 8 || stripped.length === 9;
  if (stripped === national || !plausible) return digits;
  return '60' + stripped;
}

/** Mirror of normalizePhone() in backend/src/scm/shared/phone.ts. */
export function normalizePhone(raw) {
  if (raw == null) return null;
  const hadPlus = String(raw).trim().startsWith('+');
  const digits = onlyDigits(String(raw));
  if (digits.length === 0) return null;

  let normalized;
  if (hadPlus) {
    normalized = digits;
  } else if (digits.startsWith('60')) {
    normalized = digits;
  } else if (digits.startsWith('0')) {
    normalized = '60' + digits.slice(1);
  } else if (digits.length >= 8) {
    normalized = '60' + digits;
  } else {
    return null;
  }

  normalized = collapseDoubledMalaysianPrefix(normalized);

  if (normalized.length < 7) return null;
  return '+' + normalized;
}

/** Mirror of canonicalizeSinglePhone() in backend/src/scm/shared/phone.ts. */
export function canonicalizeSinglePhone(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') return '';
  if (/[/,;&]|\bext\.?\b|\bx\d/i.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return trimmed;
  return normalizePhone(trimmed) ?? trimmed;
}
