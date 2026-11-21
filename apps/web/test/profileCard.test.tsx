import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeContext } from '../src/pages/leads/ComposePanel';
import { ProfileCard } from '../src/pages/leads/ProfileCard';
import { Wrap, makeClient, makeLead } from './leadFixture';

describe('ProfileCard', () => {
  it('renders a contact without profile fields: no empty pills, no "undefined", no Current badge', () => {
    const { container } = render(
      <Wrap qc={makeClient()}>
        <ProfileCard lead={makeLead()} />
      </Wrap>,
    );
    const card = screen.getByRole('region', { name: 'Profile' });
    expect(within(card).getByRole('heading', { name: 'Tom Hale' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|null|NaN/);
    expect(container.querySelectorAll('.sk, .badge:empty, .phead:empty, .pmeta:empty')).toHaveLength(0);
    expect(container.querySelector('.pabout')).toBeNull();
    expect(within(card).queryByText('Current')).toBeNull();
    // No roles yet: one "—" row with the lead's company (owner, 22 Nov 2026).
    expect(within(card).getByRole('list', { name: 'Experience' }).querySelectorAll('li')).toHaveLength(1);
    expect(within(card).getByText('No LinkedIn yet')).toBeInTheDocument();
    // Facts grid: empty values show a dash, never a blank.
    const facts = within(card).getByText('Industry', { selector: 'dt' }).nextElementSibling;
    expect(facts).toHaveTextContent('—');
  });

  it('renders the profile: headline, company line, contacts, about and the experience timeline', () => {
    const lead = makeLead();
    lead.contact = {
      ...lead.contact!, designation: 'Head of Operations', department: 'Operations', headline: 'Ops leader', location: 'Pune, India',
      about: 'Runs three warehouses.', linkedinUrl: 'https://linkedin.com/in/tom', mobile: '+91 98220 41178', phone: '+91 20 6710 2200',
      businessEmail: 'tom@meridian.test', email: 'tom@meridian.test', isPrimary: true, contactType: 'Decision Maker',
      experience: [
        { title: 'Head of Operations', company: 'Meridian', from: '2021', to: null, description: 'Leads warehousing.' },
        { title: 'Analyst', company: 'Gati', from: '2016', to: '2021', description: null },
      ],
    };
    render(
      <Wrap qc={makeClient()}>
        <ProfileCard lead={lead} />
      </Wrap>,
    );
    const card = screen.getByRole('region', { name: 'Profile' });
    expect(within(card).getByText('Ops leader')).toBeInTheDocument();
    expect(within(card).getByText('Primary contact')).toHaveClass('badge');
    expect(within(card).getByRole('link', { name: 'Meridian Textiles' })).toHaveAttribute('href', '/companies/4');
    expect(within(card).getByText(/Operations · Pune, India/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /LinkedIn profile/ })).toHaveAttribute('href', 'https://linkedin.com/in/tom');
    expect(within(card).getByRole('link', { name: /tom@meridian.test/ })).toHaveAttribute('href', 'mailto:tom@meridian.test');
    expect(within(card).getByText('Runs three warehouses.')).toBeInTheDocument();
    const xp = within(card).getByRole('list', { name: 'Experience' });
    expect(within(xp).getAllByRole('listitem')).toHaveLength(2);
    expect(within(xp).getByText('Current')).toHaveClass('badge');
    expect(within(xp).getByText('2016 – 2021')).toBeInTheDocument();
  });

  it('without a contact shows the company name and a note, and still the facts grid', () => {
    render(
      <Wrap qc={makeClient()}>
        <ProfileCard lead={makeLead({ contact: null, contactId: null })} />
      </Wrap>,
    );
    const card = screen.getByRole('region', { name: 'Profile' });
    expect(within(card).getByRole('heading', { name: 'Meridian Textiles' })).toBeInTheDocument();
    expect(within(card).getByText(/No contact person on this lead yet/)).toBeInTheDocument();
    expect(within(card).getByText('Lead source', { selector: 'dt' })).toBeInTheDocument();
    // The Experience column shows on every lead: "—", the company, "—".
    expect(within(card).getByRole('list', { name: 'Experience' })).toHaveTextContent(/^—\s*Meridian Textiles\s*—$/);
  });

  it('renders with neither company nor contact (CSV review row): no-contact state, dashes in the facts', () => {
    const { container } = render(
      <Wrap qc={makeClient()}>
        <ProfileCard lead={makeLead({ company: null, companyId: null, contact: null, contactId: null, companyName: 'Unlinked Co' })} />
      </Wrap>,
    );
    const card = screen.getByRole('region', { name: 'Profile' });
    expect(within(card).getByRole('heading', { name: 'Unlinked Co' })).toBeInTheDocument();
    expect(within(card).getByText(/No contact person on this lead yet/)).toBeInTheDocument();
    expect(within(card).getByText('Industry', { selector: 'dt' }).nextElementSibling).toHaveTextContent('—');
    expect(container.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('the profile collapses, and "Focus on email" folds it and opens the Email tab', async () => {
    const u = userEvent.setup();
    const openEmail = vi.fn();
    render(
      <Wrap qc={makeClient()}>
        <ComposeContext.Provider value={{ tab: 'call', setTab: vi.fn(), closed: false, setClosed: vi.fn(), openEmail }}>
          <ProfileCard lead={makeLead()} />
        </ComposeContext.Provider>
      </Wrap>,
    );
    const toggle = screen.getByRole('button', { name: /^Profile/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await u.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await u.click(toggle);
    await u.click(screen.getByRole('button', { name: /Focus on email/ }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(openEmail).toHaveBeenCalledTimes(1);
  });
});
