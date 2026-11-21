# Release 1B — Companies & Contacts (short design)

Approved by Deepak Singh, 21 Nov 2026. Builds on the fresh-build design
(`2026-11-21-dait-crm-fresh-build-design.md`) and plan 1A (foundation, live at crm.daitpartners.com).

## Intent

The company-centric master database: Companies, Contacts and Locations, with the duplicate-matching
rules that leads (plan 1C) and website enquiries (plan 1D) will reuse.

## Goals / non-goals

- Goals: Companies list + 7-tab profile, Contacts (tab and own page), Locations, matching service, role visibility.
- Non-goals: leads, activities, AI enrichment, research sources, CSV import (later plans). Those tabs render an empty state.
- Anti-goals: silent merges on similar names; deleting history (deactivate instead).

## Approaches

1. Matching rules written inside lead/enquiry code later — rejected, three callers need one tested service.
2. Single long company page — rejected, design and prototype specify seven tabs.
3. **Chosen:** tabbed profile, shared `matchCompany`/`matchContact` service, Contacts as both a company tab and a top-level page.

## Decided

- Tables `companies`, `contacts`, `company_locations` per `docs/data-model.md`; CO- number from a Postgres sequence;
  unique index on `domain`; `phone_normalised` on contacts; `updated_at` optimistic concurrency; audit rows on every write.
- Lookup groups: industry, business_category, business_type, employee_range, revenue_range, location_type, contact_type.
  Seeded from the prototype's sample lists until pending decision 5.
- Matching priority (spec §11): company = business-email domain (free-mail ignored) → exact legal name → normalised
  name + country; contact = exact email → normalised phone → name + company. Only the first key auto-links; the rest
  are "possible duplicates" shown to the user. Exposed as a check-duplicates endpoint used live on the create forms.
- Exactly one primary contact per company, enforced in the API.
- Visibility: Administrator/Manager/Data Research User see all companies and contacts; Sales Representative sees
  companies they created or that are linked to their leads (link exists from 1C; until then, created-by).
- Deactivate (status Inactive/Closed) rather than delete.
- Lists: search, filters, column sort, paging, bulk deactivate, inline validation. Three languages.
- Tests: unit (matching, normalisers), API (permissions, primary-contact rule, concurrency), e2e (create company with
  duplicate warning, add contact, contacts page search).

## Left to the builder

Exact Prisma field types, route shapes within the 1A conventions, component split, seed data.
