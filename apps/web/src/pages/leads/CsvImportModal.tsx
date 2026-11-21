import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CSV_FIELDS, CSV_MAX_LENGTH, lookupLabel, type CsvField } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useCsvImport, useCsvPreview, type CsvImportResult, type CsvMapping, type CsvPreviewResult } from '../../api/leads';
import { useLookups, useUsers } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { FormField } from '../../components/FormField';
import { Modal } from '../../components/Modal';
import { errorText } from '../../i18n/labels';
import { useLang, useT, type TFn } from '../../i18n/useT';

const REQUIRED: CsvField[] = ['companyName', 'country'];

function fieldText(t: TFn, f: CsvField): string {
  switch (f) {
    case 'companyName':
      return t('Company name');
    case 'website':
      return t('Website');
    case 'businessEmail':
      return t('Business email');
    case 'phone':
      return t('Phone number');
    case 'country':
      return t('Country');
    case 'city':
      return t('City');
    case 'contactFirstName':
      return t('Contact first name');
    case 'contactLastName':
      return t('Contact last name');
    case 'contactEmail':
      return t('Contact email');
    case 'leadSource':
      return t('Lead source');
    case 'priority':
      return t('Priority');
    case 'notes':
      return t('Notes');
    case 'sourceUrl':
      return t('Source URL');
    default:
      return f;
  }
}

function failure(t: TFn, err: unknown): string {
  if (err instanceof ApiError && err.status === 413) return t('The file is too large: 5 MB at most');
  return errorText(t, err instanceof ApiError ? err.code : 'unknown');
}

/**
 * CSV import of prospects in three steps: (1) paste or choose a file → preview; (2) map a CSV column to
 * each lead field; (3) the result, with rows awaiting a company decision linking to their lead.
 */
export function CsvImportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const preview = useCsvPreview();
  const run = useCsvImport();
  const [csv, setCsv] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [parsed, setParsed] = useState<CsvPreviewResult | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);

  async function readFile(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setCsv(await file.text());
  }

  function showPreview() {
    setProblem(null);
    if (!csv.trim()) return setProblem(t('Paste CSV text or choose a file'));
    if (csv.length > CSV_MAX_LENGTH) return setProblem(t('The file is too large: 5 MB at most'));
    preview.mutate(csv, { onSuccess: setParsed, onError: (err) => setProblem(failure(t, err)) });
  }

  const title = t('Import leads from CSV');

  if (result) {
    return (
      <Modal
        title={title}
        onClose={onClose}
        actions={
          <button type="button" className="btn primary" onClick={onClose}>
            {t('Done')}
          </button>
        }
      >
        <ImportSummary result={result} onNavigate={onClose} />
      </Modal>
    );
  }

  if (parsed) {
    return (
      <MappingStep
        title={title}
        parsed={parsed}
        busy={run.isPending}
        onBack={() => setParsed(null)}
        onClose={onClose}
        onImport={(body, onFail) =>
          run.mutate({ csv, ...body }, { onSuccess: setResult, onError: (err) => onFail(failure(t, err)) })
        }
      />
    );
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" disabled={preview.isPending} onClick={showPreview}>
            {t('Preview')}
          </button>
        </>
      }
    >
      <p className="muted-text">{t('Rows are imported as prospects. Each company goes through the duplicate check first.')}</p>
      <FormField id="csv-file" label={t('Choose a CSV file')}>
        <input id="csv-file" type="file" accept=".csv,text/csv" className="in file" onChange={(e) => void readFile(e.target.files?.[0])} />
      </FormField>
      <FormField id="csv-text" label={t('Or paste CSV text')}>
        <textarea id="csv-text" className="in mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="Company,Country,Website" />
      </FormField>
      {problem ? (
        <div className="note warn" role="alert">
          {problem}
        </div>
      ) : null}
    </Modal>
  );
}

type MappingProps = {
  title: string;
  parsed: CsvPreviewResult;
  busy: boolean;
  onBack: () => void;
  onClose: () => void;
  onImport: (body: { mapping: CsvMapping; leadSource: string; assignedToId?: number }, onFail: (message: string) => void) => void;
};

