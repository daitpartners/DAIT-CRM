import { describe, expect, it } from 'vitest';
import { errorText } from '../src/i18n/labels';

const t = (phrase: string) => phrase;

describe('errorText', () => {
  it('no_mailbox tells the user to connect their mailbox (release 2B-1)', () => {
    expect(errorText(t, 'no_mailbox')).toBe('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.');
  });
});
