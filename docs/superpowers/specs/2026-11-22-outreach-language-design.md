# Outreach language on leads (English / Español) — short design

Owner, 22 Nov 2026: "we are generating leads in two different target client - one is english and other is spanish …
Carlos and Sebastian will be targetting spanish prospects in US region and Mexico, Santiago region, me and Lakshita will be
doing US and Canada english Market, Carlos can understand both" → "go with your suggestion, i will see if i need to change."
Carlos was made an Administrator the same day (co-founder).

## Intent

Each lead records the language the team approaches it in, so Spanish prospects reach Carlos and Sebastian and English
ones Deepak and Lakshita, and every email box starts in the prospect's language whatever the user's screen language.

## Approaches

1. **Chosen:** one field on the lead (`outreach_language`), a Language filter on the Leads list, allocation rules that can
   also match on language, and the Email tab following the lead's language.
2. A separate English / Español tab on the Leads list — offered; the owner took the suggestion (filter; "My leads" already
   separates reps' work).
3. Language on the company or the contact — rejected: the same US company can be approached in either language; the
   approach is a property of the lead.

## Decided

- **Data:** `leads.outreach_language char(2) NOT NULL DEFAULT 'en'` (`'en' | 'es'`); existing leads stay `en` (all
  current leads are the English US/Canada imports). `allocation_rules.match_language char(2) NULL` (null = any language).
- **Default when not given** (New lead, CSV import, API): `es` for Spanish-speaking countries (Mexico, Chile, Spain,
  Argentina, Colombia, Peru, Venezuela, Ecuador, Guatemala, Cuba, Bolivia, Dominican Republic, Honduras, Paraguay,
  El Salvador, Nicaragua, Costa Rica, Panama, Uruguay, Puerto Rico), else `en`.
- **Where it is set:** New lead page (select "Outreach language" beside City; follows Country until the user picks one);
  Edit lead details (select); CSV import (optional column mapped to "Outreach language": `en`/`es`/`English`/`Spanish`/
  `Español`, otherwise the country default).
- **Where it shows:** lead page facts grid (ninth fact, "Outreach language"); Leads list column "Language" after Country
  and filter "Language: Any / English / Español" after Country.
- **Email tab:** the intro text is in the lead's language (the Spanish wording of the prototype intro); templates in the
  lead's language come first and others are marked "(EN)" / "(ES)" / "(FR)" relative to the lead.
- **Allocation:** a rule matches when its countries match (or `*`) **and** its language is empty or equals the lead's.
  Rules UI: "Language: Any / English / Español" in the rule dialog and a Language column. After deploy, the live rules
  are set to the owner's split: **Español, any country → Carlos Torres, Sebastian Passalacqua (round robin)** first,
  then **English, United States / Canada → Deepak Singh, Lakshita Singh (round robin)**; the owner may change them in
  Settings → Lead allocation rules.

## Left to the builder

Translation keys, component placement details, migration name, tests (API: default by country, filter, allocation by
language; e2e: filter, facts, Email tab Spanish intro).
