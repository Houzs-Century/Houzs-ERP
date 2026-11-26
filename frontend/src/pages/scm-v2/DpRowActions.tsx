import { CalendarClock, Pencil, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

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
