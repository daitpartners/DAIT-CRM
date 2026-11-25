import { useT } from '../i18n/useT';
import { sizeText } from '../pages/imports/labels';

type File = { key: string | number; name: string; size: number };

/**
 * A message's or template's attachments under its body (template pictures and attachments, owner 24 Nov 2026): name
 * and size, each with a remove button when `onRemove` is given. Inline pictures are not listed (they show in the
 * message itself).
 */
export function AttachmentChips({ files, onRemove, disabled }: { files: File[]; onRemove?: (key: File['key']) => void; disabled?: boolean }) {
  const t = useT();
  if (!files.length) return null;
  return (
    <ul className="chips" aria-label={t('Attachments')} style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
      {files.map((f) => (
        <li key={f.key} className="pill" title={f.name}>
          {f.name} · {sizeText(f.size)}
          {onRemove ? (
            <button type="button" aria-label={t('Remove {item}', { item: f.name })} disabled={disabled} onClick={() => onRemove(f.key)}>
              ×
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
