import type { ReactNode } from 'react';
import { attachmentUrl, useMailAttachments, type MailAttachment } from '../../api/mail';
import { useT } from '../../i18n/useT';
import { sizeText } from '../imports/labels';

/** The file-type badge: the extension in capitals (PDF, XLSX, DOCX …), coloured for PDF, spreadsheets and documents. */
export function fileBadge(name: string): { text: string; tone: string } {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const text = ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
  const tone = ext === 'pdf' ? 'pdf' : ['xls', 'xlsx', 'xlsm', 'csv'].includes(ext) ? 'xls' : ['doc', 'docx', 'rtf'].includes(ext) ? 'doc' : 'oth';
  return { text, tone };
}

function Card({ name, children }: { name: string; children?: ReactNode }) {
  const badge = fileBadge(name);
  return (
    <div className="att" role="listitem">
      <span className={`fi ${badge.tone}`} aria-hidden="true">{badge.text}</span>
      <div className="an">
        <b title={name}>{name}</b>
        {children ? <small>{children}</small> : null}
      </div>
    </div>
  );
}

/**
 * A message's received attachments above its body (mockup `.atts`), read from Outlook when the message is expanded
 * (the component is only shown then). Each card: the type badge, the name, the size, `Preview` (a PDF or picture the
 * server recognised, in a new tab) and `Download`. A cloud link (`reference`) has neither; an attached message
 * (`item`) is a download only. Until the list arrives, or when the mailbox is no longer connected
 * (`available: false`, "Not in Outlook yet"), the names show without links.
 */
export function AttachmentCards({ messageId, names }: { messageId: number; names: string[] }) {
  const t = useT();
  const { data } = useMailAttachments(messageId, names.length > 0);
  const items: MailAttachment[] | null = data?.available ? data.items : null;
  return (
    <div className="atts-wrap">
      <div className="atts" role="list" aria-label={t('Attachments')}>
        {items
          ? items.map((a) => (
            <Card key={a.id} name={a.name}>
              <span>{sizeText(a.size)}</span>
              {a.kind === 'file' && a.preview ? (
                <a href={attachmentUrl(messageId, a.id, true)} target="_blank" rel="noopener">{t('Preview')}</a>
              ) : null}
              {a.kind !== 'reference' ? <a href={attachmentUrl(messageId, a.id, false)} download>{t('Download')}</a> : null}
            </Card>
          ))
          : names.map((n, i) => <Card key={`${i}-${n}`} name={n} />)}
      </div>
      {data && !data.available ? <div className="atts-note">{t('Not in Outlook yet')}</div> : null}
    </div>
  );
}
