import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { IMPORT_EXTENSIONS, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES, type LeadType, type OutreachLanguage } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import { useBatchFiles, useCreateBatch, useImportOptions, useRemoveFile, useUploadFile, type AllocationLine } from '../../../api/imports';
import { useLang, useT, type TFn } from '../../../i18n/useT';
import { fileBadge, fileLogo, fileMetaText, importErrorText } from '../labels';

/** The step-1 alert: the missing choices (worded from what is still missing), or a message; `flash` replays the flash. */
export type Step1Alert =
  | { kind: 'choices'; flash: number }
  | { kind: 'noFile'; flash: number }
  | { kind: 'text'; text: string; flash: number };

type Props = {
  batchId: number | null;
  /** Files can be removed only while the batch is Uploading (before Sort); null before the batch exists or loads. */
  batchStatus?: string | null;
  language: OutreachLanguage | null;
  leadType: LeadType | null;
  alert: Step1Alert | null;
  busy: boolean;
  onChoose: (patch: { language?: OutreachLanguage; leadType?: LeadType }) => void;
  onCreated: (batchId: number) => void;
  onRefused: () => void;
  onNext: () => void;
};

/** Step-1 choices still missing (nothing is chosen by default). */
export function missingChoices(language: string | null, leadType: string | null): ('language' | 'leadType')[] {
  return [...(language ? [] : ['language' as const]), ...(leadType ? [] : ['leadType' as const])];
}

/** "Choose … before continuing.", naming only what is still missing. */
export function choicesAlertText(t: TFn, missing: ('language' | 'leadType')[]): string {
  if (missing.length === 2) {
    return t('Choose the outreach language (English or Spanish) and whether to import them as Prospects or Leads before continuing.');
  }
  return missing[0] === 'language'
    ? t('Choose the outreach language (English or Spanish) before continuing.')
    : t('Choose whether to import them as Prospects or Leads before continuing.');
}

/** Files refused before upload: too many, too large, or of another type (each with its own message). */
export function refuseFiles(t: TFn, picked: File[], already: number): { ok: File[]; problems: string[] } {
  if (already + picked.length > IMPORT_MAX_FILES) return { ok: [], problems: [t('Up to 10 files per import.')] };
  const ok: File[] = [];
  const problems: string[] = [];
  for (const f of picked) {
    const ext = f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : '';
    if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      problems.push(t('{name}: only .xlsx .xls .csv .pdf .docx .txt files can be imported.', { name: f.name }));
    } else if (f.size > IMPORT_MAX_FILE_BYTES) {
      problems.push(t('{name} is larger than 20 MB.', { name: f.name }));
    } else ok.push(f);
  }
  return { ok, problems };
}

const rulesText = (rules: AllocationLine[] | undefined) =>
  (rules ?? []).map((r) => (r.people.length ? `${r.name} · ${r.people.join(', ')}` : r.name)).join('; ');

