import { CALL_OUTCOMES, type CallOutcome } from '@dait-crm/shared';
import { callOutcomeText } from '../pages/leads/CallNoteForm';
import { leadStatusText } from './labels';
import type { TFn } from './useT';

type Rule = [RegExp, (t: TFn, m: string[]) => string];

/*
 * Texts the server writes in English and stores, shown in the reader's language (review #04): matched by their exact
 * known shapes, per kind of text, so rows stored before this change translate too. Names, numbers and subjects inside
 * them are kept as stored, and anything a user typed (a task title, a transfer note) is never translated.
 */

const NOTIFICATION: Rule[] = [
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
];

/** Titles of the tasks the server creates (a user's own title is never one of these exact shapes' words). */
const TASK: Rule[] = [
  [/^Follow up · (.+)$/, (t, m) => t('Follow up · {company}', { company: m[1]! })],
  [/^Review new lead · (.+)$/, (t, m) => t('Review new lead · {company}', { company: m[1]! })],
  [/^Reply to email$/, (t) => t('Reply to email')],
];

const TIMELINE: Rule[] = [
  [/^Lead created$/, (t) => t('Lead created')],
  [/^Converted to client$/, (t) => t('Converted to client')],
  [/^Marked do not email$/, (t) => t('Marked do not email')],
  [/^Do not email removed$/, (t) => t('Do not email removed')],
  [/^Unassigned$/, (t) => t('Unassigned')],
  [/^Assigned to (.+)$/, (t, m) => t('Assigned to {name}', { name: m[1]! })],
  [/^Transferred to (.+)$/, (t, m) => t('Transferred to {name}', { name: m[1]! })],
  [/^Status changed to (.+)$/, (t, m) => t('Status changed to {status}', { status: leadStatusText(t, m[1]!) })],
  // Only a logged call's own outcome: "Call · pricing" (a typed title) is left alone.
  [new RegExp(`^Call · (${CALL_OUTCOMES.join('|')})$`), (t, m) => t('Call · {outcome}', { outcome: callOutcomeText(t, m[1] as CallOutcome) })],
  [/^Call scheduled · (.+)$/, (t, m) => t('Call scheduled · {title}', { title: m[1]! })],
  [/^Meeting scheduled · (.+)$/, (t, m) => t('Meeting scheduled · {title}', { title: m[1]! })],
  [/^Follow-up planned · (.+)$/, (t, m) => t('Follow-up planned · {title}', { title: m[1]! })],
  [/^Email received · (.*)$/, (t, m) => t('Email received · {subject}', { subject: m[1]! })],
  [/^Email sent · (.*)$/, (t, m) => t('Email sent · {subject}', { subject: m[1]! })],
  [/^(\d+) open task\(s\) closed$/, (t, m) => (m[1] === '1' ? t('1 open task closed') : t('{n} open tasks closed', { n: m[1]! }))],
  [/^AI enrichment queued for (.+)$/, (t, m) => t('AI enrichment queued for {company}', { company: m[1]! })],
  [/^Contact moved to (.+)$/, (t, m) => t('Contact moved to {company}', { company: m[1]! })],
  [/^Converted to project (\S+)$/, (t, m) => t('Converted to project {number}', { number: m[1]! })],
  [/^Project created · (.+)$/, (t, m) => t('Project created · {name}', { name: m[1]! })],
  [/^Quotation drafted · (\S+)$/, (t, m) => t('Quotation drafted · {number}', { number: m[1]! })],
  [/^Quotation sent · (\S+) rev (\d+)$/, (t, m) => t('Quotation sent · {number} rev {n}', { number: m[1]!, n: m[2]! })],
  [/^Quotation accepted · (\S+)$/, (t, m) => t('Quotation accepted · {number}', { number: m[1]! })],
  [/^Quotation rejected · (\S+)$/, (t, m) => t('Quotation rejected · {number}', { number: m[1]! })],
  [/^Company (\S+) created$/, (t, m) => t('Company {number} created', { number: m[1]! })],
  [/^Linked to company (\S+)$/, (t, m) => t('Linked to company {number}', { number: m[1]! })],
];

/** AI research history: trigger, engine and the whole-line results. */
const RESEARCH: Rule[] = [
  [/^New lead (\S+)$/, (t, m) => t('New lead {number}', { number: m[1]! })],
  [/^Manual · (.+)$/, (t, m) => t('Manual · {name}', { name: m[1]! })],
  [/^Website reader$/, (t) => t('Website reader')],
  [/^Website reader \+ Claude Code (.+)$/, (t, m) => t('Website reader + Claude Code {model}', { model: m[1]! })],
  [/^No website on file$/, (t) => t('No website on file')],
  [/^Interrupted$/, (t) => t('Interrupted')],
];

