/**
 * Lead mail timeline: which side of an email a stored row is, for "one copy per email". `received` is inbound; every
 * other status is outbound, split into a Sent Items copy (`sent`) and a copy in any other folder (`other`): an email to
 * yourself is from an own address, so its Inbox copy is stored as sent too, and it keeps both rows.
 * `storeMessage` (`sameEmail`) matches by this side and `mail-dedupe` groups by it, so the two never disagree.
 */
export type MailSide = 'received' | 'sent' | 'other';

/** The side of a stored row. */
export function mailSide(row: { status: string; folder: string }): MailSide {
  if (row.status === 'received') return 'received';
  return row.folder === 'sent' ? 'sent' : 'other';
}

/** The side of a synced message: `outbound` as `storeMessage` works it out, in `folder`. */
export function incomingSide(outbound: boolean, folder: string): MailSide {
  if (!outbound) return 'received';
  return folder === 'sent' ? 'sent' : 'other';
}

/** The Prisma filter for stored rows on `side`. */
export function sideWhere(side: MailSide) {
  if (side === 'received') return { status: 'received' };
  return { status: { not: 'received' }, folder: side === 'sent' ? 'sent' : { not: 'sent' } };
}
