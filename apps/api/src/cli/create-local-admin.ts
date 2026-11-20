import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { prisma } from '../db.js';
import { hashPassword } from '../auth/local.js';

const MIN_PASSWORD = 12;

async function readPassword(): Promise<string> {
  const fromEnv = process.env.LOCAL_ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Password: ');
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();
  if (!email || !name) throw new Error('Usage: create-local-admin --email <email> --name <name>');
  const password = await readPassword();
  if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, role: 'ADMINISTRATOR', isLocalAdmin: true, passwordHash },
    update: { name, role: 'ADMINISTRATOR', isLocalAdmin: true, isActive: true, passwordHash },
  });
  console.log(`Local administrator ready: ${user.email} (id ${user.id})`);
}

main()
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
