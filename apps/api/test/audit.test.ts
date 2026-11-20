import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { audit } from '../src/audit';
import { resetDb } from './helpers';
import { makeUser } from './factory';

describe('audit', () => {
  beforeEach(resetDb);

  it('writes a row with a string entityId', async () => {
    const u = await makeUser();
    await audit(prisma, { entityType: 'user', entityId: 42, action: 'create', userId: u.id, after: { a: 1 } });
    const row = await prisma.auditLog.findFirstOrThrow();
    expect(row).toMatchObject({ entityType: 'user', entityId: '42', action: 'create', userId: u.id, after: { a: 1 } });
    expect(row.before).toBeNull();
  });

  it('strips passwordHash from before and after', async () => {
    await audit(prisma, {
      entityType: 'user', entityId: 1, action: 'update', userId: null,
      before: { email: 'a', passwordHash: 'x' }, after: { email: 'b', passwordHash: 'y', microsoftOid: 'oid' },
    });
    const row = await prisma.auditLog.findFirstOrThrow();
    expect(row.before).toEqual({ email: 'a' });
    expect(row.after).toEqual({ email: 'b', microsoftOid: 'oid' });
  });

  it('works inside a transaction', async () => {
    await prisma.$transaction((tx) => audit(tx, { entityType: 'x', entityId: 'k', action: 'delete', userId: null }));
    expect(await prisma.auditLog.count()).toBe(1);
  });
});
