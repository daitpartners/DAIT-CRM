import { CALL_OUTCOMES, type CallOutcome } from '@dait-crm/shared';
import { callOutcomeText } from '../pages/leads/CallNoteForm';
import { leadStatusText } from './labels';
import type { TFn } from './useT';

type Rule = [RegExp, (t: TFn, m: string[]) => string];

const outcome = (t: TFn, v: string) => ((CALL_OUTCOMES as readonly string[]).includes(v) ? callOutcomeText(t, v as CallOutcome) : v);

/**
 * Texts the server writes in English and stores (notification texts, task titles, timeline titles, AI research
 * trigger / engine / result), matched by their known shapes so rows stored before and after this change both show in
 * the reader's language (review #04). Names, numbers and subjects inside them are kept as stored.
 */
const RULES: Rule[] = [
  // Notifications
  [/^Lead (\S+) assigned to you$/, (t, m) => t('Lead {number} assigned to you', { number: m[1]! })],
  [/^Lead transferred to you · (.+) from (.+)$/, (t, m) => t('Lead transferred to you · {company} from {name}', { company: m[1]!, name: m[2]! })],
  [/^AI research failed · (.+)$/, (t, m) => t('AI research failed · {company}', { company: m[1]! })],
  [/^AI research completed · (.+)$/, (t, m) => t('AI research completed · {company}', { company: m[1]! })],
  [/^Project created · (.+)$/, (t, m) => t('Project created · {name}', { name: m[1]! })],
  [/^Quotation accepted · (\S+) · (.+)$/, (t, m) => t('Quotation accepted · {number} · {total}', { number: m[1]!, total: m[2]! })],
  [/^Quotation expired · (.+)$/, (t, m) => t('Quotation expired · {number}', { number: m[1]! })],
  [/^Quotation not sent · (\S+)$/, (t, m) => t('Quotation not sent · {number}', { number: m[1]! })],
  [/^Quotation may not have been sent · (\S+)$/, (t, m) => t('Quotation may not have been sent · {number}', { number: m[1]! })],
  [/^Quotation emailed but not recorded · (\S+)$/, (t, m) => t('Quotation emailed but not recorded · {number}', { number: m[1]! })],
  [/^Mailer paused · (.+)$/, (t, m) => t('Mailer paused · {name}', { name: m[1]! })],
  [/^Mailer finished · (.+)$/, (t, m) => t('Mailer finished · {name}', { name: m[1]! })],
  [/^Mailer queued · (.+)$/, (t, m) => t('Mailer queued · {name}', { name: m[1]! })],
  [/^Task assigned to you · (.+)$/, (t, m) => t('Task assigned to you · {title}', { title: m[1]! })],
  // Task titles
  [/^Follow up · (.+)$/, (t, m) => t('Follow up · {company}', { company: m[1]! })],
  [/^Review new lead · (.+)$/, (t, m) => t('Review new lead · {company}', { company: m[1]! })],
  [/^Reply to email$/, (t) => t('Reply to email')],
  // Timeline titles
  [/^Lead created$/, (t) => t('Lead created')],
  [/^Converted to client$/, (t) => t('Converted to client')],
  [/^Marked do not email$/, (t) => t('Marked do not email')],
  [/^Do not email removed$/, (t) => t('Do not email removed')],
  [/^Unassigned$/, (t) => t('Unassigned')],
  [/^Assigned to (.+)$/, (t, m) => t('Assigned to {name}', { name: m[1]! })],
  [/^Transferred to (.+)$/, (t, m) => t('Transferred to {name}', { name: m[1]! })],
  [/^Status changed to (.+)$/, (t, m) => t('Status changed to {status}', { status: leadStatusText(t, m[1]!) })],
  [/^Call · (.+)$/, (t, m) => t('Call · {outcome}', { outcome: outcome(t, m[1]!) })],
  [/^(Call|Meeting) scheduled · (.+)$/, (t, m) => (m[1] === 'Call' ? t('Call scheduled · {title}', { title: m[2]! }) : t('Meeting scheduled · {title}', { title: m[2]! }))],
  [/^Email received · (.*)$/, (t, m) => t('Email received · {subject}', { subject: m[1]! })],
  [/^Email sent · (.*)$/, (t, m) => t('Email sent · {subject}', { subject: m[1]! })],
  [/^(\d+) open task\(s\) closed$/, (t, m) => (m[1] === '1' ? t('1 open task closed') : t('{n} open tasks closed', { n: m[1]! }))],
  [/^AI enrichment queued for (.+)$/, (t, m) => t('AI enrichment queued for {company}', { company: m[1]! })],
  [/^Contact moved to (.+)$/, (t, m) => t('Contact moved to {company}', { company: m[1]! })],
  [/^Converted to project (\S+)$/, (t, m) => t('Converted to project {number}', { number: m[1]! })],
  [/^Quotation drafted · (\S+)$/, (t, m) => t('Quotation drafted · {number}', { number: m[1]! })],
  [/^Quotation sent · (\S+) rev (\d+)$/, (t, m) => t('Quotation sent · {number} rev {n}', { number: m[1]!, n: m[2]! })],
  [/^Quotation (accepted|rejected) · (\S+)$/, (t, m) => (m[1] === 'accepted' ? t('Quotation accepted · {number}', { number: m[2]! }) : t('Quotation rejected · {number}', { number: m[2]! }))],
  [/^Company (\S+) created$/, (t, m) => t('Company {number} created', { number: m[1]! })],
  [/^Linked to company (\S+)$/, (t, m) => t('Linked to company {number}', { number: m[1]! })],
  // AI research history: trigger, engine, result
  [/^New lead (\S+)$/, (t, m) => t('New lead {number}', { number: m[1]! })],
  [/^Manual · (.+)$/, (t, m) => t('Manual · {name}', { name: m[1]! })],
  [/^Website reader$/, (t) => t('Website reader')],
  [/^Website reader \+ Claude Code (.+)$/, (t, m) => t('Website reader + Claude Code {model}', { model: m[1]! })],
  [/^No website on file$/, (t) => t('No website on file')],
  [/^Interrupted$/, (t) => t('Interrupted')],
];

