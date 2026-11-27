import { expect, test } from 'vitest';
import { replyRecipients, replySubject } from '../src/index.js';

const own = ['maya@daitpartners.com', 'sales@daitpartners.com'];
const received = { status: 'received', fromAddress: 'ana@acme.com', toAddresses: ['Maya@DaitPartners.com', 'bo@acme.com', 'sales@daitpartners.com'] };
const sent = { status: 'sent', fromAddress: 'maya@daitpartners.com', toAddresses: ['ana@acme.com', 'bo@acme.com'] };

test('reply goes to the sender of a received message, or the recipients of your own', () => {
  expect(replyRecipients(received, 'reply', own, [])).toEqual({ to: ['ana@acme.com'] });
  expect(replyRecipients(sent, 'reply', own, [])).toEqual({ to: ['ana@acme.com', 'bo@acme.com'] });
});

test('reply all adds the original To, never your own addresses (send-as included), lower-cased and unique', () => {
  expect(replyRecipients(received, 'replyAll', own, [])).toEqual({ to: ['ana@acme.com', 'bo@acme.com'] });
  expect(replyRecipients({ ...received, fromAddress: 'Bo@Acme.com' }, 'replyAll', own, [])).toEqual({ to: ['bo@acme.com'] });
  expect(replyRecipients(sent, 'replyAll', own, [])).toEqual({ to: ['ana@acme.com', 'bo@acme.com'] });
});

test('reply all on mail only between your own addresses falls back to the reply recipients', () => {
  const toSelf = { status: 'sent', fromAddress: 'maya@daitpartners.com', toAddresses: ['maya@daitpartners.com'] };
  expect(replyRecipients(toSelf, 'replyAll', own, [])).toEqual({ to: ['maya@daitpartners.com'] });
});

test('forward goes to the addresses given', () => {
  expect(replyRecipients(received, 'forward', own, ['new@acme.com'])).toEqual({ to: ['new@acme.com'] });
});

test('replySubject: Re: or Fw: once (case-insensitive), at most 500 characters', () => {
  expect(replySubject('Proposal', 'reply')).toBe('Re: Proposal');
  expect(replySubject('Proposal', 'replyAll')).toBe('Re: Proposal');
  expect(replySubject('RE: Proposal', 'replyAll')).toBe('RE: Proposal');
  expect(replySubject('Proposal', 'forward')).toBe('Fw: Proposal');
  expect(replySubject('FW: Proposal', 'forward')).toBe('FW: Proposal');
  expect(replySubject('fwd: Proposal', 'forward')).toBe('fwd: Proposal');
  expect(replySubject('Re: Proposal', 'forward')).toBe('Fw: Re: Proposal');
  expect(replySubject('x'.repeat(500), 'reply')).toHaveLength(500);
  expect(replySubject('x'.repeat(500), 'forward').startsWith('Fw: x')).toBe(true);
});
