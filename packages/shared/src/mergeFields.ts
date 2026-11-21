/** What a template's merge fields are filled from (prototype: {first_name} {company} {me} {quote_no} {lead_id}). */
export type MergeContext = { firstName: string; company: string; me: string; leadNumber: string };

/** Fills the known merge fields; `{quote_no}` is empty until quotations exist (release 3); unknown `{x}` stay as typed. */
export function fillTemplate(text: string, ctx: MergeContext): string {
  const values: Record<string, string> = { first_name: ctx.firstName, company: ctx.company, me: ctx.me, lead_id: ctx.leadNumber, quote_no: '' };
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k]! : m));
}
