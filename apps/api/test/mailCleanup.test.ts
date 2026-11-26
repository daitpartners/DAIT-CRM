import { beforeEach, describe, expect, test } from 'vitest';
import type { EmailAccount, Lead, Prisma, User } from '@prisma/client';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { CleanupRefusedError, cleanUpNonLeadMail, parseCleanupArgs } from '../src/mail/cleanup';
import { resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeProject, makeUser } from './factory';

let rep: User;
let account: EmailAccount;
let lead: Lead;

beforeEach(async () => {
  await resetDb();
  rep = await makeUser({ name: 'Maya Rep' });
  account = await prisma.emailAccount.create({
    data: {
      address: 'maya@daitpartners.com', provider: 'microsoft', kind: 'personal', userId: rep.id, refreshTokenEnc: encrypt('rt'),
      status: 'connected', messageCount: 99,
    },
  });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  lead = await makeLead({ companyId: acme.id, businessEmail: 'ana@acme.com' });
});

/** One stored message of `user` (default: the rep, in their mailbox, from a private address). */
function mail(data: Partial<Prisma.EmailMessageUncheckedCreateInput> = {}, user: User = rep) {
  return prisma.emailMessage.create({
    data: {
      userId: user.id, accountId: user.id === rep.id ? account.id : null, folder: 'inbox', status: 'received', source: 'sync',
      fromAddress: 'friend@gmail.com', toAddresses: [user.email], subject: 'Dinner on Friday', ...data,
    },
  });
}

const run = (dryRun = false, more: { acceptUnrecordedDeletes?: boolean } = {}) =>
  cleanUpNonLeadMail(prisma, { dryRun, log: () => {}, ...more });

const leadDeleteAudit = (before: Prisma.InputJsonValue | undefined) =>
  prisma.auditLog.create({
    data: { entityType: 'lead', entityId: '999', action: 'delete', userId: null, before, after: { number: 'L-0999', companyName: 'Old Co' } },
  });

