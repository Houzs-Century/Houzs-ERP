/* B22: one Esc closes one layer. Before, every dialog listened on window, so
   an Esc on a confirm raised from inside an AP invoice popup also closed the
   popup (and lost what was typed), and the scm ModalOverlay frame ignored Esc. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { escapeLayerCount, pushEscapeLayer } from './escapeStack';
import { Modal } from '../vendor/scm/components/Modal';
import { ConfirmProvider, useConfirm } from '../vendor/scm/components/ConfirmDialog';
import { DialogProvider, useDialog } from '../hooks/useDialog';
import { ResizableDrawer } from '../components/ResizableDrawer';
import { ModalOverlay } from '../components/scm-v2/DocumentRelationshipMapModal';

const esc = () => fireEvent.keyDown(window, { key: 'Escape' });

afterEach(() => { cleanup(); expect(escapeLayerCount()).toBe(0); });

describe('escape stack', () => {
  test('only the newest layer hears Esc', () => {
    const a = vi.fn(); const b = vi.fn();
    const popA = pushEscapeLayer(a);
    const popB = pushEscapeLayer(b);
    esc();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    popB();
    esc();
    expect(a).toHaveBeenCalledTimes(1);
    popA();
  });

  test('an Esc a field already handled is left alone', () => {
    const a = vi.fn();
    const pop = pushEscapeLayer(a);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    ev.preventDefault();
    window.dispatchEvent(ev);
    expect(a).not.toHaveBeenCalled();
    pop();
  });
});

const PopupWithConfirm = () => {
  const confirm = useConfirm();
  const [open, setOpen] = useState(true);
  const [answer, setAnswer] = useState('unasked');
  return (
    <div>
      {open && (
        <Modal title="AP invoice" onClose={() => setOpen(false)}>
          <input aria-label="typed" defaultValue="keep me" />
          <button type="button" onClick={async () => setAnswer(String(await confirm({ title: 'Void it?' })))}>void</button>
        </Modal>
      )}
      <output>{answer}</output>
    </div>
  );
};

describe('Modal + in-app confirm', () => {
  test('Esc on the confirm cancels it and keeps the popup open', async () => {
    render(<ConfirmProvider><PopupWithConfirm /></ConfirmProvider>);
    fireEvent.click(screen.getByText('void'));
    expect(screen.getByText('Void it?')).toBeTruthy();
    await act(async () => { esc(); });
    expect(screen.queryByText('Void it?')).toBeNull();
    expect(screen.getByText('false')).toBeTruthy();
    expect(screen.getByLabelText('typed')).toBeTruthy();
    act(() => { esc(); });
    expect(screen.queryByLabelText('typed')).toBeNull();
  });
});

const DrawerWithDialog = () => {
  const { confirm } = useDialog();
  const [open, setOpen] = useState(true);
  return open ? (
    <ResizableDrawer title="Drawer" onClose={() => setOpen(false)} storageKey="b22-test">
      <span>drawer body</span>
      <button type="button" onClick={() => { void confirm({ title: 'Discard?' }); }}>ask</button>
    </ResizableDrawer>
  ) : null;
};

describe('ResizableDrawer + useDialog confirm', () => {
  test('Esc closes the confirm, a second Esc the drawer', async () => {
    render(<DialogProvider><DrawerWithDialog /></DialogProvider>);
    fireEvent.click(screen.getByText('ask'));
    expect(screen.getByText('Discard?')).toBeTruthy();
    await act(async () => { esc(); });
    expect(screen.queryByText('Discard?')).toBeNull();
    expect(screen.getByText('drawer body')).toBeTruthy();
    act(() => { esc(); });
    expect(screen.queryByText('drawer body')).toBeNull();
  });
});

describe('ModalOverlay frame', () => {
  test('Esc closes an open frame and a closed frame does not swallow Esc', () => {
    const onClose = vi.fn();
    const { rerender } = render(<ModalOverlay open onClose={onClose} title="Map">body</ModalOverlay>);
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<ModalOverlay open={false} onClose={onClose} title="Map">body</ModalOverlay>);
    expect(escapeLayerCount()).toBe(0);
  });
});
