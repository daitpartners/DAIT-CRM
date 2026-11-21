import { parseArgs } from 'node:util';
import { prisma } from '../db.js';
import { importProspects, parseOwners } from '../leads/importProspects.js';

/**
 * node --env-file=<env> dist/cli/import-prospects-2026-11-21.js --file <leads_pending_1C.csv>
 *   --owners "Deepak=<email>,Carlos=<email>" [--dry-run]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { file: { type: 'string' }, owners: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  if (!values.file || !values.owners) {
    throw new Error('Usage: import-prospects-2026-11-21 --file <csv> --owners "Name=email,Name=email" [--dry-run]');
  }
  await importProspects(prisma, { file: values.file, owners: parseOwners(values.owners), dryRun: values['dry-run'] ?? false });
}

main()
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
