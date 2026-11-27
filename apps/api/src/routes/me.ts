import type { FastifyPluginAsync } from 'fastify';
import { ACTIONS, PreferencesUpdate, SIGNATURE_HTML_MAX, SignatureUpdate, can, roleLabel } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { FORMATTED_BODY_LIMIT, MessageTooLongError, perUser, sanitizeFormatted } from '../mail/formatted.js';
import { textToHtml } from '../mail/html.js';
import { parseBody } from '../validate.js';
import { requireUser, type AuthUser } from '../plugins/auth.js';

const withRights = (user: AuthUser) => ({ ...user, rights: ACTIONS.filter((a) => can(user.role, a)) });

/** A signature too long to keep (over SIGNATURE_HTML_MAX characters once sanitised): `400 signature_too_long`. */
class SignatureTooLongError extends Error {}

const CSS_DECLARATION = /[^;{}]+/g;
/** CSS with every declaration that names a url() taken out (a background picture). */
const withoutCssUrls = (css: string) => css.replace(CSS_DECLARATION, (decl) => (/url\s*\(/i.test(decl) ? '' : decl)).replace(/(^|[{;])(\s*;)+/g, '$1');

/**
 * Sanitised HTML without pictures (plan decision 16: a signature keeps formatting and links only). It runs on the
 * sanitiser's output, where a `>` or `"` inside an attribute is always an entity, so `<img …>` and `style="…"` are
 * whole tags and attributes. A style attribute's entities are read before its declarations are split (an `&quot;`
 * holds a `;`) and written back after.
 */
function withoutPictures(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<style>([\s\S]*?)<\/style>/gi, (_m, css: string) => `<style>${withoutCssUrls(css)}</style>`)
    .replace(/\sstyle="([^"]*)"/gi, (_m, value: string) => {
      // The sanitiser's attribute encoding (sanitize-html escapeHtml): & < > " as entities.
      const css = value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const encoded = withoutCssUrls(css).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return ` style="${encoded}"`;
    });
}

/**
 * A signature's HTML to store: sanitised as outgoing mail is (sanitizeFormatted), pictures removed; null when nothing
 * is left. HTML the sanitiser could not read is kept as its text. Over SIGNATURE_HTML_MAX: SignatureTooLongError.
 */
async function signatureHtml(html: string | null): Promise<string | null> {
  if (html === null) return null;
  let r;
  try {
    r = await sanitizeFormatted(html, SIGNATURE_HTML_MAX);
  } catch (err) {
    if (err instanceof MessageTooLongError) throw new SignatureTooLongError();
    throw err;
  }
  const out = r.kind === 'html' ? withoutPictures(r.html).trim() : r.kind === 'fallback' && r.text.trim() ? textToHtml(r.text.trim()) : '';
  if (out.length > SIGNATURE_HTML_MAX) throw new SignatureTooLongError();
  return out || null;
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: [requireUser] }, async (request) => withRights(request.user!));

  app.patch('/me/preferences', { preHandler: [requireUser] }, async (request) => {
    const prefs = parseBody(PreferencesUpdate, request.body);
    const me = request.user!;
    const before = { language: me.language, timezone: me.timezone, dateFormat: me.dateFormat };
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: me.id }, data: prefs });
      await audit(tx, { entityType: 'user', entityId: me.id, action: 'update', userId: me.id, before, after: prefs });
      return updated;
    });
    return withRights({
      id: row.id, email: row.email, name: row.name, role: roleLabel(row.role),
      language: row.language, timezone: row.timezone, dateFormat: row.dateFormat,
    });
  });

  // The caller's own email signature (web-mail release 3): only ever their own row.
  app.get('/me/signature', { preHandler: [requireUser] }, async (request) => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.id }, select: { signatureHtml: true, signatureAuto: true } });
    return { html: row.signatureHtml, auto: row.signatureAuto };
  });

  app.put('/me/signature', { preHandler: [requireUser], bodyLimit: FORMATTED_BODY_LIMIT, config: perUser(30) }, async (request, reply) => {
    const body = parseBody(SignatureUpdate, request.body);
    const me = request.user!;
    let html: string | null;
    try {
      html = await signatureHtml(body.html);
    } catch (err) {
      if (err instanceof SignatureTooLongError) return reply.code(400).send({ error: 'signature_too_long' });
      throw err;
    }
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: me.id }, data: { signatureHtml: html, signatureAuto: body.auto }, select: { signatureHtml: true, signatureAuto: true } });
      // No content in the audit trail: only that the signature was saved, and the setting.
      await audit(tx, { entityType: 'user', entityId: me.id, action: 'update', userId: me.id, after: { signature: true, auto: body.auto } });
      return updated;
    });
    return { html: row.signatureHtml, auto: row.signatureAuto };
  });
};
