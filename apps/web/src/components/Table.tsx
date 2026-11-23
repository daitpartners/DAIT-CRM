import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type TableProps = {
  head: ReactNode[];
  children: ReactNode;
  empty?: string;
  isEmpty?: boolean;
  /** `head` items are complete `<th>` elements (e.g. SortHeader) rendered as they are. */
  rawHead?: boolean;
  /** Columns that stay in view while the table scrolls sideways (1, or 2 for a tick box + id). */
  sticky?: 1 | 2;
};

/**
 * A `.tbl` scroller with a cue (review #02): a fade on each side where columns are scrolled out of view, so a wide
 * table never hides columns silently. `sticky` keeps the first column(s) in view.
 */
export function ScrollBox({ sticky, className, children }: { sticky?: 1 | 2; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ l: false, r: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    setMore((m) => (m.l === l && m.r === r ? m : { l, r }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    // Rows arriving or the window narrowing change the overflow without a scroll.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => ro?.disconnect();
  }, [update]);
  const wrap = ['tbl-wrap', more.l ? 'more-l' : '', more.r ? 'more-r' : ''].filter(Boolean).join(' ');
  const box = ['tbl', sticky ? `sticky-${sticky}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={wrap}>
      <div ref={ref} className={box} onScroll={update}>
        {children}
      </div>
    </div>
  );
}

/** Prototype table pattern: `.tbl` scrolls horizontally on narrow screens instead of the page. */
export function Table({ head, children, empty, isEmpty, rawHead, sticky }: TableProps) {
  return (
    <ScrollBox sticky={sticky}>
      <table>
        <thead>
          <tr>
            {rawHead
              ? head
              : head.map((h, i) => (
                  <th key={i} scope="col">
                    {h}
                  </th>
                ))}
          </tr>
        </thead>
        <tbody>
          {isEmpty ? (
            <tr>
              <td colSpan={head.length} className="empty">
                {empty}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </ScrollBox>
  );
}
