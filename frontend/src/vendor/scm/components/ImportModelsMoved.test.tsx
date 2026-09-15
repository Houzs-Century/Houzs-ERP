/* Import SKUs tells the owner which model a category change moved, with how
 * many SKUs, and that orders already written keep the old category. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImportModelsMoved } from './ImportModelsMoved';

describe('ImportModelsMoved', () => {
  it('names the model, both categories by label, and the SKU count', () => {
    render(<ImportModelsMoved moves={[{ modelCode: 'BC04', modelName: 'BACK CUSHION 04', from: 'ACCESSORY', to: 'FABRIC_ACCESSORY', skuCount: 3 }]} />);
    expect(screen.getByRole('listitem').textContent.replace(/\s+/g, ' ')).toBe(
      'Model BC04 (BACK CUSHION 04) moved from Accessory to Sofa Accessory, with its 3 SKUs.',
    );
    expect(screen.getByText(/Orders already written keep the old category/)).toBeTruthy();
  });

  it('shows nothing when no model moved', () => {
    const { container } = render(<ImportModelsMoved moves={[]} />);
    expect(container.textContent).toBe('');
  });
});
