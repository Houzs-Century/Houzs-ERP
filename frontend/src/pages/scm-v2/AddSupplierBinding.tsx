import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/Button';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { useSuppliers, useCreateBinding } from '../../vendor/scm/lib/suppliers-queries';

/* B2 — add a supplier binding for this SKU without leaving the product drawer.
   Reuses the same create-binding mutation the Supplier side uses (POST
   /suppliers/:id/bindings, company-scoped, server-validated). Editing an EXISTING
   binding still happens on the Supplier side (owner ruling); this only ADDS one.
   On success the drawer's supplier list + cost anchor refresh. Own file so
   Products.tsx stays under its size ceiling. */
export const AddSupplierBinding = ({ productCode, productName }: { productCode: string; productName: string }) => {
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const create = useCreateBinding();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [supplierSku, setSupplierSku] = useState('');
  const [priceSen, setPriceSen] = useState<number | null>(null);
  const [isMain, setIsMain] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSupplierId(''); setSupplierSku(''); setPriceSen(null); setIsMain(false); setError(null);
  };
  const submit = () => {
    setError(null);
    if (!supplierId) { setError('Pick a supplier.'); return; }
    create.mutate(
      {
        supplierId,
        materialKind: 'mfg_product',
        itemCode: productCode,
        materialName: productName,
        supplierSku: supplierSku.trim() || productCode,
        unitPriceSen: priceSen ?? undefined,
        isMainSupplier: isMain,
      },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ['mfg-product-suppliers'] });
          reset();
          setOpen(false);
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not add the binding.'),
      },
    );
  };

  const cta: React.CSSProperties = {
    fontSize: 'var(--fs-12)', fontWeight: 600, color: 'var(--c-burnt, #0c3f39)',
    background: 'transparent', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-sm)',
    padding: '5px 11px', cursor: 'pointer',
  };
  const inputBox: React.CSSProperties = {
    background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-sm)',
    padding: '4px 8px', fontSize: 'var(--fs-13)', outline: 'none',
  };
  const fieldLabel: React.CSSProperties = {
    fontSize: 'var(--fs-11)', fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.04em', color: '#767b6e', marginBottom: 4, display: 'block',
  };

  if (!open) {
    return (
      <div style={{ marginTop: 'var(--space-2)' }}>
        <button type="button" style={cta} onClick={() => setOpen(true)}>+ Add supplier binding</button>
      </div>
    );
  }

  const list = suppliers.data ?? [];
  return (
    <div style={{ marginTop: 'var(--space-2)', padding: 'var(--space-3)', background: '#fff', border: '1px solid #c2c6bd', borderRadius: 'var(--radius-sm)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 200 }}>
          <label style={fieldLabel}>Supplier</label>
          <select
            aria-label="Supplier"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            style={{ ...inputBox, minWidth: 200 }}
          >
            <option value="">{suppliers.isLoading ? 'Loading…' : 'Select supplier…'}</option>
            {list.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>Supplier SKU</label>
          <input
            type="text"
            value={supplierSku}
            onChange={(e) => setSupplierSku(e.target.value)}
            placeholder={productCode}
            style={{ ...inputBox, width: 160, fontFamily: 'var(--font-mono)' }}
          />
        </div>
        <div>
          <label style={fieldLabel}>Unit price</label>
          <MoneyInput
            bare
            valueSen={priceSen}
            onCommit={setPriceSen}
            allowBlank
            selectOnFocus
            placeholder="0.00"
            style={{ ...inputBox, width: 110, textAlign: 'right' }}
          />
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: '#3a3f36', paddingBottom: 6 }}>
          <input type="checkbox" checked={isMain} onChange={(e) => setIsMain(e.target.checked)} />
          Main supplier
        </label>
        <div style={{ display: 'flex', gap: 6, paddingBottom: 2 }}>
          <Button variant="primary" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
          <button type="button" style={cta} onClick={() => { reset(); setOpen(false); }}>Cancel</button>
        </div>
      </div>
      {error && <p role="alert" style={{ margin: 'var(--space-2) 0 0', color: '#b3261e', fontSize: 'var(--fs-12)' }}>{error}</p>}
    </div>
  );
};
