import type { CalendarItem } from '@dait-crm/shared';
import { Modal } from '../../components/Modal';
import { useT, type TFn } from '../../i18n/useT';
import { shortDay, type CalendarNames } from './dates';
import { taskTitle } from '../../i18n/systemText';

function typeText(t: TFn, type: CalendarItem['type']): string {
  switch (type) {
    case 'call':
      return t('Call');
    case 'meeting':
      return t('Meeting');
    case 'internal':
      return t('Internal');
    default:
      return t('Follow-up');
  }
}

/** Prototype event details (an item without a lead): When, Type, Organiser, Attendees, Where. */
export function EventInfoModal({ item: x, names, onClose }: { item: CalendarItem; names: CalendarNames; onClose: () => void }) {
  const t = useT();
  const when = shortDay(x.date, names) + (x.time ? ` · ${x.time}${x.end ? `–${x.end}` : ''}` : '');
  return (
    <Modal
      title={taskTitle(t, x.title)}
      onClose={onClose}
      actions={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('Close')}
        </button>
      }
    >
      <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
        <dt>{t('When')}</dt>
        <dd>{when}</dd>
        <dt>{t('Type')}</dt>
        {/* Lower case, as the prototype prints the type. */}
        <dd>{typeText(t, x.type).toLowerCase()}</dd>
        <dt>{t('Organiser')}</dt>
        <dd>{x.organizer || x.ownerName}</dd>
        <dt>{t('Attendees')}</dt>
        <dd style={{ fontWeight: 400 }}>{x.attendees?.length ? x.attendees.join(', ') : '—'}</dd>
        <dt>{t('Where')}</dt>
        <dd>{x.where || '—'}</dd>
      </dl>
    </Modal>
  );
}
