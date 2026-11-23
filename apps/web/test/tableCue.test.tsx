import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Table } from '../src/components/Table';

/** jsdom has no layout: give the scroller fixed sizes. */
function size(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
}

describe('wide tables (review #02)', () => {
  it('show a fade on the side where columns are hidden, following the scroll', () => {
    const { container } = render(
      <Table head={['A', 'B']} sticky={1}>
        <tr><td>1</td><td>2</td></tr>
      </Table>,
    );
    const wrap = container.querySelector('.tbl-wrap') as HTMLElement;
    const box = container.querySelector('.tbl') as HTMLElement;
    expect(box).toHaveClass('sticky-1');
    size(box, 1200, 800);
    fireEvent.scroll(box);
    expect(wrap).toHaveClass('more-r');
    expect(wrap).not.toHaveClass('more-l');
    box.scrollLeft = 200;
    fireEvent.scroll(box);
    expect(wrap).toHaveClass('more-l');
    expect(wrap).toHaveClass('more-r');
    box.scrollLeft = 400;
    fireEvent.scroll(box);
    expect(wrap).not.toHaveClass('more-r');
  });

  it('a table that fits has no fade', () => {
    const { container } = render(
      <Table head={['A']}>
        <tr><td>1</td></tr>
      </Table>,
    );
    const box = container.querySelector('.tbl') as HTMLElement;
    size(box, 500, 800);
    fireEvent.scroll(box);
    expect(container.querySelector('.tbl-wrap')!.className).toBe('tbl-wrap');
  });
});
