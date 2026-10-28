import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { costMarker } from './costMarker';

/* The SKU Master cost-column marker maps the derived-cost anchor state to a chip:
   teal dot (ok) / amber dot (conflict) / red "Gap" chip (empty) / nothing else. */
describe('costMarker', () => {
  it('empty -> a red "Gap" chip', () => {
    const { container } = render(<>{costMarker('empty')}</>);
    expect(container.textContent).toContain('Gap');
  });

  it('conflict -> a dot titled "took the highest", no Gap text', () => {
    const { container } = render(<>{costMarker('conflict')}</>);
    expect(container.textContent).not.toContain('Gap');
    expect(container.querySelector('[title*="took the highest"]')).toBeTruthy();
  });

  it('ok -> a "derived from supplier" dot', () => {
    const { container } = render(<>{costMarker('ok')}</>);
    expect(container.querySelector('[title*="derived from supplier"]')).toBeTruthy();
  });

  it('service or undefined -> no marker', () => {
    const svc = render(<>{costMarker('service')}</>);
    expect(svc.container.textContent).toBe('');
    const none = render(<>{costMarker(undefined)}</>);
    expect(none.container.textContent).toBe('');
  });
});