describe('one-off mail clean-up (web-mail release 1)', () => {
  test('removes non-lead mail of every user, keeps lead mail, logs counts per user only', async () => {
    await mail({ leadId: lead.id, fromAddress: 'ana@acme.com', subject: 'Proposal' });
    await mail({ fromAddress: 'pat@acme.com', subject: 'Unlinked but lead mail' }); // lead company domain
    const personal = await mail();
    const other = await makeUser({ name: 'Carlos Other' });
    const otherPersonal = await mail({ subject: 'Dinner on Friday' }, other);

    const lines: string[] = [];
    const r = await cleanUpNonLeadMail(prisma, { dryRun: false, log: (l) => lines.push(l) });

    expect(r.users.find((u) => u.userId === rep.id)).toMatchObject({ checked: 3, kept: 2, removed: 1, name: 'Maya Rep' });
    expect(r.users.find((u) => u.userId === other.id)).toMatchObject({ checked: 1, kept: 0, removed: 1 });
    expect(r.removed).toBe(2);
    expect(await prisma.emailMessage.findUnique({ where: { id: personal.id } })).toBeNull();
    expect(await prisma.emailMessage.findUnique({ where: { id: otherPersonal.id } })).toBeNull();
    expect(await prisma.emailMessage.count()).toBe(2);
    expect(lines).toContain(`mail cleanup: user ${rep.id} (Maya Rep): checked 3, kept 2, removed 1`);
    expect(lines).toContain(`mail cleanup: user ${other.id} (Carlos Other): checked 1, kept 0, removed 1`);
    expect(lines.some((l) => /total: checked 4, kept 2, removed 2/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/Dinner on Friday|friend@gmail\.com|acme\.com|Proposal/);
  });

  test('keeps lead-linked, deleted-lead, queued/sending, campaign, quotation, project-tagged and lead-conversation mail', async () => {
    const project = await makeProject({ companyId: lead.companyId!, managerId: rep.id, leadId: lead.id });
    const campaign = await prisma.emailCampaign.create({
      data: {
        name: 'Nov', templateName: 'T', subject: 'S', body: 'B', senderId: rep.id, senderAddress: rep.email, intervalMinutes: 5,
        lawfulBasis: 'Legitimate interest', status: 'Completed',
      },
    });
    await mail({ leadId: lead.id, threadId: 'T-lead', fromAddress: 'ana@acme.com' });
    await mail({ leadDeletedAt: new Date() });
    await mail({ folder: 'sent', status: 'queued', source: 'crm', fromAddress: rep.email, toAddresses: ['friend@gmail.com'] });
    await mail({ folder: 'sent', status: 'sent', source: 'crm', campaignId: campaign.id, fromAddress: rep.email, toAddresses: ['x@gmail.com'] });
    const quoted = await mail({ folder: 'sent', status: 'sent', source: 'crm', fromAddress: rep.email, toAddresses: ['buyer@gmail.com'] });
    await prisma.quotation.create({
      data: {
        number: 'Q-2026-001', companyId: lead.companyId!, ownerId: rep.id, quotationDate: new Date('2026-11-24'), currency: 'INR',
        subject: 'Website', status: 'Sent', sendingMessageId: quoted.id,
      },
    });
    await mail({ projectId: project.id });
    await mail({ threadId: 'T-lead', fromAddress: 'assistant@gmail.com' }); // same conversation as lead mail
    await mail({ threadId: 'T-other' }); // removed
    await mail({ subject: 'Newsletter', fromAddress: 'news@shop.example' }); // removed

    const r = await run();

    expect(r.removed).toBe(2);
    expect(await prisma.emailMessage.count()).toBe(7);
  });

  test('also keeps an in-flight send and a Mailer recipient message', async () => {
    const campaign = await prisma.emailCampaign.create({
      data: {
        name: 'Nov', templateName: 'T', subject: 'S', body: 'B', senderId: rep.id, senderAddress: rep.email, intervalMinutes: 5,
        lawfulBasis: 'Legitimate interest', status: 'Completed',
      },
    });
    await mail({ folder: 'sent', status: 'sending', source: 'crm', fromAddress: rep.email, toAddresses: ['friend@gmail.com'] });
    const sent = await mail({ folder: 'sent', status: 'sent', source: 'crm', fromAddress: rep.email, toAddresses: ['someone@gmail.com'] });
    await prisma.emailCampaignRecipient.create({
      data: { campaignId: campaign.id, toAddress: 'someone@gmail.com', timezoneSource: 'company', status: 'Sent', position: 1, emailMessageId: sent.id },
    });
    await mail();

    const r = await run();

    expect(r.users[0]).toMatchObject({ checked: 3, kept: 2, removed: 1 });
  });

  test('keeps mail the CRM linked to a contact or a company without a lead (fix round 1)', async () => {
    const solo = await makeCompany({ name: 'Solo', website: 'https://solo.io' }); // no lead: lends no domain
    const contact = await makeContact({ companyId: solo.id, businessEmail: 'bo@solo.io' });
    const toContact = await mail({ contactId: contact.id, fromAddress: 'helper@gmail.com' });
    const toCompany = await mail({ companyId: solo.id, fromAddress: 'other@solo.io' });
    await mail();

    const r = await run();

    expect(r.users[0]).toMatchObject({ checked: 3, kept: 2, removed: 1 });
    expect(await prisma.emailMessage.findUnique({ where: { id: toContact.id } })).not.toBeNull();
    expect(await prisma.emailMessage.findUnique({ where: { id: toCompany.id } })).not.toBeNull();
  });

  test('mail of a lead deleted before this release is kept and marked, found through its delete audit entry (ruling F1)', async () => {
    await leadDeleteAudit({ emails: ['gone@oldco.com'] });
    await prisma.auditLog.create({ data: { entityType: 'company', entityId: '5', action: 'delete', after: { number: 'C-5', name: 'Old Co' } } });
    const gone = await mail({ fromAddress: 'gone@oldco.com', subject: 'Old thread' });
    const goneCc = await mail({ fromAddress: 'friend@gmail.com', ccAddresses: [' Gone@OldCo.com '] });
    const linkedToLead = await mail({ leadId: lead.id, fromAddress: 'gone@oldco.com' });
    await mail();

    const dry = await run(true);
    expect(dry).toMatchObject({ removed: 1, stamped: 2, unrecordedDeletes: 0 });
    expect(await prisma.emailMessage.count({ where: { leadDeletedAt: { not: null } } })).toBe(0);

    const r = await run();
    expect(r).toMatchObject({ removed: 1, stamped: 2 });
    for (const m of [gone, goneCc]) {
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).leadDeletedAt).not.toBeNull();
    }
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: linkedToLead.id } })).leadDeletedAt).toBeNull();

    expect((await run()).stamped).toBe(0); // already marked
  });

  test('refuses to remove anything while a lead delete audit entry has no recorded addresses, unless accepted (ruling F1)', async () => {
    await leadDeleteAudit(undefined);
    await leadDeleteAudit({ emails: [] }); // recorded: that lead had no address
    const personal = await mail();

    const dry = await run(true);
    expect(dry).toMatchObject({ dryRun: true, removed: 1, unrecordedDeletes: 1 });

    const lines: string[] = [];
    await expect(cleanUpNonLeadMail(prisma, { dryRun: false, log: (l) => lines.push(l) })).rejects.toBeInstanceOf(CleanupRefusedError);
    expect(await prisma.emailMessage.findUnique({ where: { id: personal.id } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { entityType: 'mail_cleanup' } })).toBe(0);

    const r = await run(false, { acceptUnrecordedDeletes: true });
    expect(r).toMatchObject({ removed: 1, unrecordedDeletes: 1 });
    expect(await prisma.emailMessage.findUnique({ where: { id: personal.id } })).toBeNull();
  });

  test('Import Undo lead-delete entries are skipped, not counted as unrecorded (final review I1)', async () => {
    await prisma.auditLog.create({
      data: {
        entityType: 'lead', entityId: '777', action: 'delete', userId: null,
        before: { id: 777, businessEmail: 'undone@imported.com' }, after: { undoneImport: 'IMPORT-2026-11-22' },
      },
    });
    const undoneMail = await mail({ fromAddress: 'undone@imported.com' });

    const r = await run();
    expect(r).toMatchObject({ unrecordedDeletes: 0, stamped: 0, removed: 1 });
    expect(await prisma.emailMessage.findUnique({ where: { id: undoneMail.id } })).toBeNull();
  });

  test("a lead delete made before release 1 finds its address in before.businessEmail or the lead's create entry (final review I1)", async () => {
    // Pre-release-1 delete entries: no before.emails; one carries the full lead row, one only has a create entry.
    await prisma.auditLog.create({
      data: { entityType: 'lead', entityId: '801', action: 'delete', userId: null, before: { id: 801, businessEmail: 'Row@Before.com' } },
    });
    await prisma.auditLog.create({
      data: { entityType: 'lead', entityId: '802', action: 'create', userId: null, after: { id: 802, businessEmail: ' Made@Created.com ' } },
    });
    await prisma.auditLog.create({
      data: { entityType: 'lead', entityId: '802', action: 'delete', userId: null, after: { number: 'L-0802', companyName: 'Created Co' } },
    });
    await leadDeleteAudit(undefined); // lead 999: no create entry, nothing to go on
    const fromBefore = await mail({ fromAddress: 'row@before.com' });
    const fromCreate = await mail({ toAddresses: [rep.email, 'made@created.com'] });
    const personal = await mail();

    const dry = await run(true);
    expect(dry).toMatchObject({ unrecordedDeletes: 1, stamped: 2, removed: 1 });
    await expect(run()).rejects.toBeInstanceOf(CleanupRefusedError);

    const r = await run(false, { acceptUnrecordedDeletes: true });
    expect(r).toMatchObject({ unrecordedDeletes: 1, stamped: 2, removed: 1 });
    for (const m of [fromBefore, fromCreate]) {
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).leadDeletedAt).not.toBeNull();
    }
    expect(await prisma.emailMessage.findUnique({ where: { id: personal.id } })).toBeNull();
  });

  test('lead mail of a current lead is kept but not marked, even when a deleted lead shared the address', async () => {
    await leadDeleteAudit({ emails: ['ana@acme.com'] });
    const current = await mail({ fromAddress: 'ana@acme.com' });
    const r = await run();
    expect(r).toMatchObject({ stamped: 0, removed: 0 });
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: current.id } })).leadDeletedAt).toBeNull();
  });

  test('a dry run counts but removes nothing and writes no audit row (Review Focus 5)', async () => {
    await mail({ leadId: lead.id });
    await mail();
    await mail({ fromAddress: 'news@shop.example' });
    const lines: string[] = [];

    const r = await cleanUpNonLeadMail(prisma, { dryRun: true, log: (l) => lines.push(l) });

    expect(r).toMatchObject({ dryRun: true, removed: 2 });
    expect(r.users[0]).toMatchObject({ checked: 3, kept: 1, removed: 2 });
    expect(await prisma.emailMessage.count()).toBe(3);
    expect(await prisma.auditLog.count()).toBe(0);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).messageCount).toBe(99);
    expect(lines.some((l) => /dry run/.test(l))).toBe(true);
  });

  test('running it again removes nothing more (Review Focus 5)', async () => {
    await mail({ leadId: lead.id });
    await mail();
    expect((await run()).removed).toBe(1);
    expect((await cleanUpNonLeadMail(prisma, { dryRun: false, log: () => {} })).removed).toBe(0);
    expect(await prisma.emailMessage.count()).toBe(1);
  });

  test('works through a mailbox larger than one batch', async () => {
    await prisma.emailMessage.createMany({
      data: Array.from({ length: 1201 }, (_, i) => ({
        userId: rep.id, accountId: account.id, folder: 'inbox', status: 'received', source: 'sync',
        fromAddress: i % 3 === 0 ? 'ana@acme.com' : 'friend@gmail.com', subject: `m${i}`,
      })),
    });
    const r = await run();
    expect(r.users[0]).toMatchObject({ checked: 1201, kept: 401, removed: 800 });
    expect(await prisma.emailMessage.count()).toBe(401);
  });

  test("updates each mailbox's message count and writes one audit row with counts and no content", async () => {
    await mail({ leadId: lead.id });
    await mail({ subject: 'Private' });
    const r = await run();
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).messageCount).toBe(1);
    expect(r.removed).toBe(1);
    const entries = await prisma.auditLog.findMany({ where: { entityType: 'mail_cleanup' } });
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({ entityId: 'release-1', action: 'delete', userId: null });
    expect(entry.after).toMatchObject({ users: [{ userId: rep.id, removed: 1 }], removed: 1 });
    expect(JSON.stringify(entry.after)).not.toMatch(/subject|@/);
  });
});

describe('mail-cleanup CLI arguments (final review I2)', () => {
  test('no flag or --dry-run is a dry run; only --apply deletes', () => {
    expect(parseCleanupArgs([])).toEqual({ dryRun: true, acceptUnrecordedDeletes: false });
    expect(parseCleanupArgs(['--dry-run'])).toEqual({ dryRun: true, acceptUnrecordedDeletes: false });
    expect(parseCleanupArgs(['--apply'])).toEqual({ dryRun: false, acceptUnrecordedDeletes: false });
    expect(parseCleanupArgs(['--apply', '--accept-unrecorded-deletes'])).toEqual({ dryRun: false, acceptUnrecordedDeletes: true });
  });

  test('an unknown argument or --apply with --dry-run is an error', () => {
    for (const args of [['--dryrun'], ['--dry_run'], ['-n'], ['--dry-run=1'], ['--apply', '--force'], ['--apply', '--dry-run']]) {
      expect(parseCleanupArgs(args)).toHaveProperty('error');
    }
  });
});
