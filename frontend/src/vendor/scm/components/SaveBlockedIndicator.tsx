// ----------------------------------------------------------------------------
// SaveBlockedIndicator — the persistent "Can't save — N to fix · tap to see"
// affordance that sits by the Save button on every SO form (desktop AND mobile).
//
// Owner 2026-09-16: a blocked Save must never look dead. Before this, the reasons
// a save was refused only appeared AFTER pressing Save (a popup). This shows the
// live count the moment the form is incomplete, updates as fields are fixed
// (the count comes from the backend validate endpoint via useSoValidate, so it
// clears itself), and opens the SAME SaveProblemsList popup on tap. It renders
// NOTHING when there is nothing to fix, so a complete order shows no alarm.
//
// Presentation only: it takes the backend's problems[] and an onOpen callback.
// It holds no rules and decides no wording — every word is the server's.
// ----------------------------------------------------------------------------
import type { SaveProblem } from '../lib/authed-fetch';

export function SaveBlockedIndicator({
  problems,
  onOpen,
}: {
  problems: readonly SaveProblem[];
  onOpen: () => void;
}) {
  const n = problems.length;
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Can't save — ${n} thing${n === 1 ? '' : 's'} to fix. Tap to see the list.`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        padding: '6px 12px',
        borderRadius: 999,
        border: '1px solid var(--red, #c0392b)',
        background: 'var(--red-bg, rgba(192, 57, 43, 0.1))',
        color: 'var(--red, #c0392b)',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1.2,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {`Can't save — ${n} to fix · tap to see`}
    </button>
  );
}
