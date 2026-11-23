import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import { keys, useAuthOptions } from '../api/queries';
import { FormField } from '../components/FormField';
import { errorText } from '../i18n/labels';
import { useT } from '../i18n/useT';
import { MicrosoftLogo } from './settings/MicrosoftLogo';

export function SignIn() {
  const t = useT();
  const [params] = useSearchParams();
  const { data: options } = useAuthOptions();
  const notRegistered = params.get('error') === 'not-registered';

  return (
    <div className="signin">
      <section className="card" aria-labelledby="signin-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img className="mark" src="/logo-mark.svg" alt="" />
          <div>
            <h1 id="signin-title">{t('DAIT Partners CRM')}</h1>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{t('Sign in to continue')}</div>
          </div>
        </div>
        {notRegistered ? (
          <div className="note warn" role="alert">
            {t('Your Microsoft account is not registered for this CRM. Ask an administrator.')}
          </div>
        ) : null}
        {/* The Microsoft logo, as on the Settings connect buttons (review #30). */}
        <a className="btn primary ms-signin" href="/api/auth/microsoft">
          <span className="ms-tile"><MicrosoftLogo /></span>
          {t('Sign in with Microsoft')}
        </a>
        {options?.localLogin ? <LocalForm /> : null}
        {options?.testLogin ? <TestForm /> : null}
      </section>
    </div>
  );
}

function useAfterSignIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await qc.invalidateQueries({ queryKey: keys.me });
    navigate('/', { replace: true });
  };
}

function LocalForm() {
  const t = useT();
  const done = useAfterSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<void>('/api/auth/local', { method: 'POST', body: { email, password } });
      await done();
    } catch (err) {
      setError(errorText(t, err instanceof ApiError ? err.code : 'unknown'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="divider">{t('Local administrator')}</div>
      <form onSubmit={submit} noValidate>
        <FormField id="local-email" label={t('Email')} required>
          <input id="local-email" className="in" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <FormField id="local-password" label={t('Password')} required error={error ?? undefined}>
          <input
            id="local-password"
            className="in"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            aria-describedby={error ? 'local-password-err' : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </FormField>
        <button type="submit" className="btn" disabled={busy || !email || !password}>
          {t('Sign in')}
        </button>
      </form>
    </>
  );
}

function TestForm() {
  const t = useT();
  const done = useAfterSignIn();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api<void>('/api/auth/test-login', { method: 'POST', body: { email } });
      await done();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_found' ? t('No active user with that email') : errorText(t, err instanceof ApiError ? err.code : 'unknown'));
    }
  }

  return (
    <>
      <div className="divider">{t('Development only')}</div>
      <form onSubmit={submit} noValidate>
        <FormField id="test-email" label={t('Test sign-in email')} error={error ?? undefined}>
          <input id="test-email" className="in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <button type="submit" className="btn" disabled={!email}>
          {t('Test sign-in')}
        </button>
      </form>
    </>
  );
}
