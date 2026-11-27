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
      signature_too_long: 'The signature is too long (20 000 characters at most).',
      mailbox_changed: 'This draft is in a mailbox that is no longer connected. Open it in Outlook.',
      not_draft: 'This email is no longer a draft.',
      interrupted_may_have_sent: 'Sending was interrupted and the email may have left. Check Sent Items before sending it again.',
      mailbox_needs_reconnect: 'Your mailbox needs reconnecting in Settings → Email & calendar connections, then send again.',
    };
    for (const [code, text] of Object.entries(expected)) expect(errorText(t, code), code).toBe(text);
  });
});

describe('errorText — file refusals by screen (web-mail release 3)', () => {
  it('the mail editor (draft context) points to Outlook and names the 20-file limit', () => {
    const draft = { context: 'draft' as const };
    expect(errorText(t, 'attachments_too_large', {}, draft)).toBe('Files over 2.5 MB can be attached in Outlook.');
    expect(errorText(t, 'attachment_type', {}, draft)).toBe('This type of file cannot be attached here. Attach it in Outlook.');
    expect(errorText(t, 'attachment_invalid', {}, draft)).toBe("This file can't be attached: a message can have up to 20 files, and the file must be readable.");
    // Other codes read the same in the editor.
    expect(errorText(t, 'draft_gone', {}, draft)).toBe('This draft was removed in Outlook.');
  });

  it('templates and the Mailer (no context) keep their upload texts', () => {
    expect(errorText(t, 'attachments_too_large')).toBe('The pictures and attachments are too large to send (2.5 MB at most together). Remove an attachment and try again.');
    expect(errorText(t, 'attachment_type')).toBe('One of the files is not a type the CRM can send (pictures, PDF, Word, Excel or PowerPoint).');
    expect(errorText(t, 'attachment_invalid')).toBe('One of the template’s files could not be read. Upload the .oft again.');
  });
});
