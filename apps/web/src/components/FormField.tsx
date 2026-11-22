import type { ReactNode } from 'react';

type FormFieldProps = { id: string; label: string; required?: boolean; error?: string; children: ReactNode; className?: string };

/** Label + control + error message, wired with htmlFor / aria-describedby by id convention (`${id}-err`). */
export function FormField({ id, label, required, error, children, className }: FormFieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className="lbl">
        {label}
        {required ? <>{' '}<span className="req" aria-hidden="true">*</span></> : null}
      </label>
      {children}
      {error ? (
        <div id={`${id}-err`} className="err-msg" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
