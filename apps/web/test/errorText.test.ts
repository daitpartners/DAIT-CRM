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

describe('errorText — web-mail release 3 (writing and sending)', () => {
  it('every refusal and failure a user can meet while writing or sending reads as its own sentence', () => {
    const expected: Record<string, string> = {
      draft_gone: 'This draft was removed in Outlook.',
      already_sent: 'Too late: the email was sent.',
      no_recipients: 'Add at least one recipient.',
      schedule_time: 'Choose a time at least a minute from now and within a year.',
      follow_up_time: 'Choose a follow-up time after the email is sent.',
      no_mailbox: 'Connect your Microsoft 365 mailbox in Settings to send email from the CRM.',
      attachment_type: 'This type of file cannot be attached here. Attach it in Outlook.',
      attachments_too_large: 'Files over 2.5 MB can be attached in Outlook.',
      signature_too_long: 'The signature is too long.',
      mailbox_changed: 'This draft is in a mailbox that is no longer connected. Open it in Outlook.',
      not_draft: 'This email is no longer a draft.',
      interrupted_may_have_sent: 'Sending was interrupted and the email may have left. Check Sent Items before sending it again.',
      mailbox_needs_reconnect: 'Your mailbox needs reconnecting in Settings → Email & calendar connections, then send again.',
    };
    for (const [code, text] of Object.entries(expected)) expect(errorText(t, code), code).toBe(text);
  });
});