/** Step 1 (mockup #s1): outreach language and Import as (nothing pre-selected), then the files. */
export function StepUpload({ batchId, batchStatus = null, language, leadType, alert, busy, onChoose, onCreated, onRefused, onNext }: Props) {
  const t = useT();
  const lang = useLang();
  const { data: options } = useImportOptions();
  const { data: files } = useBatchFiles(batchId);
  const create = useCreateBatch();
  const upload = useUploadFile();
  const remove = useRemoveFile();
  // Hidden once the data is sorted (the server refuses then); shown while the batch status is still loading.
  const canRemove = batchId !== null && (batchStatus === null || batchStatus === 'Uploading');
  const [problems, setProblems] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set at once (state lags a render): a second drop while the first is uploading never makes a second batch.
  const busyRef = useRef(false);
  const langErrId = useId();
  const typeErrId = useId();
  const alertRef = useRef<HTMLDivElement>(null);
  const missing = missingChoices(language, leadType);
  const showChoices = alert?.kind === 'choices' && missing.length > 0;
  const alertText =
    alert?.kind === 'text' ? alert.text
    : alert?.kind === 'noFile' ? t('Add at least one file the CRM can read.')
    : showChoices ? choicesAlertText(t, missing) : null;

  // The app's error styles flash once each time the alert is raised (as the mockup).
  useEffect(() => {
    const el = alertRef.current;
    if (!el) return;
    el.animate?.([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 900 });
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [alert?.flash]);

  const rules = (value: string) => rulesText(options?.languages.find((l) => l.value === value)?.rules);

  async function addFiles(picked: File[]) {
    if (inputRef.current) inputRef.current.value = '';
    if (picked.length === 0 || busyRef.current) return;
    if (!language || !leadType) {
      onRefused();
      return;
    }
    const { ok, problems: refused } = refuseFiles(t, picked, files?.items.length ?? 0);
    setProblems(refused);
    if (ok.length === 0) return;
    busyRef.current = true;
    setUploading(true);
    try {
      let id = batchId;
      if (id === null) {
        const made = await create.mutateAsync({ language, leadType });
        id = made.id;
        onCreated(id);
      }
      const failed: string[] = [];
      for (const file of ok) {
        try {
          await upload.mutateAsync({ batchId: id, file });
        } catch (e) {
          failed.push(`${file.name}: ${importErrorText(t, e instanceof ApiError ? e.code : '')}`);
        }
      }
      if (failed.length) setProblems((p) => [...p, ...failed]);
    } catch (e) {
      setProblems((p) => [...p, importErrorText(t, e instanceof ApiError ? e.code : '')]);
    } finally {
      busyRef.current = false;
      setUploading(false);
    }
  }

  /** "Remove {name}": no confirm (nothing is saved to the CRM until step 4); the list refreshes and frees a place. */
  function removeFile(fileId: number, name: string) {
    if (batchId === null) return;
    setProblems([]);
    remove.mutate(
      { batchId, fileId },
      { onError: (e) => setProblems([`${name}: ${importErrorText(t, e instanceof ApiError ? e.code : '')}`]) },
    );
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (uploading) return;
    void addFiles([...e.dataTransfer.files]);
  }

  const radio = <V extends string>(name: string, value: V, current: V | null, title: string, hint: string, pick: (v: V) => void) => (
    <label key={value} className={current === value ? 'radio-card on' : 'radio-card'}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => pick(value)} />
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
    </label>
  );

  return (
    <section className="wiz" aria-label={t('Step 1 of 4: Upload')}>
      <p className="muted-text">{t('Step 1 of 4 · Language and files')}</p>
      <div className="grid2">
        <div className="card">
          <h2>{t('Outreach language')}</h2>
          <p className="muted-text">
            {t('Every lead in this import gets this language. It decides who they are allocated to and which templates are used.')}{' '}
            <b>{t('Choose one; nothing is pre-selected.')}</b>
          </p>
          <fieldset
            className="radio-group"
            aria-invalid={showChoices && !language ? true : undefined}
            aria-describedby={showChoices && !language ? langErrId : undefined}
          >
            <legend className="sr">{t('Outreach language')}</legend>
            <div className="grid2">
              {radio('imp-lang', 'en' as OutreachLanguage, language, t('English leads'), rules('en'), (v) => onChoose({ language: v }))}
              {radio('imp-lang', 'es' as OutreachLanguage, language, t('Spanish leads (Español)'), rules('es'), (v) => onChoose({ language: v }))}
            </div>
            {showChoices && !language ? <div id={langErrId} className="err-msg">{t('Choose English or Spanish.')}</div> : null}
          </fieldset>
          <h3>{t('Import as')}</h3>
          <fieldset
            className="radio-group"
            aria-invalid={showChoices && !leadType ? true : undefined}
            aria-describedby={showChoices && !leadType ? typeErrId : undefined}
          >
            <legend className="sr">{t('Import as')}</legend>
            <div className="grid2">
              {radio('imp-type', 'Prospect' as LeadType, leadType, t('Prospects'), t('Researched companies, not yet contacted'), (v) => onChoose({ leadType: v }))}
              {radio('imp-type', 'Lead' as LeadType, leadType, t('Leads'), t('Already showed interest'), (v) => onChoose({ leadType: v }))}
            </div>
            {showChoices && !leadType ? <div id={typeErrId} className="err-msg">{t('Choose Prospects or Leads.')}</div> : null}
          </fieldset>
        </div>
        <div className="card">
          <h2>{t('Files')}</h2>
          <p className="muted-text">
            {t('Excel, CSV, PDF, Word or plain text. Data can be messy: tables, lists, business cards pasted into a document, a trade-show PDF.')}
          </p>
          <div className="file-pick" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <input
              ref={inputRef}
              id="imp-files"
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.pdf,.docx,.txt"
              disabled={uploading}
              onChange={(e) => void addFiles([...(e.target.files ?? [])])}
            />
            <label htmlFor="imp-files" className="btn sm">
              {t('Choose files')}
            </label>
            <span className="dim">{t('or drag files here · .xlsx .xls .csv .pdf .docx .txt · up to 20 MB each · up to 10 files')}</span>
          </div>
          {problems.length ? (
            <div className="note danger" role="alert">
              {problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          ) : null}
          {files?.items.length ? (
            <ul className="conn-list">
              {files.items.map((f) => {
                const badge = fileBadge(t, f.status);
                return (
                  <li key={f.id} className="conn-row">
                    <span className="conn-logo">{fileLogo(f.ext)}</span>
                    <div className="conn-main">
                      <div className="conn-addr">{f.name}</div>
                      <div className="conn-meta">{fileMetaText(t, f, lang)}</div>
                    </div>
                    <span className={`badge ${badge.cls}`}>{badge.text}</span>
                    {canRemove ? (
                      <button
                        type="button"
                        className="btn xs"
                        aria-label={t('Remove {item}', { item: f.name })}
                        title={t('Remove {item}', { item: f.name })}
                        disabled={uploading || (remove.isPending && remove.variables?.fileId === f.id)}
                        onClick={() => removeFile(f.id, f.name)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
      {alertText ? (
        <div className="note danger" role="alert" ref={alertRef}>
          {alertText}
        </div>
      ) : null}
      <div className="actions-row">
        <span className="muted-text">{t('Nothing is saved to the CRM until step 4.')}</span>
        <span className="grow" />
        <button type="button" className="btn primary" disabled={busy || uploading} onClick={onNext}>
          {t('Sort the data →')}
        </button>
      </div>
    </section>
  );
}
