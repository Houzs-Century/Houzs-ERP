
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button';
import { classifyLoadFailure } from '../../lib/loadFailure';
import styles from './SalesOrderDetail.module.css';

export function DetailLoadFailure({
  noun,
  error,
  onRetry,
  retrying,
}: {
  noun: string;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const f = classifyLoadFailure(error);
  if (f.kind === 'not-found') {
    return (
      <div className={styles.bannerWarn} role="alert">
        <strong>{noun} not found.</strong>
        {f.reason ? ` ${f.reason}` : null}
      </div>
    );
  }
  return (
    <div className={styles.bannerWarn} role="alert">
      <strong>Could not load this {noun.toLowerCase()}.</strong>
      <span>{f.reason}</span>
      <span>This does not mean it was deleted. Check the connection and try again.</span>
      <div>
        <Button variant="secondary" onClick={onRetry} disabled={retrying} icon={<RefreshCw size={14} className={retrying ? 'animate-spin' : undefined} />}>
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    </div>
  );
}
