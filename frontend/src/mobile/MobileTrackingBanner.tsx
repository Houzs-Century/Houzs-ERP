
import {
  useMyActiveTrip,
  useTripLocationCapture,
  type CaptureStatus,
} from '../vendor/scm/lib/trip-locations-queries';

function dotColour(status: CaptureStatus): string {
  switch (status) {
    case 'tracking': return '#15803d';
    case 'requesting': return '#d97706';
    case 'denied':
    case 'unavailable':
    case 'error': return '#b91c1c';
    default: return '#9ca3af';
  }
}

function label(status: CaptureStatus): string {
  switch (status) {
    case 'tracking': return 'Location sharing on — the office can see your position';
    case 'requesting': return 'Allow location to share your position with the office';
    case 'denied': return 'Location is off. Enable location for this site to share your position.';
    case 'unavailable': return 'This device has no location support — position sharing is off.';
    case 'error': return 'Location signal lost — trying again.';
    default: return '';
  }
}

export function MobileTrackingBanner() {
  const { activeTrip } = useMyActiveTrip();
  const tripId = activeTrip?.id ?? null;
  const capture = useTripLocationCapture({ tripId, enabled: !!tripId });

  if (!tripId || capture.status === 'off') return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 11,
        padding: '9px 11px',
        background: capture.status === 'tracking' ? '#ecfdf3' : '#fff7ed',
        border: `1px solid ${capture.status === 'tracking' ? '#bbf7d0' : '#fed7aa'}`,
        borderRadius: 11,
      }}
    >
      <span
        aria-hidden
        style={{
          flex: 'none',
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: dotColour(capture.status),
          boxShadow: capture.status === 'tracking' ? '0 0 0 3px rgba(21,128,61,0.15)' : 'none',
        }}
      />
      <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#374151', lineHeight: 1.4 }}>
        {label(capture.status)}
        {activeTrip?.trip_no ? (
          <span style={{ color: 'var(--mut)' }}> · {activeTrip.trip_no}</span>
        ) : null}
      </div>
    </div>
  );
}
