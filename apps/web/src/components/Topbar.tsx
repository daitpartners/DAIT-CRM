import type { ReactNode } from 'react';

type TopbarProps = { title: string; sub?: string; crumb?: ReactNode; children?: ReactNode };

export function Topbar({ title, sub, crumb, children }: TopbarProps) {
  return (
    <header className="topbar">
      <div style={{ minWidth: 0 }}>
        {crumb ? <div className="crumb">{crumb}</div> : null}
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="grow" />
      {children}
    </header>
  );
}
