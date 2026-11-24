import { useRef, useState } from 'react';
import { TEMPLATE_FILE_MAX_BYTES } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { sanitizeTemplateHtml, useDeleteTemplate, useTemplates, type EmailTemplate } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { parseOft } from '../../lib/oft';
import { LANGUAGE_NAMES, TemplateModal, type TemplateDraft } from './TemplateModal';

/**
 * Settings → Email templates (prototype V.templatesCard, release 2A): the team's templates, written here or read
 * from an uploaded Outlook .oft file; offered in every compose box.
 */
export function EmailTemplates() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const toast = useToast();
  const confirm = useConfirm();
  const { date } = useFormatDate();
  const { data: items } = useTemplates();
  const remove = useDeleteTemplate();
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canManage = me.can('manage_leads');
  const userLang = (['en', 'es', 'fr'].includes(lang) ? lang : 'en') as TemplateDraft['language'];

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > TEMPLATE_FILE_MAX_BYTES) {
      toast(t('That file is larger than 10 MB. Outlook templates are usually under 1 MB.'), 'warn');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    let parsed = { subject: '', body: '', html: '' };
    try {
      parsed = parseOft(await file.arrayBuffer());
    } catch (err) {
      toast(t('{reason} – you can still enter the text by hand', { reason: (err as Error).message }), 'warn');
    }
    // The file's formatting (its HTML body) is sanitised by the server before the editor shows it.
    let bodyHtml: string | null = null;
    if (parsed.html.trim()) {
      try {
        bodyHtml = await sanitizeTemplateHtml(parsed.html);
      } catch {
        toast(t('The formatting could not be read – the template is kept as plain text'), 'warn');
      }
    }
    setDraft({
      name: file.name.replace(/\.(oft|msg)$/i, ''), subject: parsed.subject, body: parsed.body, bodyHtml, language: userLang,
      sourceType: 'oft', fileName: file.name, fileSize: file.size,
    });
    if (fileRef.current) fileRef.current.value = '';
  }

  async function onDelete(x: EmailTemplate) {
    const ok = await confirm({ title: t('Delete this template?'), body: t('This cannot be undone.'), confirmLabel: t('Delete'), danger: true });
    if (!ok) return;
    remove.mutate(x.id, {
      onSuccess: () => toast(t('Template deleted')),
      onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
    });
  }

  return (
    <section className="card flush" aria-labelledby="tpl-title">
      <div className="head">
        <h2 id="tpl-title">{t('Email templates')}</h2>
        <span className="conn-sub">{t('Available in every compose box. Merge fields: {first_name} {company} {me} {quote_no} {lead_id}')}</span>
        <div className="grow" />
        {canManage ? (
          <>
            <button type="button" className="btn sm" onClick={() => setDraft({ name: '', subject: '', body: '', language: userLang, sourceType: 'manual' })}>
              {t('Write a template')}
            </button>
            <label className="btn sm primary tpl-upload">
              {t('Upload .oft template')}
              <input ref={fileRef} type="file" accept=".oft,.msg" className="sr" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
          </>
        ) : null}
      </div>
      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th>{t('Template')}</th>
              <th>{t('Source')}</th>
              <th>{t('Language')}</th>
              <th>{t('Subject')}</th>
              <th>{t('Added')}</th>
              <th aria-label={t('Actions')} />
            </tr>
          </thead>
          <tbody>
            {items && items.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  {t('No templates yet.')}
                </td>
              </tr>
            ) : null}
            {items?.map((x) => (
              <tr key={x.id}>
                <td>
                  <strong>{x.name}</strong>
                  {x.sourceType === 'oft' ? (
                    <span className="tpl-file">
                      {x.fileName ?? t('Outlook template')}
                      {x.fileSize ? ` · ${Math.round(x.fileSize / 1024)} KB` : ''}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className={x.sourceType === 'oft' ? 'badge b-purple' : 'badge b-grey'}>{x.sourceType === 'oft' ? t('Outlook .oft') : t('Written here')}</span>
                  {x.bodyHtml ? (
                    <>
                      {' '}
                      <span className="badge b-grey" title={t('Sent with its formatting (bold, lists, links, pictures)')}>{t('Formatted')}</span>
                    </>
                  ) : null}
                </td>
                <td>
                  <span className="badge b-grey">{LANGUAGE_NAMES[x.language] ?? x.language}</span>
                </td>
                <td className="tpl-subject">{x.subject}</td>
                <td className="dim">
                  {x.createdBy?.name ?? '—'} · {date(x.createdAt)}
                </td>
                <td className="nowrap">
                  {canManage ? (
                    <>
                      <button type="button" className="btn xs" onClick={() => setDraft(x)}>
                        {t('Edit')}
                      </button>{' '}
                      <button type="button" className="btn xs danger" disabled={remove.isPending} onClick={() => void onDelete(x)}>
                        {t('Delete')}
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="foot">
        {t('Save a message in Outlook as File → Save As → Outlook Template (*.oft), then upload it here. The subject and body are read from the file; placeholders typed as {first_name} etc. are filled in when you use it. Templates in your language are listed first.')}
      </div>
      {draft ? <TemplateModal draft={draft} onClose={() => setDraft(null)} /> : null}
    </section>
  );
}