/** Parts of a stored detail line ("3 sent · 1 skipped · 0 failed", "2 emails · sending now"). */
const PARTS: Rule[] = [
  [/^(\d+) to review$/, (t, m) => t('{n} to review', { n: m[1]! })],
  [/^(\d+) sent$/, (t, m) => t('{n} sent|mailer', { n: m[1]! })],
  [/^(\d+) skipped$/, (t, m) => t('{n} skipped|mailer', { n: m[1]! })],
  [/^(\d+) failed$/, (t, m) => t('{n} failed|mailer', { n: m[1]! })],
  [/^(\d+) emails?$/, (t, m) => (m[1] === '1' ? t('1 email') : t('{n} emails', { n: m[1]! }))],
  [/^(\d+) suggestions?$/, (t, m) => (m[1] === '1' ? t('1 suggestion') : t('{n} suggestions', { n: m[1]! }))],
  [/^sending now$/, (t) => t('sending now')],
  [/^starts (.+) UTC$/, (t, m) => t('starts {when} UTC', { when: m[1]! })],
  [/^from (\S+)$/, (t, m) => t('from {number}', { number: m[1]! })],
  [/^Convert to project\?$/, (t) => t('Convert to project?')],
  [/^Your Microsoft 365 mailbox needs reconnecting in Settings\.$/, (t) => t('Your Microsoft 365 mailbox needs reconnecting in Settings.')],
  [/^The sender's mailbox is no longer connected\.$/, (t) => t("The sender's mailbox is no longer connected.")],
  [/^The email could not be sent\. Send it again from the quotation\.$/, (t) => t('The email could not be sent. Send it again from the quotation.')],
  [/^Check Sent Items in Outlook before sending again\.$/, (t) => t('Check Sent Items in Outlook before sending again.')],
  [
    /^The email was sent, but the quotation and lead could not be updated\. Check them before sending again\.$/,
    (t) => t('The email was sent, but the quotation and lead could not be updated. Check them before sending again.'),
  ],
];

function apply(rules: Rule[], t: TFn, text: string): string | null {
  for (const [re, f] of rules) {
    const m = re.exec(text);
    if (m) return f(t, [...m]);
  }
  return null;
}

/** A stored system text (title) in the reader's language; anything unknown (a user's own title) as stored. */
export function systemText(t: TFn, text: string): string {
  return apply(RULES, t, text) ?? text;
}

/** A stored detail line: the whole line if known, else each " · " part that is known (names stay as stored). */
export function systemDetail(t: TFn, text: string): string {
  const whole = apply(RULES, t, text) ?? apply(PARTS, t, text);
  if (whole !== null) return whole;
  return text
    .split(' · ')
    .map((part) => apply(PARTS, t, part) ?? part)
    .join(' · ');
}
