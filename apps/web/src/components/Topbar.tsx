import type { ReactNode } from 'react';

type TopbarProps = {
  title: string;
  sub?: ReactNode;
  crumb?: ReactNode;
  /** Shown beside the title (e.g. status badges). */
  badges?: ReactNode;
  children?: ReactNode;
};

export function Topbar({ title, sub, crumb, badges, children }: TopbarProps) {
  return (
    <header className="topbar">
      <div style={{ minWidth: 0 }}>
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
