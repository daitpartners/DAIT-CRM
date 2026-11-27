/**
 * Who a reply, reply all or forward goes to, and its subject (web-mail release 2). Written once here: the API sends to
 * these addresses and the Email screen pre-fills them, so what the screen shows is what is sent.
 */

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

/** The parts of the original message the recipients come from. */
export interface ReplyOriginal {
  status: string;
  fromAddress: string;
  toAddresses: readonly string[];
}

const SUBJECT_MAX = 500;
const RE = /^\s*re\s*:/i;
const FW = /^\s*fwd?\s*:/i;

/**
 * `reply`: the sender of a received message, or the recipients of your own. `replyAll`: that set and the original To,
 * without your own addresses (`own`: the mailbox address and its send-as), lower-cased and unique; mail only between
 * your own addresses keeps the reply recipients, as Outlook does. `forward`: the addresses given (`bodyTo`).
 * Cc is never derived here: it is always what the client sends (the screen pre-fills the original Cc for Reply all).
 */
export function replyRecipients(original: ReplyOriginal, mode: ReplyMode, own: readonly string[], bodyTo: readonly string[]): { to: string[] } {
  if (mode === 'forward') return { to: [...bodyTo] };
  const reply = original.status === 'received' ? [original.fromAddress] : [...original.toAddresses];
  if (mode === 'reply') return { to: reply };
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const all = [...new Set([...reply, ...original.toAddresses].map((a) => a.trim().toLowerCase()))].filter((a) => a && !mine.has(a));
  return { to: all.length ? all : reply };
}

/** `Re: ` unless it already starts with "re:"; for a forward `Fw: ` unless "fw:" / "fwd:" (any case). 500 characters at most. */
export function replySubject(subject: string, mode: ReplyMode): string {
  const [prefix, has] = mode === 'forward' ? ['Fw: ', FW] : ['Re: ', RE];
  return (has.test(subject) ? subject : `${prefix}${subject}`).slice(0, SUBJECT_MAX);
}
