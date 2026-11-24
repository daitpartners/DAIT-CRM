// The merge-field rules live in the shared package (the Mailer fills them on the server too, release 2C); formatted
// templates use fillTemplateHtml (the same rules, values HTML-escaped).
export { fillTemplate, fillTemplateHtml, type MergeContext } from '@dait-crm/shared';
