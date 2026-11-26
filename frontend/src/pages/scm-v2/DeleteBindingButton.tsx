import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useDeleteBinding } from '../../vendor/scm/lib/suppliers-queries';

export const DeleteBindingButton = ({
  supplierId, bindingId, supplierName,
}: {
  supplierId: string;
  bindingId: string;
  supplierName: string;
}) => {
  const qc = useQueryClient();
  const del = useDeleteBinding();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setError(null);
    del.mutate(
      { supplierId, bindingId },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ['mfg-product-suppliers'] });
          setConfirming(false);
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not remove the binding.'),
      },
    );
  };

  const iconBtn: React.CSSProperties = {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--hz-c-ink-muted)', padding: 4, lineHeight: 0, borderRadius: 'var(--radius-sm)',
  };
  const dangerBtn: React.CSSProperties = {
    fontSize: 'var(--fs-11)', fontWeight: 700, color: '#fff', background: '#b3261e',
    border: 'none', borderRadius: 'var(--radius-sm)', padding: '3px 8px', cursor: 'pointer',
  };
  const ghostBtn: React.CSSProperties = {
    fontSize: 'var(--fs-11)', fontWeight: 600, color: 'var(--c-burnt, var(--hz-c-primary-ink))',
    background: 'transparent', border: '1px solid var(--hz-c-border-strong)', borderRadius: 'var(--radius-sm)',
    padding: '3px 8px', cursor: 'pointer',
  };

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={`Remove ${supplierName}`}
        title="Remove this supplier binding"
        onClick={() => setConfirming(true)}
        style={iconBtn}
      >
        <Trash2 size={14} strokeWidth={1.75} />
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
      <button type="button" onClick={remove} disabled={del.isPending} style={dangerBtn}>
        {del.isPending ? 'Removing…' : 'Remove'}
      </button>
      <button type="button" onClick={() => { setConfirming(false); setError(null); }} style={ghostBtn}>
        Cancel
      </button>
      {error && (
        <span role="alert" style={{ color: '#b3261e', fontSize: 'var(--fs-11)' }}>{error}</span>
      )}
    </span>
  );
};
