import type { DraftFileView } from '../../../api/drafts';
import { Icons } from '../../../components/Icons';
import { useT } from '../../../i18n/useT';
import { sizeText } from '../../imports/labels';
import { fileBadge } from '../AttachmentCards';

/**
 * The draft's attachments under the message (mockup `.att-chips` / `.att-chip`): the type badge, the name, the size and
 * `Remove attachment`. Inline pictures are not listed (they show in the message itself).
 */
export function FileChips({ files, onRemove, disabled }: { files: DraftFileView[]; onRemove: (id: string) => void; disabled?: boolean }) {
  const t = useT();
  const shown = files.filter((f) => !f.inline);
  if (!shown.length) return null;
  return (
    <ul className="att-chips" aria-label={t('Attachments')}>
      {shown.map((f) => {
        const badge = fileBadge(f.name);
        return (
          <li key={f.id} className="att-chip">
            <span className={`fi ${badge.tone}`} aria-hidden="true">{badge.text}</span>
            <span className="an" title={f.name}>{f.name}</span>
            <small>{sizeText(f.size)}</small>
            <button type="button" className="x" aria-label={t('Remove attachment')} title={t('Remove attachment')} disabled={disabled} onClick={() => onRemove(f.id)}>
              <span className="ico" aria-hidden="true">{Icons.x}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
