import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { LeadType, OutreachLanguage } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import { useBatch, useBatchFiles, useSortBatch, useUpdateBatch } from '../../../api/imports';
import { useT } from '../../../i18n/useT';
import { importErrorText } from '../labels';
import { StepResearch } from './StepResearch';
import { StepReview } from './StepReview';
import { StepSort } from './StepSort';
import { StepUpload, missingChoices, type Step1Alert } from './StepUpload';
import { WizardSteps, type Step } from './WizardSteps';

/** The step a batch opened without `step` goes to; null = the Data manager (Importing, Imported, Undone, Failed). */
export function stepForStatus(status: string): Step | null {
  switch (status) {
    case 'Uploading':
      return 1;
    case 'Sorting':
      return 2;
    case 'Researching':
      return 3;
    case 'Waiting for review':
      return 4;
    default:
      return null;
  }
}

/**
 * The New import wizard. `?batch=<id>&step=<1-4>` keeps it across reloads; a batch opened without `step` goes to the
 * step its status is at. A later step (button or step pill) is refused, with the step-1 alert, until both choices are made.
 */
export function Wizard() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const rawBatch = Number(params.get('batch'));
  const batchId = Number.isInteger(rawBatch) && rawBatch > 0 ? rawBatch : null;
  const rawStep = Number(params.get('step'));
  const { data: batch } = useBatch(batchId);
  const { data: files } = useBatchFiles(batchId);
  const sort = useSortBatch();
  const update = useUpdateBatch(batchId);
  const [language, setLanguage] = useState<OutreachLanguage | null>(null);
  const [leadType, setLeadType] = useState<LeadType | null>(null);
  const [alert, setAlert] = useState<Step1Alert | null>(null);

  // A batch opened from the URL brings its choices.
  useEffect(() => {
    if (!batch) return;
    setLanguage(batch.language as OutreachLanguage);
    setLeadType(batch.leadType);
  }, [batch?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (batchId !== null && !batch && !params.get('step')) return null;
  const fromStatus = batch ? stepForStatus(batch.status) : 1;
  if (batchId !== null && batch && fromStatus === null && !params.get('step')) {
    return <Navigate to={`/leads/import/manager?batch=${batchId}`} replace />;
  }
  const step: Step = [1, 2, 3, 4].includes(rawStep) && batchId !== null ? (rawStep as Step) : (fromStatus ?? 1);

  const setStep = (n: Step, id = batchId) => {
    window.scrollTo?.({ top: 0 });
    setParams(id ? { batch: String(id), step: String(n) } : {});
  };

  const missing = missingChoices(language, leadType);

  function go(n: Step) {
    if (n > 1 && missing.length > 0) {
      setStep(1);
      setAlert({ kind: 'choices', flash: Date.now() });
      return;
    }
    setAlert(null);
    if (n === 1) return setStep(1);
    if (batchId === null || !batch || batch.status === 'Uploading') return sortAndGo();
    setStep(n);
  }

  function sortAndGo() {
    if (batchId === null || !(files?.items ?? []).some((f) => f.status === 'Read')) {
      setStep(1);
      setAlert({ kind: 'text', text: t('Add at least one file the CRM can read.'), flash: Date.now() });
      return;
    }
    sort.mutate(batchId, {
      onSuccess: () => setStep(2),
      onError: (e) => setAlert({ kind: 'text', text: importErrorText(t, e instanceof ApiError ? e.code : ''), flash: Date.now() }),
    });
  }

  function choose(patch: { language?: OutreachLanguage; leadType?: LeadType }) {
    if (patch.language) setLanguage(patch.language);
    if (patch.leadType) setLeadType(patch.leadType);
    if (batchId !== null) update.mutate(patch);
    // The alert follows the choices (it goes once both are made).
    if (alert?.kind === 'choices') {
      const left = missingChoices(patch.language ?? language, patch.leadType ?? leadType);
      setAlert(left.length ? { ...alert } : null);
    }
  }

  return (
    <>
      <WizardSteps step={step} onGo={go} />
      {step === 1 ? (
        <StepUpload
          batchId={batchId}
          language={language}
          leadType={leadType}
          alert={alert}
          busy={sort.isPending}
          onChoose={choose}
          onCreated={(id) => setStep(1, id)}
          onRefused={() => setAlert({ kind: 'choices', flash: Date.now() })}
          onNext={() => go(2)}
        />
      ) : batchId !== null && step === 2 ? (
        <StepSort batchId={batchId} batchStatus={batch?.status ?? ''} onBack={() => go(1)} onNext={() => setStep(3)} />
      ) : batchId !== null && step === 3 ? (
        <StepResearch batchId={batchId} onBack={() => go(2)} onNext={() => setStep(4)} />
      ) : batchId !== null && step === 4 ? (
        <StepReview batchId={batchId} onBack={() => go(3)} />
      ) : null}
    </>
  );
}
