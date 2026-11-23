import { Modal } from '../../components/Modal';
import { useT } from '../../i18n/useT';
import type { QuotationDetail } from '../../api/quotations';

type PreviewOf = Pick<QuotationDetail, 'id' | 'number' | 'revision' | 'editingNewRevision' | 'revisions'>;

/**
 * The PDF a send would attach: revision n's frozen snapshot when it was sent and is not being edited (a send without
 * edits re-sends it as first sent), else the working copy.
 */
export function previewPdfUrl(q: PreviewOf): string {
  const sent = !q.editingNewRevision && q.revisions.some((r) => r.revisionNo === q.revision);
  return `/api/quotations/${q.id}/pdf${sent ? `?rev=${q.revision}` : ''}`;
}

/**
 * Preview PDF (prototype V.quoteEditor preview dialog): the PDF the API draws, the same file that is emailed, shown
 * in the dialog with Close and Download (the prototype's "Print / Save as PDF").
 */
export function PdfPreviewModal({ q, onClose }: { q: PreviewOf; onClose: () => void }) {
  const t = useT();
  const src = previewPdfUrl(q);
  return (
    <Modal
      title={t('Quotation {number}', { number: q.number })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Close')}
          </button>
          <a className="btn primary" href={src} download={`${q.number}-rev${q.revision}.pdf`}>
            {t('Download')}
          </a>
        </>
      }
    >
      {/* The browser's viewer without its toolbar and page list, the page fitted to the width (like the prototype's preview). */}
      <iframe className="q-pdf" src={`${src}#toolbar=0&navpanes=0&view=FitH`} title={t('Quotation {number}', { number: q.number })} />
    </Modal>
  );
}
