import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { safeUrl } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { contactName, useContacts, useSaveContact, type ContactSummary } from '../../../api/contacts';
import { keys, useLookupText } from '../../../api/queries';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Icons } from '../../../components/Icons';
import { Pager } from '../../../components/Pager';
import { Table } from '../../../components/Table';
import { useToast } from '../../../components/Toast';
import { errorText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import { ContactModal } from '../ContactModal';
import { MoveContactModal } from '../MoveContactModal';

const PAGE_SIZE = 25;

type Props = { company: CompanyDetail; canManage: boolean };

/**
 * The company's contacts: add, edit, promote one to primary (a company with active contacts always has
 * exactly one), deactivate / reactivate, and move to another company. Inactive contacts are listed
 * only with "Show inactive" on.
 */
export function ContactsTab({ company, canManage }: Props) {
  const t = useT();
  const lang = useLang();
  const lookup = useLookupText(lang);
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [showInactive, setShowInactive] = useState(false);
  const { data, isPending, error } = useContacts({
    companyId: company.id, page, pageSize: PAGE_SIZE, sort: 'lastName', dir: 'asc', inactive: showInactive ? '1' : undefined,
  });
  const save = useSaveContact();
  // undefined = closed; null = adding; a contact = editing it.
  const [editing, setEditing] = useState<ContactSummary | null | undefined>(undefined);
  const [moving, setMoving] = useState<ContactSummary | null>(null);
  const closed = company.status === 'Closed';

  // Rows removed since (or an old page): step back to the last page that has rows.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
  }, [data, page]);

  function onFail(err: unknown) {
    const code = err instanceof ApiError ? err.code : 'unknown';
    // Someone else changed this contact: refetch so a retry carries the fresh updatedAt.
    if (code === 'stale') {
      void qc.invalidateQueries({ queryKey: keys.contactsAll });
      void qc.invalidateQueries({ queryKey: keys.companiesAll });
    }
    toast(errorText(t, code), 'warn');
  }

  async function makePrimary(c: ContactSummary) {
    const ok = await confirm({
      title: t('Make primary contact?'),
      body: t('{name} will become the primary contact for {company}.', { name: contactName(c), company: company.name }),
      confirmLabel: t('Make primary'),
    });
    if (!ok) return;
    save.mutate(
      { id: c.id, body: { isPrimary: true, updatedAt: c.updatedAt } },
      { onSuccess: () => toast(t('{name} is now the primary contact', { name: contactName(c) })), onError: onFail },
    );
  }

  async function setActive(c: ContactSummary, isActive: boolean) {
    const name = contactName(c);
    const ok = await confirm(
      isActive
        ? { title: t('Reactivate contact?'), body: t('{name} will be offered in contact pickers again.', { name }), confirmLabel: t('Reactivate') }
        : {
            title: t('Deactivate contact?'),
            body: t('{name} will no longer be offered in contact pickers. Leads keep their history.', { name }),
            confirmLabel: t('Deactivate'),
            danger: true,
          },
    );
    if (!ok) return;
    save.mutate(
      { id: c.id, body: { isActive, updatedAt: c.updatedAt } },
      {
        onSuccess: () => toast(isActive ? t('{name} reactivated', { name }) : t('{name} deactivated', { name })),
        onError: onFail,
      },
    );
  }

  const dim = <span className="dim">—</span>;
  const head = [t('Name'), t('Designation'), t('Email'), t('Phone'), t('Type'), t('Primary'), ...(canManage ? [<span className="sr">{t('Actions')}</span>] : [])];
  const rows = data?.items;

  return (
    <section className="card flush" aria-labelledby="contacts-title">
      <div className="head">
        <h2 id="contacts-title">{t('Contacts at {company}', { company: company.name })}</h2>
        <div className="grow" />
        <label className="check">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => {
              setShowInactive(e.target.checked);
              setPage(1);
            }}
          />
          {t('Show inactive')}
        </label>
        {canManage ? (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => setEditing(null)}
            disabled={closed}
            title={closed ? errorText(t, 'company_inactive') : undefined}
          >
            {Icons.plus}
            {t('Add contact')}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="empty" role="alert">
          {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
        </div>
      ) : (
        <Table head={head} isEmpty={isPending || !rows?.length} empty={isPending ? t('Loading…') : t('No contacts yet')}>
          {rows?.map((c) => {
            const linkedin = safeUrl(c.linkedinUrl);
            const mail = c.businessEmail ? safeUrl(`mailto:${c.businessEmail}`) : null;
            return (
              <tr key={c.id}>
                <td>
                  <strong>{contactName(c)}</strong>
                  {!c.isActive ? (
                    <>
                      {' '}
                      <span className="badge b-grey">{t('Inactive')}</span>
                    </>
                  ) : null}
                  {c.department || linkedin ? (
                    <span className="cell-sub">
                      {c.department}
                      {c.department && linkedin ? ' · ' : null}
                      {linkedin ? (
                        <a href={linkedin} target="_blank" rel="noopener noreferrer">
                          LinkedIn
                        </a>
                      ) : null}
                    </span>
                  ) : null}
                </td>
                <td>{c.designation ?? dim}</td>
                <td>{c.businessEmail ? mail ? <a href={mail}>{c.businessEmail}</a> : c.businessEmail : dim}</td>
                <td>
                  {c.phone ?? c.mobile ?? dim}
                  {c.phone && c.mobile ? <span className="cell-sub">{t('Mobile: {number}', { number: c.mobile })}</span> : null}
                </td>
                <td>{lookup('contact_type', c.contactType)}</td>
                <td>{c.isPrimary ? <span className="badge b-ok">{t('Primary')}</span> : dim}</td>
                {canManage ? (
                  <td>
                    <div className="row-actions">
                      {!c.isPrimary && c.isActive ? (
                        <button
                          type="button"
                          className="btn xs"
                          disabled={save.isPending}
                          onClick={() => void makePrimary(c)}
                          aria-label={t('Make {name} primary', { name: contactName(c) })}
                        >
                          {t('Make primary')}
                        </button>
                      ) : null}
                      <button type="button" className="btn xs" onClick={() => setEditing(c)} aria-label={t('Edit {name}', { name: contactName(c) })}>
                        {t('Edit')}
                      </button>
                      <button
                        type="button"
                        className="btn xs"
                        onClick={() => setMoving(c)}
                        aria-label={t('Move {name}', { name: contactName(c) })}
                      >
                        {t('Move…')}
                      </button>
                      <button
                        type="button"
                        className="btn xs"
                        disabled={save.isPending}
                        onClick={() => void setActive(c, !c.isActive)}
                        aria-label={c.isActive ? t('Deactivate {name}', { name: contactName(c) }) : t('Reactivate {name}', { name: contactName(c) })}
                      >
                        {c.isActive ? t('Deactivate') : t('Reactivate')}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </Table>
      )}
      {data && data.total > PAGE_SIZE ? (
        <div className="foot">
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </div>
      ) : null}
      {editing !== undefined ? (
        <ContactModal companyId={company.id} contact={editing ?? undefined} onClose={() => setEditing(undefined)} />
      ) : null}
      {moving ? <MoveContactModal contact={moving} onClose={() => setMoving(null)} /> : null}
    </section>
  );
}
