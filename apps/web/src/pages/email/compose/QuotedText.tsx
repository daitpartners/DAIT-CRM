import { useState } from 'react';
import { useT } from '../../../i18n/useT';
import { MailBody } from '../MailBody';

/**
 * A reply's or forward's folded quote (mockup `.quoted-tog` / `.quoted`): the `…` toggle, and when open the quote as
 * the reader shows mail, in the sandboxed auto-height frame (nothing in it runs). The user does not edit it: the server
 * keeps it and adds it under the user's part on every save.
 */
export function QuotedText({ html }: { html: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="quoted-tog" title={t('Show quoted text')} aria-label={t('Show quoted text')} aria-expanded={open} onClick={() => setOpen(!open)}>
        …
      </button>
      {open ? (
        <div className="quoted">
          <MailBody html={html} text="" autoHeight />
        </div>
      ) : null}
    </>
  );
}
