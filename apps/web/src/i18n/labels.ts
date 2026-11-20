/* Translated display labels for fixed enums. Each phrase is a literal t() call so scripts/i18n-check.ts sees it. */
import type { LookupGroup, Role } from '@dait-crm/shared';
import type { Lang } from '../api/queries';
import type { TFn } from './useT';

export function roleText(t: TFn, role: Role): string {
  switch (role) {
    case 'Administrator':
      return t('Administrator');
    case 'Manager':
      return t('Manager');
    case 'Sales Representative':
      return t('Sales Representative');
    case 'Data Research User':
      return t('Data Research User');
    default:
      return role;
  }
}

/** Language names are shown in their own language so a user can always find theirs. */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', es: 'Español', fr: 'Français' };

export function groupText(t: TFn, group: LookupGroup): string {
  const labels: Record<LookupGroup, string> = {
    lead_source: t('Lead source'),
    lead_status: t('Lead status'),
    lead_type: t('Lead type'),
    priority: t('Priority'),
    country: t('Country'),
    industry: t('Industry'),
    business_category: t('Business category'),
    business_type: t('Business type'),
    employee_range: t('Employee range'),
    revenue_range: t('Revenue range'),
    ownership_type: t('Ownership type'),
    contact_type: t('Contact type'),
    location_type: t('Location type'),
    quote_status: t('Quote status'),
    currency: t('Currency'),
  };
  return labels[group] ?? group;
}

/** Friendly text for API error codes. */
export function errorText(t: TFn, code: string): string {
  switch (code) {
    case 'email_taken':
      return t('That email is already in use');
    case 'cannot_deactivate_self':
      return t('You cannot deactivate your own account');
    case 'last_administrator':
      return t('There must always be at least one active administrator');
    case 'duplicate_value':
      return t('That value already exists in this list');
    case 'unknown_user':
      return t('One of the chosen users is not an active user');
    case 'invalid_credentials':
      return t('Email or password is incorrect');
    case 'forbidden':
      return t('You do not have access');
    case 'not_found':
      return t('Not found');
    case 'job_running':
      return t('That email is being sent right now');
    case 'validation':
      return t('Please check the highlighted fields');
    default:
      return t('Something went wrong. Please try again.');
  }
}

export function initials(name: string): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
