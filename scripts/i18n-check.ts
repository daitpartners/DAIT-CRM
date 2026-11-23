/**
 * Fails (exit 1) when a phrase used as t('...') / t("...") in apps/web/src is missing
 * from apps/web/src/locales/es.json or fr.json, or a quotation PDF label used as L('...') in
 * apps/api/src/quotations/pdf.ts is missing from its LABELS (es, fr). Run: npm run i18n:check
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(root, 'apps/web/src');
const localesDir = join(srcDir, 'locales');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|ts)$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

// t( 'phrase' ) or t( "phrase" ), allowing escaped quotes inside the literal.
const CALL = /(?<![\w.$])t\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;

function unescape(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export function collectPhrases(files: string[]): Map<string, string> {
  const phrases = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL)) {
      const phrase = unescape(m[1] ?? m[2] ?? '');
      if (!phrases.has(phrase)) phrases.set(phrase, relative(root, file));
    }
  }
  return phrases;
}

const phrases = collectPhrases(walk(srcDir));
let failed = false;
for (const lang of ['es', 'fr']) {
  const dict = JSON.parse(readFileSync(join(localesDir, `${lang}.json`), 'utf8')) as Record<string, string>;
  const missing = [...phrases].filter(([p]) => typeof dict[p] !== 'string' || dict[p] === '');
  if (missing.length) {
    failed = true;
    console.error(`i18n: ${missing.length} phrase(s) missing from ${lang}.json:`);
    for (const [p, file] of missing) console.error(`  ${JSON.stringify(p)}  (${file})`);
  }
}

// The quotation PDF's labels (release 3A): drawn on the server in the quotation owner's language.
const pdfFile = join(root, 'apps/api/src/quotations/pdf.ts');
const pdfPhrases = new Set([...readFileSync(pdfFile, 'utf8').matchAll(/(?<![\w.$])L\(\s*'((?:\\.|[^'\\])*)'/g)].map((m) => unescape(m[1]!)));
const { LABELS } = (await import(pdfFile)) as { LABELS: Record<'es' | 'fr', Record<string, string>> };
for (const lang of ['es', 'fr'] as const) {
  const missing = [...pdfPhrases].filter((p) => typeof LABELS[lang][p] !== 'string' || LABELS[lang][p] === '');
  if (missing.length) {
    failed = true;
    console.error(`i18n: ${missing.length} PDF label(s) missing from LABELS.${lang} in ${relative(root, pdfFile)}:`);
    for (const p of missing) console.error(`  ${JSON.stringify(p)}`);
  }
}
if (failed) process.exit(1);
console.log(`i18n: ${phrases.size} phrases translated in es and fr; ${pdfPhrases.size} quotation PDF labels`);
