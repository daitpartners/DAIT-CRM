import { useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROLES, UserCreate, UserUpdate } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, type Lang, type UserSummary } from '../../api/queries';
import { Combobox } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { LANGUAGE_NAMES, errorText, roleText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { applyServerIssues } from '../../forms/applyServerIssues';
import { timezoneOptions } from './timezones';

type Props = { user?: UserSummary; onClose: () => void };
const FIELDS = ['email', 'name', 'role', 'language', 'timezone'] as const;
type Values = { email: string; name: string; role: (typeof ROLES)[number]; language: Lang; timezone: string };

/** Add (no `user`) or edit a user. Validation uses the shared UserCreate / UserUpdate schemas. */
export function UserModal({ user, onClose }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const editing = Boolean(user);

  const { register, handleSubmit, control, setError, formState } = useForm<Values>({
    // The shared schemas also normalise (trim, lower-case email); their input type is wider than Values.
    resolver: zodResolver(editing ? UserUpdate : UserCreate) as unknown as Resolver<Values>,
    defaultValues: {
      email: user?.email ?? '',
      name: user?.name ?? '',
      role: user?.role ?? 'Sales Representative',
      language: user?.language ?? 'en',
      timezone: user?.timezone ?? 'Europe/London',
    },
  });
  const { errors } = formState;

  const save = useMutation({
    mutationFn: (v: Values) =>
      user
        ? api<UserSummary>(`/api/users/${user.id}`, { method: 'PATCH', body: v })
        : api<UserSummary>('/api/users', { method: 'POST', body: v }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.users });
      toast(editing ? t('User updated') : t('User added'));
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'email_taken') {
        setError('email', { type: 'server', message: errorText(t, err.code) });
        return;
      }
      setFormError(applyServerIssues(err, FIELDS, setError, t, fieldMessage).formMessage);
    },
  });

  function fieldMessage(field: keyof Values): string {
    switch (field) {
      case 'email':
        return t('Enter a valid email address');
      case 'name':
        return t('Enter a name');
      case 'timezone':
        return t('Choose a time zone');
      default:
        return t('Choose a value');
    }
  }

  const err = (f: keyof Values) => (errors[f] ? (errors[f]?.type === 'server' ? errors[f]?.message : fieldMessage(f)) : undefined);

  return (
    <Modal
      title={editing ? t('Edit user') : t('Add user')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="user-form" className="btn primary" disabled={save.isPending}>
            {editing ? t('Save') : t('Add user')}
          </button>
        </>
      }
    >
      <form id="user-form" noValidate onSubmit={handleSubmit((v) => save.mutate(v))} className="grid2">
        <FormField id="user-name" label={t('Name')} required error={err('name')}>
          <input id="user-name" className={errors.name ? 'in err' : 'in'} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'user-name-err' : undefined} {...register('name')} />
        </FormField>
        <FormField id="user-email" label={t('Email')} required error={err('email')}>
          <input id="user-email" type="email" className={errors.email ? 'in err' : 'in'} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'user-email-err' : undefined} {...register('email')} />
        </FormField>
        <FormField id="user-role" label={t('Role')} required error={err('role')}>
          <select id="user-role" className="in" {...register('role')}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleText(t, r)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="user-language" label={t('Language')} error={err('language')}>
          <select id="user-language" className="in" {...register('language')}>
            {(Object.keys(LANGUAGE_NAMES) as Lang[]).map((l) => (
              <option key={l} value={l} lang={l}>
                {LANGUAGE_NAMES[l]}
              </option>
            ))}
          </select>
        </FormField>
        <div className="span2">
          <Controller
            control={control}
            name="timezone"
            render={({ field }) => (
              <Combobox id="user-timezone" label={t('Time zone')} options={timezoneOptions(field.value)} value={field.value} onChange={field.onChange} required />
            )}
          />
          {errors.timezone ? <div className="err-msg" role="alert">{err('timezone')}</div> : null}
        </div>
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
