/** What a template's merge fields are filled from (prototype: {first_name} {company} {me} {quote_no} {lead_id}). */
export type MergeContext = { firstName: string; company: string; me: string; leadNumber: string };

const values = (ctx: MergeContext): Record<string, string> => ({
  first_name: ctx.firstName, company: ctx.company, me: ctx.me, lead_id: ctx.leadNumber, quote_no: '',
});
const FIELD = /\{(\w+)\}/g;

/** Fills the known merge fields; `{quote_no}` is empty until quotations exist (release 3); unknown `{x}` stay as typed. */
export function fillTemplate(text: string, ctx: MergeContext): string {
  const v = values(ctx);
  return text.replace(FIELD, (m, k: string) => (Object.hasOwn(v, k) ? v[k]! : m));
}

/** Text made safe to put in HTML (element content or a quoted attribute). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * A formatted (HTML) template's merge fields, by the same rules as fillTemplate, with every value HTML-escaped: a
 * company or contact name never adds markup to the message.
 */
export function fillTemplateHtml(html: string, ctx: MergeContext): string {
  const v = values(ctx);
  return html.replace(FIELD, (m, k: string) => (Object.hasOwn(v, k) ? escapeHtml(v[k]!) : m));
}
