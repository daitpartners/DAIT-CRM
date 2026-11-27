import { createElement, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { BULK_MAX, type FlagPreset } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useBulkMailChange, useMailAction, useMailChange, useMailFollowUp, useUnlinkMail, type MailChange, type MailDetail, type MailItem } from '../../api/mail';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { firstName, mailErrorText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import type { ComposeStart } from './ComposeModal';
import type { ReplyKind } from './compose/InlineReply';
import { LinkLeadModal } from './LinkLeadModal';
import { followUpWhen, LinkMenu } from './menus';

export type CommandId =
  | 'new' | 'delete' | 'archive' | 'move' | 'reply' | 'replyAll' | 'forward' | 'flag' | 'toggleRead'
  | 'followUp' | 'link' | 'log' | 'task' | 'meeting' | 'openLead';

/**
 * What a command acts on: one message (`item`), or a multi-selection (`item` null, `rows` the selected rows). `ids` are
 * the messages changed: in conversation view a row's whole conversation in the view (F24), so Archive does not leave
 * older messages behind.
 */
export type MailTarget = { ids: number[]; item: MailItem | MailDetail | null; rows?: MailItem[] };

export type CommandState = { enabled: boolean; title?: string; label?: string };

/** A message, or the messages of a row: its conversation's ids in the view when the list gave them (F24). */
export function rowTarget(m: MailItem | MailDetail): MailTarget {
  return { ids: m.conversationIds?.length ? m.conversationIds : [m.id], item: m };
}

/** Several checked rows: every message of each row's conversation, once. */
export function selectionTarget(rows: MailItem[]): MailTarget {
  return { ids: [...new Set(rows.flatMap((r) => rowTarget(r).ids))], item: null, rows };
}

/** Commands that change the mailbox (Outlook first): never in another user's mailbox, never while a message is sending. */
const MAILBOX: readonly CommandId[] = ['delete', 'archive', 'move', 'reply', 'replyAll', 'forward', 'flag', 'toggleRead'];
/** What a multi-selection can do. */
const MULTI: readonly CommandId[] = ['delete', 'archive', 'move', 'flag', 'toggleRead'];

type Rules = { connected: boolean; canFollowUp: boolean };

/**
 * Whether command `id` can run on `target`, and why not (the button's title): the one place for the Email screen's
 * rules (F10). No target → only New mail. Another user's message (team view) → mailbox commands and Link to lead
 * disabled, "View only — {first}'s mailbox". A draft → only Delete. Queued or sending → mailbox commands disabled,
 * "Still sending". CRM commands need a lead the user can open (Follow-up also `manage_leads`). A multi-selection →
 * Delete, Archive, Move, Flag and Mark as read only. Mark as read / unread is labelled for what it will do.
 */
export function commandState(id: CommandId, target: MailTarget | null, rules: Rules, t: TFn): CommandState {
  if (id === 'new') return { enabled: true };
  if (!target || target.ids.length === 0) return { enabled: false };
  const m = target.item;
  const rows: (MailItem | MailDetail)[] = m ? [m] : target.rows ?? [];
  if (!m && !MULTI.includes(id)) return { enabled: false };
  const label = id === 'toggleRead' ? (m?.isRead ? t('Mark as unread') : t('Mark as read')) : undefined;
  const off = (title?: string): CommandState => ({ enabled: false, title, label });
  const on: CommandState = { enabled: true, label };
  const theirs = rows.find((r) => r.viewOnly);
  if (theirs && (MAILBOX.includes(id) || id === 'link')) return off(t("View only — {name}'s mailbox", { name: firstName(theirs.owner.name) }));
  if (rows.some((r) => r.status === 'draft')) return id === 'delete' ? on : off();
  if (MAILBOX.includes(id)) {
    if (rows.some((r) => r.status === 'queued' || r.status === 'sending')) return off(t('Still sending'));
    return rules.connected ? on : off(t('Mailbox not connected'));
  }
  if (!m) return off();
  if (id === 'link') return m.leadRestricted ? off() : on;
  if (m.leadId === null) return off(t('Link it to a lead first'));
  if (id === 'followUp' && !rules.canFollowUp) return off();
  if (id === 'log' && 'loggedAt' in m && m.loggedAt) return off();
  return on;
}

export type MailCommandsContext = {
  /** Your own mailbox is connected. */
  connected: boolean;
  /** New mail (and its templates). */
  onCompose: (s: ComposeStart) => void;
  /** Reply, Reply all or Forward of message `originalId`: the inline editor opens at the top of its conversation. */
  onReply: (originalId: number, kind: ReplyKind) => void;
  /** What New mail starts with (a link's client, lead and project); empty when not given. */
  newStart?: () => ComposeStart;
  /** Messages moved or deleted: the screen lets go of the open one if it is among them. */
  onGone?: (ids: number[]) => void;
};

/** The flag a Flag command sets: a due-day preset, Mark complete or Clear flag. */
export type FlagChoice = FlagPreset | 'complete' | 'clear';

/**
 * The Email screen's commands for any target (F10: rows, menus and per-message buttons act on a message other than
 * the open one): `state(id, target)` as commandState, `run(id, target, arg?)` does it (nothing when disabled), and
 * `dialog` is the Link to lead ▾ menu (or its Create lead window) the page renders once. Mailbox changes go through useMailChange (one message) or
 * useBulkMailChange (a conversation or a selection), which update the screen at once and toast their own failures.
 * Delete inside Deleted items deletes for good, after "Delete permanently?". `arg`: the folder for `move`, the
 * FlagChoice for `flag` (none toggles: flagged → Clear flag, else Today), `isRead` for `toggleRead` (Ctrl+U passes
 * false), `{ date, time }` or `{ clear: true }` for `followUp` (toasts "Follow-up set for {when}"), the point where
 * Link to lead ▾ opens for `link`.
 */
export function useMailCommands(ctx: MailCommandsContext): {
  state: (id: CommandId, target: MailTarget | null) => CommandState;
  run: (id: CommandId, target: MailTarget | null, arg?: unknown) => void;
  dialog: ReactElement | null;
} {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const one = useMailChange();
  const many = useBulkMailChange();
  const action = useMailAction();
  const followUp = useMailFollowUp();
  const unlink = useUnlinkMail();
  /** Link to lead ▾ open for a message (where it opened), or its Link email to a lead window (Create lead…). */
  const [linkMenu, setLinkMenu] = useState<{ item: MailItem | MailDetail; at: { x: number; y: number } } | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const rules: Rules = { connected: ctx.connected, canFollowUp: me.can('manage_leads') };
  const state = (id: CommandId, target: MailTarget | null) => commandState(id, target, rules, t);
  const failed = (err: unknown) => toast(mailErrorText(t, err instanceof ApiError ? err.code : ''), 'warn');

  /** One message through /change, more through /bulk (BULK_MAX at a time). */
  const change = (ids: number[], c: MailChange) => {
    if (ids.length === 1) {
      one.mutate({ id: ids[0]!, change: c });
      return;
    }
    for (let i = 0; i < ids.length; i += BULK_MAX) many.mutate({ ids: ids.slice(i, i + BULK_MAX), change: c });
  };
  const moveOut = (ids: number[], c: MailChange) => {
    change(ids, c);
    ctx.onGone?.(ids);
  };

  const run = (id: CommandId, target: MailTarget | null, arg?: unknown) => {
    if (!state(id, target).enabled) return;
    if (id === 'new') {
      ctx.onCompose(ctx.newStart?.() ?? {});
      return;
    }
    if (!target) return;
    const m = target.item;
    const rows: (MailItem | MailDetail)[] = m ? [m] : target.rows ?? [];
    switch (id) {
      case 'delete': {
        const forGood = rows.some((r) => r.folder === 'deleted');
        if (!forGood) {
          moveOut(target.ids, { type: 'delete' });
          return;
        }
        void confirm({ title: t('Delete permanently?'), body: t('It is removed from Outlook too.'), confirmLabel: t('Delete'), danger: true })
          .then((ok) => {
            if (ok) moveOut(target.ids, { type: 'delete' });
          });
        return;
      }
      case 'archive':
        moveOut(target.ids, { type: 'move', folder: 'archive' });
        return;
      case 'move': {
        const folder = arg as 'inbox' | 'archive' | 'deleted';
        moveOut(target.ids, { type: 'move', folder });
        return;
      }
      case 'flag': {
        const flag = (arg as FlagChoice | undefined) ?? (m?.flagStatus === 'flagged' ? 'clear' : 'today');
        change(target.ids, { type: 'flag', flag });
        return;
      }
      case 'toggleRead': {
        const isRead = typeof arg === 'boolean' ? arg : m ? !m.isRead : true;
        change(target.ids, { type: 'read', isRead });
        return;
      }
    }
    if (!m) return;
    switch (id) {
      case 'reply': case 'replyAll': case 'forward':
        // The server works out the recipients, subject and quote when it makes the draft.
        ctx.onReply(m.id, id);
        return;
      case 'followUp': {
        const when = arg as { date: string; time: string } | { clear: true };
        followUp.mutate({ id: m.id, ...when }, {
          onSuccess: () => toast('clear' in when ? t('Follow-up cleared') : t('Follow-up set for {when}', { when: followUpWhen(when.date, when.time, me.language) })),
        });
        return;
      }
      case 'link': {
        // `arg` is where Link to lead ▾ opens (under its button, or where the right-click menu was).
        const at = (arg as { x: number; y: number } | undefined) ?? { x: window.innerWidth / 2 - 145, y: 120 };
        setLinkMenu({ item: m, at });
        return;
      }
      case 'log':
        action.mutate({ id: m.id, action: 'log' }, { onSuccess: () => toast(t('Logged on {lead}', { lead: m.leadNumber ?? '' })), onError: failed });
        return;
      case 'task':
        action.mutate({ id: m.id, action: 'task' }, { onSuccess: () => toast(t('Task created')), onError: failed });
        return;
      case 'meeting':
        navigate(`/calendar?new=1&lead=${m.leadId}`);
        return;
      case 'openLead':
        navigate(`/leads/${m.leadId}`);
        return;
    }
  };

  const menu = linkMenu
    ? createElement(LinkMenu, {
      at: linkMenu.at,
      item: linkMenu.item,
      onClose: () => setLinkMenu(null),
      onLink: (lead: { id: number; number: string }) => action.mutate(
        { id: linkMenu.item.id, action: 'link', body: { leadId: lead.id } },
        { onSuccess: () => toast(t('Linked to {lead}', { lead: lead.number })), onError: failed },
      ),
      // useUnlinkMail toasts its own failure.
      onUnlink: () => unlink.mutate(linkMenu.item.id, { onSuccess: () => toast(t('Unlinked from {lead}', { lead: linkMenu.item.leadNumber ?? '' })) }),
      onCreate: () => setLinking(linkMenu.item.id),
    })
    : null;
  const dialog = linking === null
    ? menu
    : createElement(LinkLeadModal, {
      message: { id: linking },
      onClose: () => setLinking(null),
      onLinked: (lead: string) => toast(t('Linked to {lead}', { lead })),
      onCreated: (leadId: number) => {
        toast(t('Lead created and linked'));
        navigate(`/leads/${leadId}`);
      },
    });

  return { state, run, dialog };
}
