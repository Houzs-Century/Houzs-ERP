import { CalendarClock, Pencil, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* The DP Orders row's own buttons. A click on one must not also reach the row:
   the row click opens the job panel, and the panel then stacked over the Edit
   drawer and hid half of it. */
export const DpRowActions = ({
  status,
  cancelling,
  onEdit,
  onSchedule,
  onCancel,
}: {
  status: string;
  cancelling: boolean;
  onEdit: () => void;
  onSchedule: () => void;
  onCancel: () => void;
}) => (
  <div
    style={{ display: 'inline-flex', gap: 4 }}
    onClick={(e) => e.stopPropagation()}
    onDoubleClick={(e) => e.stopPropagation()}
  >
    {/* A scheduled job's address can still be corrected; only its date is fixed. */}
    {status !== 'CANCELLED' && (
      <Button variant="ghost" onClick={onEdit}>
        <Pencil {...ICON} /><span>Edit…</span>
      </Button>
    )}
    {status === 'PENDING_SCHEDULE' && (
      <Button variant="ghost" onClick={onSchedule}>
        <CalendarClock {...ICON} /><span>Schedule…</span>
      </Button>
    )}
    {status !== 'CANCELLED' && (
      <Button variant="ghost" onClick={onCancel} disabled={cancelling}>
        <XCircle {...ICON} /><span>Cancel</span>
      </Button>
    )}
  </div>
);
