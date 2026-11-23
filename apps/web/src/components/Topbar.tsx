import type { ReactNode } from 'react';

type TopbarProps = {
  title: string;
  sub?: ReactNode;
  crumb?: ReactNode;
  /** Shown beside the title (e.g. status badges). */
  badges?: ReactNode;
  /** Shown left of the title block (e.g. a company's initials logo). */
  logo?: ReactNode;
  className?: string;
  children?: ReactNode;
};

export function Topbar({ title, sub, crumb, badges, logo, className, children }: TopbarProps) {
  return (
    <header className={className ? `topbar ${className}` : 'topbar'}>
      {logo}
      <div className="topbar-t">
        {crumb ? <div className="crumb">{crumb}</div> : null}
        {badges ? (
          <div className="title-row">
            <h1>{title}</h1>
            {badges}
          </div>
        ) : (
          <h1>{title}</h1>
        )}
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="grow" />
      {children}
    </header>
  );
}
