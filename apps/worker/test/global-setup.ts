import { execSync } from 'node:child_process';

/** Applies migrations to the unit-test database (same approach as apps/api). */
export default function setup(): void {
  const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_unit';
  execSync('npx prisma migrate deploy', {
    cwd: new URL('../../api', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL },
    stdio: 'pipe',
  });
}
