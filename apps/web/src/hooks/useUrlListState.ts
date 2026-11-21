import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SortDir } from '../api/companies';
import { useDebounce } from './useDebounce';

export type UrlListParams<S extends string, E extends string> = {
  q: string | undefined;
  sort: S;
  dir: SortDir;
  page: number;
} & { [K in E]: string | undefined };

/** A param patch: '' or undefined removes the param. */
export type UrlListPatch = Record<string, string | number | undefined>;

type Opts<S extends string, E extends string> = {
  sorts: readonly S[];
  defaultSort: S;
  /** Extra filter params kept in the URL (e.g. 'status'); read as raw strings, validated by the caller. */
  extra?: readonly E[];
};

/**
 * List state (search, sort, direction, page and filters) lives in the address bar so Back, refresh and
 * shared links keep it. `set` with any change other than the page goes back to page 1. `search` is the
 * search box: typed text reaches the URL 300 ms after the last keystroke, and Back/forward updates the box.
 */
export function useUrlListState<S extends string, E extends string = never>(opts: Opts<S, E>) {
  const [searchParams, setSearchParams] = useSearchParams();
  const extra = opts.extra ?? [];

  const pageNum = Number(searchParams.get('page'));
  const sortParam = searchParams.get('sort');
  const params = {
    q: searchParams.get('q') || undefined,
    sort: (opts.sorts as readonly string[]).includes(sortParam ?? '') ? (sortParam as S) : opts.defaultSort,
    dir: searchParams.get('dir') === 'desc' ? 'desc' : 'asc',
    page: Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1,
    ...Object.fromEntries(extra.map((k) => [k, searchParams.get(k) || undefined])),
  } as UrlListParams<S, E>;

  /** Sets (or with '' / undefined removes) params; any change other than the page goes back to page 1. */
  const set = (patch: UrlListPatch, replace = false) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === '') next.delete(k);
          else next.set(k, String(v));
        }
        if (!('page' in patch)) next.delete('page');
        return next;
      },
      { replace },
    );
  };

  // Search box: typed text goes to the URL 300 ms after the last keystroke.
  const [text, setText] = useState(params.q ?? '');
  const debouncedText = useDebounce(text, 300);
  const pushed = useRef(params.q ?? '');
  useEffect(() => {
    const q = debouncedText.trim();
    if (q === (params.q ?? '')) return;
    pushed.current = q;
    set({ q }, true);
    // Only a settled keystroke writes the URL, so `params.q` is deliberately not a dependency.
  }, [debouncedText]);
  useEffect(() => {
    // Back/forward changed q: show it, unless it is the value this box just wrote.
    if ((params.q ?? '') !== pushed.current) {
      pushed.current = params.q ?? '';
      setText(params.q ?? '');
    }
  }, [params.q]);

  /** Clears the search box and every extra filter (sort and direction stay). */
  const reset = () => {
    setText('');
    pushed.current = '';
    set({ q: undefined, ...Object.fromEntries(extra.map((k) => [k, undefined])) });
  };

  return { params, set, reset, search: { text, setText } };
}

/** A page past the end (old link, or rows removed since): go to the last page that has rows. */
export function usePageClamp(
  data: { items: unknown[]; total: number; page: number; pageSize: number } | undefined,
  set: (patch: UrlListPatch, replace?: boolean) => void,
) {
  useEffect(() => {
    if (!data || data.items.length > 0 || data.total === 0) return;
    const last = Math.ceil(data.total / data.pageSize);
    if (data.page > last) set({ page: last > 1 ? last : undefined }, true);
    // `set` is recreated every render; only new data should trigger this.
  }, [data]);
}
