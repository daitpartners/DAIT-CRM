import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompaniesList } from '../src/pages/companies/CompaniesList';
import { Wrap, makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const TILES = {
  total: 9, active: 9, inactive: 0, closed: 0, verified: 1, partiallyVerified: 2, unverified: 6,
  aiQueue: 3, aiPending: 2, aiProcessing: 1, aiFailed: 4, possibleDuplicates: 0,
};

describe('Companies list: AI research queue tile (prototype views-companies.js)', () => {
  it('the figure is pending + processing + failed, split in the meta line', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return Response.json(rep);
      if (url.startsWith('/api/companies?')) {
        return Response.json({ items: [], total: 0, page: 1, pageSize: 25, tiles: TILES, counts: { all: 9, clients: 0, open: 0, verify: 8, dups: 0 } });
      }
      return Response.json({});
    }));
    render(
      <Wrap qc={makeClient()}>
        <CompaniesList />
      </Wrap>,
    );
    const meta = await screen.findByText('2 pending · 1 processing · 4 failed');
    const tile = meta.closest('.tile')!;
    expect(tile.querySelector('.l')).toHaveTextContent('AI research queue');
    expect(tile.querySelector('.v')).toHaveTextContent('7');
    expect(meta).toHaveClass('warn');
  });
});
