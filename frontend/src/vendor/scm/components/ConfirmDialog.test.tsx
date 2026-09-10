/* The in-app confirm, now with an optional line of text (owner 2026-09-10: a
   payment correction made on the amend right owes a reason). Pinned: the old
   yes/no contract is unchanged; a prompt shows its input; a REQUIRED input
   cannot be confirmed blank, so a non-null answer is never empty; Cancel and
   the backdrop answer null; and the text comes back trimmed. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useState } from 'react';
import { ConfirmProvider, useConfirm, usePrompt } from './ConfirmDialog';

const Asker = () => {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [answer, setAnswer] = useState<string>('unasked');
  return (
    <div>
      <button type="button" onClick={async () => setAnswer(String(await confirm({ title: 'Sure?' })))}>ask yes/no</button>
      <button type="button" onClick={async () => {
        const r = await prompt({ title: 'Why?', input: { label: 'Reason', placeholder: 'Say why', required: true }, confirmLabel: 'Save changes' });
        setAnswer(r === null ? 'null' : `text:${r}`);
      }}>ask reason</button>
      <output>{answer}</output>
    </div>
  );
};

const draw = () => render(<ConfirmProvider><Asker /></ConfirmProvider>);

describe('useConfirm, unchanged', () => {
  test('resolves true on Confirm and false on Cancel, with no input shown', async () => {
    draw();
    fireEvent.click(screen.getByText('ask yes/no'));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('true'));

    fireEvent.click(screen.getByText('ask yes/no'));
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('false'));
  });
});

describe('usePrompt', () => {
  test('shows the input and will not confirm a required reason left blank', async () => {
    draw();
    fireEvent.click(screen.getByText('ask reason'));
    const box = screen.getByPlaceholderText('Say why');
    expect(box).toBeTruthy();
    const save = screen.getByText('Save changes') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  keyed twice  ' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('text:keyed twice'));
  });

  test('answers null on Cancel, and on the backdrop', async () => {
    draw();
    fireEvent.click(screen.getByText('ask reason'));
    fireEvent.change(screen.getByPlaceholderText('Say why'), { target: { value: 'typed and then abandoned' } });
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('null'));

    fireEvent.click(screen.getByText('ask reason'));
    fireEvent.click(screen.getByRole('presentation'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('null'));
  });
});
