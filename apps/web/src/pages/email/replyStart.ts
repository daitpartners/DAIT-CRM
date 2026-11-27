import { replyRecipients, replySubject, type ReplyMode } from '@dait-crm/shared';
import type { ComposeStart } from './ComposeModal';

/** The parts of a message a reply, reply all or forward starts from. */
export type ReplyOriginalMessage = {
  id: number; status: string; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; subject: string;
  leadId: number | null; companyId: number | null;
};

/**
 * What Compose opens with for Reply, Reply all or Forward of `m` (web-mail release 2): To and Subject from the shared
 * replyRecipients / replySubject the server sends with, so the screen shows what is sent; Reply all pre-fills Cc with
 * the original Cc without your own address (`ownAddress`); Forward starts with an empty To. The lead and client stay.
 */
export function replyStart(m: ReplyOriginalMessage, mode: ReplyMode, ownAddress: string | null): ComposeStart {
  const own = ownAddress ? [ownAddress] : [];
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const { to } = replyRecipients(m, mode, own, []);
  return {
    replyTo: m.id,
    mode,
    to: to.join(', '),
    cc: mode === 'replyAll' ? m.ccAddresses.filter((a) => !mine.has(a.trim().toLowerCase())) : [],
    subject: replySubject(m.subject, mode),
    ...(m.leadId !== null ? { leadId: m.leadId } : {}),
    ...(m.companyId !== null ? { companyId: m.companyId } : {}),
  };
}
