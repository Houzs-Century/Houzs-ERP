import { validatePasswordStrength } from "../lib/passwordStrength";

/**
 * Four-segment strength bar + first-failing-rule hint. Pairs with the
 * shared validator in lib/passwordStrength.ts (same rules enforced
 * server-side) so what the bar approves, the API accepts.
 *
 * Renders nothing until the user starts typing — an empty field showing
 * a red bar reads as an error before anyone has done anything wrong.
 */

const SEGMENT_FILL = ["#dc2626", "#d97706", "#2563eb", "#059669"]; // score 1-4
const SEGMENT_EMPTY = "#e7e2d8";
const SCORE_LABEL: Record<number, string> = {
  1: "Acceptable",
  2: "Good",
  3: "Strong",
  4: "Excellent",
};

export function PasswordStrengthMeter({
  password,
  email,
}: {
  password: string;
  email?: string;
}) {
  if (!password) return null;
  const res = validatePasswordStrength(password, email);
  const filled = res.ok ? res.score : 1;
  const fill = res.ok ? SEGMENT_FILL[res.score - 1] : SEGMENT_FILL[0];

  return (
    <div className="mt-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-full transition-colors"
            style={{ backgroundColor: i < filled ? fill : SEGMENT_EMPTY }}
          />
        ))}
      </div>
      {res.ok ? (
        <div className="mt-1 text-[10.5px] text-ink-muted">
          Strength: {SCORE_LABEL[res.score]}
        </div>
      ) : (
        <div className="mt-1 text-[10.5px] text-err">{res.error}</div>
      )}
    </div>
  );
}
