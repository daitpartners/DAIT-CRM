import type { FastifyPluginAsync } from 'fastify';
import { DraftCreate, DraftSave, RecipientQuery, RecipientResolve } from '@dait-crm/shared';
import { requireRight } from '../plugins/auth.js';
import { parseBody, parseQuery } from '../validate.js';
import { FORMATTED_BODY_LIMIT, perUser } from '../mail/formatted.js';
import {
  createDraft, discardDraft, draftFor, draftView, openDraft, resolveRecipients, saveDraft, suggestRecipients,
} from '../mail/drafts.js';
import { guard } from './leads.js';

/**
 * Drafts in the user's own Outlook (web-mail release 3, mail/drafts.ts): start one (new, reply, reply all, forward),
 * open, auto-save and discard it, and the To / Cc / Bcc suggestions. Only the caller's own connected mailbox and own
 * drafts: another user's message or draft is 403 view_only (team view) or 404, enforced on every route.
 */
export const mailDraftRoutes: FastifyPluginAsync = async (app) => {
  const pre = { preHandler: [requireRight('use_email')] };

  app.post('/mail/drafts', { ...pre, config: perUser(30) }, async (request, reply) => {
    const body = parseBody(DraftCreate, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const m = await createDraft(app.graph, user, body);
      return reply.code(201).send(await draftView(user, m));
    });
  });

  app.get<{ Params: { id: string } }>('/mail/drafts/:id', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => openDraft(app.graph, user, await draftFor(user, request.params.id)));
  });

  // Auto-save: the whole draft as the editor holds it, formatted (a larger request), at most 120 saves a minute.
  app.patch<{ Params: { id: string } }>('/mail/drafts/:id', { ...pre, bodyLimit: FORMATTED_BODY_LIMIT, config: perUser(120) }, async (request, reply) => {
    const body = parseBody(DraftSave, request.body);
    const user = request.user!;
    return guard(reply, async () => saveDraft(app.graph, user, await draftFor(user, request.params.id), body));
  });

  app.delete<{ Params: { id: string } }>('/mail/drafts/:id', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      await discardDraft(app.graph, user, await draftFor(user, request.params.id));
      return reply.code(204).send();
    });
  });

  app.get('/mail/recipients', pre, async (request) => {
    const { q } = parseQuery(RecipientQuery, request.query);
    return { items: await suggestRecipients(request.user!, q) };
  });

  app.post('/mail/recipients/resolve', pre, async (request) => {
    const { addresses } = parseBody(RecipientResolve, request.body);
    return { items: await resolveRecipients(request.user!, addresses) };
  });
};
