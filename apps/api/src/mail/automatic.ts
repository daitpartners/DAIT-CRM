/**
 * Bounces and automatic replies (owner, 28 Nov 2026): they stay in the Email screen but never get a lead timeline line
 * and never change a lead's stage (`logLeadMail`). Only received mail is ever treated as automatic: callers check the
 * side first, so a team member's sent email with such a subject is still logged. Log as activity still logs one by hand.
 */

/** Sender local parts (before @, lowercased) of mail systems that send no person's email. */
const AUTOMATIC_SENDERS = new Set(['postmaster', 'mailer-daemon', 'mail-daemon', 'noreply', 'no-reply', 'donotreply', 'do-not-reply']);

/** Subject prefixes (lowercased) of bounces and automatic replies; the colon is part of the prefix where it is shown. */
const AUTOMATIC_SUBJECTS = [
  'undeliverable:', 'no se puede entregar:', 'non remis:', 'unzustellbar:', 'delivery status notification',
  'mail delivery failed', 'delivery has failed', 'returned mail:', 'failure notice', 'automatic reply:',
  'respuesta automática:', 'réponse automatique:', 'out of office:', 'auto:', 'autoreply:', 'auto-reply:',
  'fuera de la oficina:', 'absence du bureau:',
];

/** True when the email is a bounce or an automatic reply, by its sender's local part or its subject's prefix. */
export function isAutomaticMail(m: { fromAddress: string; subject: string }): boolean {
  const address = m.fromAddress.trim().toLowerCase();
  const at = address.indexOf('@');
  if (AUTOMATIC_SENDERS.has(at === -1 ? address : address.slice(0, at))) return true;
  const subject = m.subject.trim().toLowerCase();
  return AUTOMATIC_SUBJECTS.some((prefix) => subject.startsWith(prefix));
}
