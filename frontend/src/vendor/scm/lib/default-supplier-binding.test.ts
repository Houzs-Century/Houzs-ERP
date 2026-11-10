import { describe, expect, it } from 'vitest';
import { defaultSupplierBinding } from './default-supplier-binding';

const bind = (id: string, main: boolean, status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED' = 'ACTIVE') => ({
  id: `b-${id}`,
  is_main_supplier: main,
  supplier: { id, status },
});

describe('defaultSupplierBinding — which supplier a new PO adopts for an item picked first', () => {
  it('adopts the only supplier that carries the item', () => {
    expect(defaultSupplierBinding([bind('s1', false)])?.supplier.id).toBe('s1');
  });

  it('adopts the main supplier when several carry the item', () => {
    expect(defaultSupplierBinding([bind('s1', false), bind('s2', true), bind('s3', false)])?.supplier.id).toBe('s2');
  });

  it('adopts nothing when several carry it and none is main', () => {
    expect(defaultSupplierBinding([bind('s1', false), bind('s2', false)])).toBeNull();
  });

  it('adopts nothing when more than one is marked main', () => {
    expect(defaultSupplierBinding([bind('s1', true), bind('s2', true)])).toBeNull();
  });

  it('never adopts a main supplier that is not active', () => {
    expect(defaultSupplierBinding([bind('s1', false), bind('s2', true, 'INACTIVE')])).toBeNull();
    expect(defaultSupplierBinding([bind('s1', true, 'BLOCKED'), bind('s2', true)])?.supplier.id).toBe('s2');
  });

  it('adopts nothing when no supplier carries the item', () => {
    expect(defaultSupplierBinding([])).toBeNull();
  });
});
