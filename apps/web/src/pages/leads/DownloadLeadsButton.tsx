import { useState } from 'react';
import { LEADS_EXPORT_MAX } from '@dait-crm/shared';
import { leadsExportPath, type LeadListQuery } from '../../api/leads';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/useT';

/** The file name the server sent (`filename="leads-2026-11-24.xlsx"`), else a dated default. */
function fileNameOf(res: Response): string {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  return m?.[1] ?? `leads-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

/**
 * "Download all leads" (Leads page, next to Import leads; users with `import_leads`): every lead matching the list's
 * current tab, filters and search, as Excel, to complete by hand and upload again through Import leads. More than
 * LEADS_EXPORT_MAX leads → a message to narrow the filter.
 */
export function DownloadLeadsButton({ query }: { query: LeadListQuery }) {
  const t = useT();
  const me = useCurrentUser();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!me.can('import_leads')) return null;

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(leadsExportPath(query), { credentials: 'same-origin' });
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; total?: number };
        if (body.error === 'too_many_rows') {
          toast(t('{n} leads match: more than {max} cannot be downloaded at once. Narrow the filter and try again.', {
            n: (body.total ?? 0).toLocaleString(), max: LEADS_EXPORT_MAX.toLocaleString(),
          }), 'warn');
          return;
        }
      }
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = fileNameOf(res);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast(t('Something went wrong. Try again.'), 'warn');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" disabled={busy} onClick={() => void download()} title={t('Every lead matching the current filters, as Excel, to complete and upload again through Import leads')}>
      {t('Download all leads')}
    </button>
  );
}
