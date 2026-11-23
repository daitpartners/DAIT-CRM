import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../src/components/Modal';

describe('Modal keyboard focus', () => {
  // jsdom lays nothing out (offsetParent is always null): treat every attached element as shown.
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return (this as HTMLElement).parentElement; } }));
  afterAll(() => own && Object.defineProperty(HTMLElement.prototype, 'offsetParent', own));

  it('Shift+Tab from the dialog itself (opened with nothing focused) stays inside, on the last control', async () => {
    const u = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Modal title="Compose email" onClose={() => undefined} focusDialog actions={<button type="button">Send</button>}>
          <input aria-label="Subject" />
        </Modal>
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Compose email' });
    expect(document.activeElement).toBe(dialog);
    await u.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' }));
  });

  it('Tab from the dialog itself goes to its first control; Tab and Shift+Tab wrap at the ends', async () => {
    const u = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Modal title="Compose email" onClose={() => undefined} focusDialog actions={<button type="button">Send</button>}>
          <input aria-label="Subject" />
        </Modal>
      </>,
    );
    await u.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Subject' }));
    await u.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' }));
    await u.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Subject' }));
  });
});
