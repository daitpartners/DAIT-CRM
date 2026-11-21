# Outreach Language Implementation Plan

> Executed inline (superpowers:executing-plans). **Spec:** docs/superpowers/specs/2026-11-22-outreach-language-design.md

**Goal:** leads carry English/Español; list filter + column, facts, New lead / Edit lead / CSV import set it; allocation and the Email tab follow it.

## Global Constraints
- Node 24; `TZ=Europe/London npm test`; every phrase through `t()` with es/fr.
- Values exactly `'en' | 'es'`; default from `defaultOutreachLanguage(country)` (shared).

## Review Focus
- A lead created without a language for "Mexico" gets `es`; for "United States" `en` (Task 1 test).
- An English lead never matches a Spanish-only rule and falls through to the next rule (Task 1 test).
- Editing a lead's country does not silently flip its language (only creation defaults) (Task 1 test).
- CSV value "Español"/"Spanish"/"es" → es; unknown value → country default, row not rejected (Task 1 test).
- Email tab on a Spanish lead for an English-screen user starts with the Spanish intro (Task 2 e2e).

### Task 1: Data and API
Files: prisma schema + migration `20261126100000_outreach_language`; `packages/shared` (`OUTREACH_LANGUAGES`, `SPANISH_COUNTRIES`, `defaultOutreachLanguage(country): 'en'|'es'`, `parseOutreachLanguage(raw): 'en'|'es'|null`; `outreachLanguage` optional on LeadCreate/LeadUpdate; `language` on LeadListQuery; `matchLanguage` on allocation rule input; CSV mapping field `outreachLanguage`); `apps/api/src/leads/service.ts` (default on create; pass language to `pickAllocation`), `routes/leads.ts` (filter), `leads/serialize.ts` (field), `allocation/pick.ts` (`pickAllocation(tx, country, language)`), `routes/allocation.ts`, `leads/csv.ts`.
Tests (`apps/api/test/outreachLanguage.test.ts` + existing allocation tests): defaults by country; explicit value kept; PATCH country does not change language; `GET /leads?language=es` filters; rule `{countries:['*'], language:'es'}` before `{countries:['United States'], language:'en'}` assigns a Spanish US lead to the first and an English US lead to the second; CSV mapping parses values.
Commit `feat(api): outreach language on leads, filter, allocation by language`.

### Task 2: Web
Files: `LeadsList.tsx` (filter after Country, column after Country), `ProfileCard.tsx` (fact "Outreach language"), `NewLeadPage.tsx` + `LeadFormFields.tsx` (select beside City, follows country until touched), `LeadModal.tsx` (select), `AllocationModal.tsx` + `AllocationRules.tsx` (Language select + column), `CsvImportModal.tsx` (mapping row), `EmailForm.tsx` (intro + template order by lead language).
Tests: e2e (leads filter/column, lead facts, New lead default for Mexico, Edit lead change, allocation rule dialog, Email tab Spanish intro on an `es` lead); unit tests updated where markup changed.
Commit `feat(web): outreach language in leads, lead page, allocation rules, Email tab`.

### Task 3: Docs, full suite, review, then live rule setup after deploy (owner's split).
