-- Company name keys fold accents and drop trailing es/fr legal forms (S.L., S.A. de C.V., S. de R.L., SARL, SAS,
-- S.r.l., AG, B.V. ...); a form at the start of a name ("AG Foods") is kept.
-- normalise_company_name is the same function as normaliseCompanyName in packages/shared/src/normalise.ts, step for
-- step (a test keeps them equal; change both together). Only adds a function and rewrites the derived
-- companies.name_normalised key; updated_at is left alone, and no other column changes.

CREATE OR REPLACE FUNCTION normalise_company_name(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                lower(regexp_replace(normalize(name, NFKD), '[\u0300-\u036f]', '', 'g')),
                '[^a-z0-9.]+', ' ', 'g'),
              '\y([a-z])\. (?=[a-z]\.)', '\1.', 'g'),
            '\y([a-z])\.(?=[a-z]\.| |$)', '\1', 'g'),
          '.', ' '),
        ' +', ' ', 'g'),
      ' (?:(?:s de rl|de cv|de rl|pvt|private|ltd|limited|llc|llp|lp|inc|gmbh|ag|kg|plc|spa|sl|slu|sa|sab|sau|sas|sasu|sarl|eurl|srl|bv|nv|ltda|lda|sapi|pty|co|corp|corporation|company|group) )*(?:s de rl|de cv|de rl|pvt|private|ltd|limited|llc|llp|lp|inc|gmbh|ag|kg|plc|spa|sl|slu|sa|sab|sau|sas|sasu|sarl|eurl|srl|bv|nv|ltda|lda|sapi|pty|co|corp|corporation|company|group) *$', ''),
    '[^a-z0-9]+', ' ', 'g'))
$$;

UPDATE "companies"
SET "name_normalised" = normalise_company_name("name")
WHERE "name_normalised" IS DISTINCT FROM normalise_company_name("name");
