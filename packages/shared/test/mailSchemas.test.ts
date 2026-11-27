import { expect, test } from 'vitest';
import {
  BULK_MAX, MAIL_SORTS, MAIL_VIEWS, MailBulk, MailChange, MailFollowUp, MailListQuery,
  DraftAttachmentUpload, DraftCreate, DraftSave, DraftSend, DraftTemplateApply, RecipientQuery, RecipientResolve,
  SignatureUpdate, UNDO_SEND_SECONDS,
} from '../src/index.js';

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

test('DraftCreate: replies need replyToId, new refuses it', () => {
  expect(DraftCreate.safeParse({ kind: 'replyAll' }).success).toBe(false);
  expect(DraftCreate.safeParse({ kind: 'new', replyToId: 4 }).success).toBe(false);
  expect(DraftCreate.parse({}).kind).toBe('new');
  const r = DraftCreate.safeParse({ kind: 'forward' });
  expect(!r.success && r.error.issues[0]!.path).toEqual(['replyToId']);
  expect(DraftCreate.parse({ kind: 'reply', replyToId: 4 })).toEqual({ kind: 'reply', replyToId: 4 });
});
test('DraftSend: at defaults to null; follow-up needs a 24-hour time and a title; note at most 1000', () => {
  const base = { bodyHtml: '<p>x</p>' };
  expect(DraftSend.parse(base)).toMatchObject({ at: null, followUp: null, to: [], bcc: [] });
  const fu = { date: '2026-12-01', time: '09:00', title: 'Follow up: x', assignedToId: 1, kind: 'followup' };
  expect(DraftSend.parse({ ...base, followUp: fu }).followUp).toMatchObject({ priority: 'normal', updateLead: true });
  expect(DraftSend.safeParse({ ...base, followUp: { ...fu, time: '24:00' } }).success).toBe(false);
  expect(DraftSend.safeParse({ ...base, followUp: { ...fu, note: 'n'.repeat(1001) } }).success).toBe(false);
  expect(DraftSend.safeParse({ ...base, followUp: { ...fu, title: '  ' } }).success).toBe(false);
  expect(DraftSend.safeParse({ ...base, at: 'tomorrow' }).success).toBe(false);
  expect(DraftSend.parse({ ...base, at: '2026-12-01T08:00:00.000Z' }).at).toBe('2026-12-01T08:00:00.000Z');
});
test('DraftSave: up to 50 recipients a line, lower-cased; subject defaults to empty', () => {
  const v = DraftSave.parse({ to: [' Ana@Example.COM '], bodyHtml: '' });
  expect(v).toMatchObject({ to: ['ana@example.com'], cc: [], bcc: [], subject: '' });
  const many = Array.from({ length: 51 }, (_, i) => `a${i}@x.com`);
  expect(DraftSave.safeParse({ cc: many, bodyHtml: '' }).success).toBe(false);
  expect(DraftSave.safeParse({ to: ['not-an-address'], bodyHtml: '' }).success).toBe(false);
  expect(DraftSave.parse({ bodyHtml: '', leadId: null }).leadId).toBeNull();
});
test('draft attachments, template apply, signature and recipient queries', () => {
  expect(UNDO_SEND_SECONDS).toBe(10);
  expect(DraftAttachmentUpload.parse({ name: 'a.pdf', data: 'JVBERi0=' })).toEqual({ name: 'a.pdf', data: 'JVBERi0=', inline: false });
  expect(DraftTemplateApply.parse({ templateId: 3 })).toEqual({ templateId: 3, attachmentIds: [] });
  expect(DraftTemplateApply.safeParse({ templateId: 3, attachmentIds: Array.from({ length: 21 }, (_, i) => i + 1) }).success).toBe(false);
  expect(SignatureUpdate.parse({ html: null, auto: false })).toEqual({ html: null, auto: false });
  expect(SignatureUpdate.safeParse({ html: '<p>x</p>' }).success).toBe(false);
  expect(RecipientQuery.safeParse({ q: '  ' }).success).toBe(false);
  expect(RecipientQuery.parse({ q: ' ana ' }).q).toBe('ana');
  expect(RecipientResolve.safeParse({ addresses: Array.from({ length: 151 }, (_, i) => `a${i}@x.com`) }).success).toBe(false);
});
