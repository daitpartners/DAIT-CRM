import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { UNDO_SEND_SECONDS } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useUnsend, type DraftView } from '../../api/drafts';
import { useCurrentUser } from '../../api/useCurrentUser';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { whenShort } from '../../pages/email/sendDates';
import { Icons } from '../Icons';
import { useToast } from '../Toast';

/** A send just queued: the message, the end of its Undo window, its follow-up, and what Undo hands the draft back to. */
export type UndoShow = { messageId: number; until: string; followUp: { date: string; time: string } | null; onUndone(d: DraftView): void };

const UndoSendContext = createContext<{ show(r: UndoShow): void }>({ show: () => {} });

/**
 * The Undo send toast (mockup `.utoast`), one for the whole signed-in app (mounted in Shell, so it stays across route
 * changes): `Sent · follow-up added for {when}` or `Sent`, the `Undo` button and a bar running out at the end of the
 * window. Undo takes the send back (`useUnsend`) and hands the draft to the screen that sent it; a send already gone
 * (`409 already_sent`) says so instead.
 */
export function UndoSendProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const toast = useToast();
  const unsend = useUnsend();
  const [current, setCurrent] = useState<(UndoShow & { key: number }) | null>(null);
  const next = useRef(1);

  const show = useCallback((r: UndoShow) => {
    setCurrent({ ...r, key: next.current++ });
  }, []);

  // Gone at the end of the window.
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent((c) => (c?.key === current.key ? null : c)), Math.max(0, Date.parse(current.until) - Date.now()));
    return () => clearTimeout(timer);
  }, [current]);

  function undo() {
    if (!current) return;
    const shown = current;
    unsend.mutate(shown.messageId, {
      onSuccess: (draft) => {
        setCurrent((c) => (c?.key === shown.key ? null : c));
        shown.onUndone(draft);
      },
      onError: (err) => {
        setCurrent((c) => (c?.key === shown.key ? null : c));
        const code = err instanceof ApiError ? err.code : 'try_again';
        toast(code === 'already_sent' ? t('Too late: the email was sent.') : errorText(t, code, {}, { context: 'draft' }), 'warn');
      },
    });
  }

  return (
    <UndoSendContext.Provider value={{ show }}>
      {children}
      {current ? (
        <div className="wm-send">
          <div className="utoast" role="status" key={current.key}>
            <span className="ico">{Icons.send}</span>
            <span className="grow">
              {current.followUp
                ? t('Sent · follow-up added for {when}', { when: whenShort(current.followUp.date, current.followUp.time, me.timezone, lang) })
                : t('Sent')}
            </span>
            <button type="button" onClick={undo} disabled={unsend.isPending}>{t('Undo')}</button>
            <UndoProgress until={current.until} />
          </div>
        </div>
      ) : null}
    </UndoSendContext.Provider>
  );
}

/** The bar under the toast: the share of the Undo window left, running down to nothing at `until`. */
function UndoProgress({ until }: { until: string }) {
  const total = UNDO_SEND_SECONDS * 1000;
  const left = () => Math.max(0, Math.min(total, Date.parse(until) - Date.now()));
  const [running, setRunning] = useState(false);
  const startLeft = useRef(left());
  // One frame at the share left, then a CSS transition to 0 over the time left.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRunning(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const style = running
    ? { width: '0%', transition: `width ${startLeft.current}ms linear` }
    : { width: `${(startLeft.current / total) * 100}%`, transition: 'none' };
  return <span className="prog" style={style} aria-hidden="true" />;
}

/** Shows the Undo send toast for a send just queued. */
export function useUndoSend(): { show(r: UndoShow): void } {
  return useContext(UndoSendContext);
}
