import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUrlListState } from '../src/hooks/useUrlListState';

const SORTS = ['name', 'updatedAt'] as const;

function setup(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  return renderHook(
    () => ({ state: useUrlListState({ sorts: SORTS, defaultSort: 'name', extra: ['status'] }), location: useLocation() }),
    { wrapper },
  );
}

describe('useUrlListState', () => {
  it('reads q, sort, dir, page and extras from the URL, with defaults', () => {
    const { result } = setup('/x?q=acme&sort=updatedAt&dir=desc&page=3&status=Active');
    expect(result.current.state.params).toMatchObject({ q: 'acme', sort: 'updatedAt', dir: 'desc', page: 3, status: 'Active' });

    const empty = setup('/x?sort=bogus&dir=sideways').result.current.state.params;
    expect(empty).toMatchObject({ q: undefined, sort: 'name', dir: 'asc', page: 1, status: undefined });
  });

  it('clamps page to at least 1', () => {
    expect(setup('/x?page=0').result.current.state.params.page).toBe(1);
    expect(setup('/x?page=-4').result.current.state.params.page).toBe(1);
    expect(setup('/x?page=abc').result.current.state.params.page).toBe(1);
    expect(setup('/x?page=2.5').result.current.state.params.page).toBe(1);
  });

  it('writes params; any change other than the page resets to page 1; blanks are removed', () => {
    const { result } = setup('/x?page=4&q=old');
    act(() => result.current.state.set({ sort: 'updatedAt', dir: 'desc' }));
    expect(new URLSearchParams(result.current.location.search).toString()).toBe('q=old&sort=updatedAt&dir=desc');
    act(() => result.current.state.set({ page: 2 }));
    expect(result.current.state.params.page).toBe(2);
    act(() => result.current.state.set({ q: '' }));
    expect(new URLSearchParams(result.current.location.search).toString()).toBe('sort=updatedAt&dir=desc');
  });

  it('reset clears the search and extras but keeps the sort', () => {
    const { result } = setup('/x?q=acme&status=Active&sort=updatedAt&page=2');
    act(() => result.current.state.reset());
    expect(new URLSearchParams(result.current.location.search).toString()).toBe('sort=updatedAt');
    expect(result.current.state.search.text).toBe('');
  });
});
