import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import type { EducationEntry, ExperienceEntry } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useUpdateContactProfile } from '../../api/contacts';
import type { LeadFull } from '../../api/leads';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

type Contact = NonNullable<LeadFull['contact']>;
type XpRow = { title: string; company: string; from: string; to: string; description: string };
type EduRow = { school: string; degree: string; from: string; to: string };
type Values = { headline: string; location: string; about: string; experience: XpRow[]; education: EduRow[] };

const blankXp: XpRow = { title: '', company: '', from: '', to: '', description: '' };
const blankEdu: EduRow = { school: '', degree: '', from: '', to: '' };
const filled = (o: Record<string, string>) => Object.values(o).some((v) => v.trim() !== '');

/**
 * "Edit profile" on the lead page: the contact's LinkedIn-style profile (headline, location, about, experience and
 * education rows), saved with PATCH /contacts/:id. Blank rows are dropped; a role with no end date is current.
 */
export function EditProfileModal({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const save = useUpdateContactProfile();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, control, handleSubmit, formState } = useForm<Values>({
    defaultValues: {
      headline: contact.headline ?? '',
      location: contact.location ?? '',
      about: contact.about ?? '',
      experience: (contact.experience ?? []).map((e) => ({ ...e, to: e.to ?? '', description: e.description ?? '' })),
      education: (contact.education ?? []).map((e) => ({ ...e })),
    },
  });
  const xp = useFieldArray({ control, name: 'experience' });
  const edu = useFieldArray({ control, name: 'education' });
  const { errors } = formState;

  function submit(v: Values) {
    setFormError(null);
    const experience: ExperienceEntry[] = v.experience.filter(filled).map((e) => ({
      title: e.title.trim(), company: e.company.trim(), from: e.from.trim(), to: e.to.trim() || null,
      description: e.description.trim() || null,
    }));
    const education: EducationEntry[] = v.education.filter(filled).map((e) => ({
      school: e.school.trim(), degree: e.degree.trim(), from: e.from.trim(), to: e.to.trim(),
    }));
    if (experience.some((e) => !e.title || !e.company || !e.from)) return setFormError(t('Each role needs a job title, a company and a start'));
    if (education.some((e) => !e.school || !e.degree || !e.from || !e.to)) return setFormError(t('Each school needs a name, a degree, a start and an end'));
    // Current role first, then newest start first (as the prototype sorts them).
    experience.sort((a, b) => (!a.to && b.to ? -1 : a.to && !b.to ? 1 : b.from.localeCompare(a.from)));
    save.mutate(
      {
        id: contact.id,
        updatedAt: contact.updatedAt,
        profile: { headline: v.headline.trim() || null, location: v.location.trim() || null, about: v.about.trim() || null, experience, education },
      },
      {
        onSuccess: () => {
          toast(t('Profile saved'));
          onClose();
        },
        onError: (err) => setFormError(errorText(t, err instanceof ApiError ? err.code : 'unknown')),
      },
    );
  }

  return (
    <Modal
      title={t('Edit profile · {name}', { name: contact.name })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="profile-form" className="btn primary" disabled={save.isPending}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form id="profile-form" noValidate className="grid2" onSubmit={(e) => void handleSubmit(submit)(e)}>
        <FormField id="pf-headline" label={t('Headline (as on LinkedIn)')} className="span2" error={errors.headline ? t('Up to 200 characters') : undefined}>
          <input id="pf-headline" className="in" {...register('headline', { maxLength: 200 })} />
        </FormField>
        <FormField id="pf-location" label={t('Location')} className="span2" error={errors.location ? t('Up to 200 characters') : undefined}>
          <input id="pf-location" className="in" {...register('location', { maxLength: 200 })} />
        </FormField>
        <FormField id="pf-about" label={t('About')} className="span2" error={errors.about ? t('Up to 5000 characters') : undefined}>
          <textarea id="pf-about" className="in" rows={4} {...register('about', { maxLength: 5000 })} />
        </FormField>
        <fieldset className="span2 bare">
          <legend className="lbl">{t('Experience')}</legend>
          {xp.fields.map((f, i) => (
            <div key={f.id} className="xprow">
              <input className="in" aria-label={t('Job title')} placeholder={t('Job title')} {...register(`experience.${i}.title`)} />
              <input className="in" aria-label={t('Company')} placeholder={t('Company')} {...register(`experience.${i}.company`)} />
              <input className="in" aria-label={t('From year')} placeholder={t('From')} {...register(`experience.${i}.from`)} />
              <input className="in" aria-label={t('To year, blank if current')} placeholder={t('To · blank = current')} {...register(`experience.${i}.to`)} />
              <button type="button" className="btn xs" aria-label={t('Remove this role')} title={t('Remove this role')} onClick={() => xp.remove(i)}>
                ✕
              </button>
              <input className="in xp-desc" aria-label={t('Description')} placeholder={t('Description (optional)')} {...register(`experience.${i}.description`)} />
            </div>
          ))}
          <button type="button" className="btn xs" disabled={xp.fields.length >= 20} onClick={() => xp.append({ ...blankXp })}>
            {t('+ Add role')}
          </button>
        </fieldset>
        <fieldset className="span2 bare">
          <legend className="lbl">{t('Education')}</legend>
          {edu.fields.map((f, i) => (
            <div key={f.id} className="xprow edu">
              <input className="in" aria-label={t('School')} placeholder={t('School')} {...register(`education.${i}.school`)} />
              <input className="in" aria-label={t('Degree')} placeholder={t('Degree')} {...register(`education.${i}.degree`)} />
              <input className="in" aria-label={t('From year')} placeholder={t('From')} {...register(`education.${i}.from`)} />
              <input className="in" aria-label={t('To year')} placeholder={t('To')} {...register(`education.${i}.to`)} />
              <button type="button" className="btn xs" aria-label={t('Remove this school')} title={t('Remove this school')} onClick={() => edu.remove(i)}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn xs" disabled={edu.fields.length >= 10} onClick={() => edu.append({ ...blankEdu })}>
            {t('+ Add school')}
          </button>
        </fieldset>
        {formError ? (
          <div className="span2 note warn" role="alert">
            {formError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
