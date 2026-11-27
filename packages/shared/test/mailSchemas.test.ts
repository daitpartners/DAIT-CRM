import { expect, test } from 'vitest';
import { BULK_MAX, MAIL_SORTS, MAIL_VIEWS, MailBulk, MailChange, MailFollowUp, MailListQuery, MailReply } from '../src/index.js';

test('MailChange accepts the four kinds and refuses an unknown folder', () => {
  expect(MailChange.parse({ type: 'move', folder: 'deleted' })).toEqual({ type: 'move', folder: 'deleted' });
  expect(MailChange.parse({ type: 'delete' })).toEqual({ type: 'delete' });
  expect(MailChange.parse({ type: 'read', isRead: false })).toEqual({ type: 'read', isRead: false });
  expect(MailChange.parse({ type: 'flag', flag: 'nextWeek' })).toEqual({ type: 'flag', flag: 'nextWeek' });
  expect(MailChange.parse({ type: 'flag', flag: 'complete' })).toEqual({ type: 'flag', flag: 'complete' });
  expect(MailChange.safeParse({ type: 'move', folder: 'junk' }).success).toBe(false);
  expect(MailChange.safeParse({ type: 'flag', flag: 'someday' }).success).toBe(false);
  expect(MailChange.safeParse({ type: 'archive' }).success).toBe(false);
});
test('MailBulk takes 1 to 50 ids', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const change = { type: 'delete' };
  expect(BULK_MAX).toBe(50);
  expect(MailBulk.safeParse({ ids: [], change }).success).toBe(false);
  expect(MailBulk.safeParse({ ids: ids(51), change }).success).toBe(false);
  expect(MailBulk.parse({ ids: ids(50), change }).ids).toHaveLength(50);
  expect(MailBulk.safeParse({ ids: [0], change }).success).toBe(false);
});
test('MailReply: forward needs a To; reply defaults its mode', () => {
  const forward = MailReply.safeParse({ mode: 'forward', body: 'x' });
  expect(forward.success).toBe(false);
  expect(forward.error?.issues.map((i) => i.path)).toEqual([['to']]);
  expect(MailReply.parse({ mode: 'forward', to: ['A@Example.com'], body: 'x' }).to).toEqual(['a@example.com']);
  const reply = MailReply.parse({ body: 'x' });
  expect(reply.mode).toBe('reply');
  expect(reply.to).toEqual([]);
  expect(MailReply.parse({ mode: 'replyAll', body: 'x' }).mode).toBe('replyAll');
  expect(MailReply.safeParse({ body: '' }).success).toBe(false);
});
test('MailFollowUp: date + 24-hour time, or clear', () => {
  expect(MailFollowUp.safeParse({ date: '2026-11-30', time: '24:00' }).success).toBe(false);
  expect(MailFollowUp.safeParse({ date: '2026-11-30', time: '9:00' }).success).toBe(false);
  expect(MailFollowUp.safeParse({ date: '2026-02-30', time: '09:00' }).success).toBe(false);
  expect(MailFollowUp.parse({ date: '2026-11-30', time: '09:00' })).toEqual({ date: '2026-11-30', time: '09:00' });
  expect(MailFollowUp.parse({ date: '2026-11-30', time: '23:59' })).toEqual({ date: '2026-11-30', time: '23:59' });
  expect(MailFollowUp.parse({ clear: true })).toEqual({ clear: true });
  expect(MailFollowUp.safeParse({ clear: false }).success).toBe(false);
});
test('MailListQuery takes the release 2 filters and refuses bad values', () => {
  const q = MailListQuery.parse({
    chip: 'unread', conv: '0', sort: 'size', dir: 'asc', from: 'maria', to: 'x', subject: 'quote', leadQ: 'acme',
    owner: '12', date: 'custom', since: '2026-11-01', until: '2026-11-26', attachments: '1',
  });
  expect(q).toMatchObject({ chip: 'unread', conv: '0', sort: 'size', dir: 'asc', owner: '12', date: 'custom', since: '2026-11-01', attachments: '1' });
  expect(MailListQuery.parse({ owner: 'me' }).owner).toBe('me');
  expect(MailListQuery.parse({ view: 'unlinked' }).view).toBe('unlinked');
  for (const bad of [{ chip: 'starred' }, { sort: 'subject' }, { dir: 'up' }, { owner: 'all' }, { date: '90d' },
    { since: '2026-13-01' }, { attachments: '0' }, { leadQ: 'x'.repeat(201) }, { conv: 'yes' }]) {
    expect(MailListQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  }
});
test('the shared views and sorts lists', () => {
  expect(MAIL_VIEWS).toEqual(['inbox', 'sent', 'drafts', 'scheduled', 'flagged', 'archive', 'deleted', 'awaiting', 'due', 'mine']);
  expect(MAIL_SORTS).toEqual(['date', 'from', 'lead', 'stage', 'size']);
});
