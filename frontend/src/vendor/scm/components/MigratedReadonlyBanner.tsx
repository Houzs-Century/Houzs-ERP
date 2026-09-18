/* ---------------------------------------------------------------------------
   "View only — carried over from AutoCount."

   Owner 2026-09-08: 「只开新单，旧单暂时不能改」. A disabled button with a
   tooltip is not a message — this repo's own record is that a refusal reaching
   nobody reads to the owner as "the button does nothing" (docs/bugs/, 35 write
   paths refusing correctly and telling no-one). So the reason is stated in the
   page, once, above everything, in the words the SERVER sent.

   ONE component for four screens. The desktop pages and the two mobile screens
   render the same sentence; only the skin differs, and the skin is a prop
   rather than a copy, so the wording cannot drift between surfaces the way
   gating logic has here before (#600 / #625 / #632).

   It renders NOTHING when the header is not locked, so a call site is one line
   with no conditional of its own to get wrong.
   --------------------------------------------------------------------------- */
import {
  migratedReadonly,
  migratedReadonlyReason,
  type SoDetailGateHeader,
} from '../lib/so-detail-gates';

const SHELL: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 9,
  background: 'rgba(232, 107, 58, 0.08)',
  border: '1px solid var(--c-orange, #e86b3a)',
  padding: '10px 12px', marginBottom: 12,
  fontSize: 12, lineHeight: 1.5, color: '#8a4a24',
};

export function MigratedReadonlyBanner({
  header,
  rounded = 10,
}: {
  header: SoDetailGateHeader | null | undefined;
  /** Desktop uses the page's 12px card radius, mobile its 12px card radius —
   *  same number today, kept a prop so a skin change needs no second copy. */
  rounded?: number;
}) {
  if (!migratedReadonly(header)) return null;
  return (
    <div data-testid="so-migrated-readonly-banner" role="status" style={{ ...SHELL, borderRadius: rounded }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c66a34" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
        <rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
      <div>
        <b>View only &mdash; carried over from AutoCount.</b> {migratedReadonlyReason(header)}
      </div>
    </div>
  );
}
