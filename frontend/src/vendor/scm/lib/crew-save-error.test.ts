import { describe, expect, it, vi } from 'vitest';
import { crewSaveFailed } from './crew-save-error';

describe('crewSaveFailed', () => {
  it('reverts the picker and shows the server reason', () => {
    const notify = vi.fn();
    const revert = vi.fn();
    crewSaveFailed(notify, revert, new Error("That record isn't available in the company you're working in."));
    expect(revert).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({ title: 'Crew not saved', body: "That record isn't available in the company you're working in.", tone: 'error' });
  });

  it('still says something when the error carries no message', () => {
    const notify = vi.fn();
    crewSaveFailed(notify, undefined, 'boom');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: 'Something went wrong.', tone: 'error' }));
  });
});
