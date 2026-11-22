import { describe, expect, it } from 'vitest';
import { errorText } from '../src/i18n/labels';

const t = (phrase: string) => phrase;

describe('errorText', () => {
  it('no_mailbox tells the user to connect their mailbox (release 2B-1)', () => {
    expect(errorText(t, 'no_mailbox')).toBe('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.');
  });
});

describe('errorText — release 3B Projects', () => {
  it('not_accepted, invalid_project and quotation_linked read as sentences, not "check the highlighted fields"', () => {
    expect(errorText(t, 'not_accepted')).toBe('Only an accepted quotation can become a project.');
    expect(errorText(t, 'invalid_project')).toBe("That project can't be used for this email.");
    expect(errorText(t, 'quotation_linked')).toBe('That quotation is already linked to another project.');
  });
});
