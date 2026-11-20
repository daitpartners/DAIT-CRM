import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, useUsers, type UserSummary } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icons } from '../../components/Icons';
import { Table } from '../../components/Table';
import { useToast } from '../../components/Toast';
import { LANGUAGE_NAMES, errorText, roleText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { UserModal } from './UserModal';

export function Users() {
  const me = useCurrentUser();
  if (!me.can('manage_users')) return <AccessDenied />;
  return <UsersTable />;
}

function UsersTable() {
  const t = useT();
  const me = useCurrentUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: users, isPending, error } = useUsers();
  const [editing, setEditing] = useState<UserSummary | 'new' | null>(null);

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) => api<UserSummary>(`/api/users/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: async (u) => {
      await qc.invalidateQueries({ queryKey: keys.users });
      toast(u.isActive ? t('{name} reactivated', { name: u.name }) : t('{name} deactivated', { name: u.name }));
    },
    onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
  });

  async function toggle(u: UserSummary) {
    const ok = await confirm(
      u.isActive
        ? { title: t('Deactivate user?'), body: t('{name} will no longer be able to sign in. Their records are kept.', { name: u.name }), confirmLabel: t('Deactivate'), danger: true }
        : { title: t('Reactivate user?'), body: t('{name} will be able to sign in again.', { name: u.name }), confirmLabel: t('Reactivate') },
    );
    if (ok) setActive.mutate({ id: u.id, isActive: !u.isActive });
  }

  const fmt = (d: string | null) => (d ? formatDate(d, { locale: me.language, timezone: me.timezone, dateFormat: me.dateFormat }) : t('Never'));

  return (
    <section className="card flush" aria-labelledby="users-title">
      <div className="head">
        <h2 id="users-title">{t('Users')}</h2>
        <div className="grow" />
        <button type="button" className="btn primary sm" onClick={() => setEditing('new')}>
          {Icons.plus}
          {t('Add user')}
        </button>
      </div>
      {error ? (
        <div className="empty" role="alert">{errorText(t, error instanceof ApiError ? error.code : 'unknown')}</div>
      ) : (
        <Table
          head={[t('Name'), t('Email'), t('Role'), t('Language'), t('Status'), t('Last sign-in'), <span className="sr">{t('Actions')}</span>]}
          isEmpty={isPending || !users?.length}
          empty={isPending ? t('Loading…') : t('No users yet')}
        >
          {users?.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{roleText(t, u.role)}</td>
              <td>{LANGUAGE_NAMES[u.language] ?? u.language}</td>
              <td>{u.isActive ? <span className="badge b-ok">{t('Active')}</span> : <span className="badge b-grey">{t('Inactive')}</span>}</td>
              <td>{fmt(u.lastLoginAt)}</td>
              <td>
                <div className="row-actions">
                  <button type="button" className="btn xs" onClick={() => setEditing(u)} aria-label={t('Edit {name}', { name: u.name })}>
                    {t('Edit')}
                  </button>
                  <button
                    type="button"
                    className={u.isActive ? 'btn xs danger' : 'btn xs'}
                    onClick={() => toggle(u)}
                    disabled={u.id === me.id && u.isActive}
                    title={u.id === me.id && u.isActive ? t('You cannot deactivate your own account') : undefined}
                  >
                    {u.isActive ? t('Deactivate') : t('Reactivate')}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing ? <UserModal user={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}