function MappingStep({ title, parsed, busy, onBack, onClose, onImport }: MappingProps) {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const { data: lookups } = useLookups();
  const { data: users } = useUsers();
  const [columns, setColumns] = useState<Record<CsvField, string>>(
    () => Object.fromEntries(CSV_FIELDS.map((f) => [f, parsed.suggestedMapping.columns[f] ?? ''])) as Record<CsvField, string>,
  );
  const [leadSource, setLeadSource] = useState('CSV Import');
  const [assignee, setAssignee] = useState('');
  const [missing, setMissing] = useState<CsvField[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const sources = (lookups?.lead_source ?? []).filter((x) => x.isActive);
  const others = me.can('view_all_leads') ? (users ?? []).filter((u) => u.isActive && u.id !== me.id).sort((a, b) => a.name.localeCompare(b.name)) : [];

  function submit() {
    setProblem(null);
    const gaps = REQUIRED.filter((f) => !columns[f]);
    setMissing(gaps);
    if (gaps.length) return;
    const mapping = { columns: Object.fromEntries(CSV_FIELDS.map((f) => [f, columns[f] || null])) } as CsvMapping;
    onImport({ mapping, leadSource, ...(assignee ? { assignedToId: Number(assignee) } : {}) }, setProblem);
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onBack}>
            {t('Back')}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>
            {busy ? t('Importing…') : t('Import {n} rows', { n: parsed.rowCount })}
          </button>
        </>
      }
    >
      <div className="grid2 wide-form">
        <p className="span2 muted-text">{t('Choose the CSV column for each field. Company name and country are required.')}</p>
        {CSV_FIELDS.map((f) => {
          const id = `csv-map-${f}`;
          const bad = missing.includes(f);
          return (
            <FormField key={f} id={id} label={fieldText(t, f)} required={REQUIRED.includes(f)} error={bad ? t('Choose a column') : undefined}>
              <select
                id={id}
                className={bad ? 'in err' : 'in'}
                aria-invalid={bad}
                aria-describedby={bad ? `${id}-err` : undefined}
                value={columns[f]}
                onChange={(e) => setColumns((c) => ({ ...c, [f]: e.target.value }))}
              >
                <option value="">{t('Not imported')}</option>
                {parsed.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </FormField>
          );
        })}
        <FormField id="csv-source" label={t('Lead source for rows without one')}>
          <select id="csv-source" className="in" value={leadSource} onChange={(e) => setLeadSource(e.target.value)}>
            {sources.map((x) => (
              <option key={x.value} value={x.value}>
                {lookupLabel(x, lang)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField id="csv-assignee" label={t('Assigned to')}>
          <select id="csv-assignee" className="in" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t('Unassigned')}</option>
            <option value={String(me.id)}>{t('Me')}</option>
            {others.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
          </select>
        </FormField>
        <div className="span2">
          <h3 className="form-sec">{t('First rows')}</h3>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  {parsed.headers.map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.sample.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {problem ? (
          <div className="span2 note warn" role="alert">
            {problem}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function ImportSummary({ result, onNavigate }: { result: CsvImportResult; onNavigate: () => void }) {
  const t = useT();
  return (
    <div className="csv-summary">
      <div className="note ok" role="status">
        {t('{created} leads created, {linked} linked to existing companies.', { created: result.created, linked: result.linked })}{' '}
        {t('Batch {batch}', { batch: result.batch })}
      </div>
      {result.review.length > 0 ? (
        <section className="note warn">
          <strong>{t('Choose the company for these leads')}</strong>
          <ul className="dup-list">
            {result.review.map((r) => (
              <li key={r.leadId}>
                <Link to={`/leads/${r.leadId}`} onClick={onNavigate}>
                  {t('Row {row}: {company}', { row: r.row, company: r.companyName })}
                </Link>
                {' · '}
                {r.candidates.map((c) => `${c.number} ${c.name}`).join(', ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {result.errors.length > 0 ? (
        <section className="note danger">
          <strong>{t('Rows not imported: {n}', { n: result.errors.length })}</strong>
          <ul className="dup-list">
            {result.errors.map((e) => (
              <li key={e.row}>{t('Row {row}: {message}', { row: e.row, message: e.message })}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