/* System-written parts of detail lines ("3 sent · 1 skipped · 0 failed"), used only for the kinds below. */
const COUNTS: Rule[] = [
  [/^(\d+) sent$/, (t, m) => t('{n} sent|mailer', { n: m[1]! })],
  [/^(\d+) skipped$/, (t, m) => t('{n} skipped|mailer', { n: m[1]! })],
  [/^(\d+) failed$/, (t, m) => t('{n} failed|mailer', { n: m[1]! })],
  [/^(\d+) emails?$/, (t, m) => (m[1] === '1' ? t('1 email') : t('{n} emails', { n: m[1]! }))],
  [/^sending now$/, (t) => t('sending now')],
  [/^starts (.+) UTC$/, (t, m) => t('starts {when} UTC', { when: m[1]! })],
  [/^Your Microsoft 365 mailbox needs reconnecting in Settings\.$/, (t) => t('Your Microsoft 365 mailbox needs reconnecting in Settings.')],
  [/^The sender's mailbox is no longer connected\.$/, (t) => t("The sender's mailbox is no longer connected.")],
];
const REVIEW: Rule[] = [[/^(\d+) to review$/, (t, m) => t('{n} to review', { n: m[1]! })]];
const ACCEPTED: Rule[] = [[/^Convert to project\?$/, (t) => t('Convert to project?')]];
const SEND_FAILED: Rule[] = [
  [/^The email could not be sent\. Send it again from the quotation\.$/, (t) => t('The email could not be sent. Send it again from the quotation.')],
  [/^Check Sent Items in Outlook before sending again\.$/, (t) => t('Check Sent Items in Outlook before sending again.')],
  [
    /^The email was sent, but the quotation and lead could not be updated\. Check them before sending again\.$/,
    (t) => t('The email was sent, but the quotation and lead could not be updated. Check them before sending again.'),
  ],
];
const FROM_LEAD: Rule[] = [[/^from (\S+)$/, (t, m) => t('from {number}', { number: m[1]! })]];
const SUGGESTIONS: Rule[] = [[/^(\d+) suggestions?$/, (t, m) => (m[1] === '1' ? t('1 suggestion') : t('{n} suggestions', { n: m[1]! }))]];

/**
 * Notification kinds whose detail the server writes itself, with the parts it writes. Any other kind's detail (a
 * lead's company and the assigner's note, a transfer note, a quotation subject, an error message) is shown as stored.
 */
const DETAILS: [RegExp, Rule[]][] = [
  [/^Mailer (paused|finished|queued) · /, COUNTS],
  [/^AI research completed · /, REVIEW],
  [/^Quotation accepted · /, ACCEPTED],
  [/^Quotation (not sent|may not have been sent|emailed but not recorded) · /, SEND_FAILED],
  // "Company · from LD-1010": only the "from" part is the server's.
  [/^Project created · /, FROM_LEAD],
];

function apply(rules: Rule[], t: TFn, text: string): string | null {
  for (const [re, f] of rules) {
    const m = re.exec(text);
    if (m) return f(t, [...m]);
  }
  return null;
}

/** Each " · " part that matches `rules`; the others (names) as stored. */
const parts = (rules: Rule[], t: TFn, text: string) =>
  text
    .split(' · ')
    .map((part) => apply(rules, t, part) ?? part)
    .join(' · ');

/** A notification's text. */
export const notificationText = (t: TFn, text: string): string => apply(NOTIFICATION, t, text) ?? text;

/** A notification's detail: translated only for the kinds whose detail the server writes, and only those parts. */
export function notificationDetail(t: TFn, text: string, detail: string): string {
  const kind = DETAILS.find(([re]) => re.test(text));
  if (!kind) return detail;
  // "Company · from LD-1010": only a last part after the company is the server's; the name is kept as stored.
  if (kind[1] === FROM_LEAD) {
    const at = detail.lastIndexOf(' · ');
    const done = at < 0 ? null : apply(FROM_LEAD, t, detail.slice(at + 3));
    return done === null ? detail : `${detail.slice(0, at)} · ${done}`;
  }
  return parts(kind[1], t, detail);
}

/** A task title: the server's own titles translate; a user's title is shown as typed. */
export const taskTitle = (t: TFn, title: string): string => apply(TASK, t, title) ?? title;

/** Meeting entries the server writes when a call or meeting is planned; any other meeting title was typed by a user. */
const PLANNED: Rule[] = TIMELINE.filter(([re]) => /scheduled/.test(re.source));

/**
 * A timeline entry's title. Meeting and research-note titles are typed by users, so a meeting translates only in the
 * server's "Call / Meeting scheduled · …" shape and a research note never does.
 */
export function timelineTitle(t: TFn, title: string, type?: string): string {
  if (type === 'research') return title;
  return apply(type === 'meeting' ? PLANNED : TIMELINE, t, title) ?? title;
}

/** An AI research run's trigger or engine. */
export const researchText = (t: TFn, text: string): string => apply(RESEARCH, t, text) ?? text;

/** An AI research run's result: a known whole line, else its "N suggestions" part (provider notes as stored). */
export const researchResult = (t: TFn, text: string): string => apply(RESEARCH, t, text) ?? parts(SUGGESTIONS, t, text);
