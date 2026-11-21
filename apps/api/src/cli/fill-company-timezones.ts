// One-time (release 2C): fill empty company time zones from their address. Run with tsx or node on the built file.
import { prisma } from '../db.js';
import { fillCompanyTimezones } from '../mailer/rules.js';

try {
  const n = await fillCompanyTimezones(prisma);
  console.log(`company time zones filled: ${n}`);
} finally {
  await prisma.$disconnect();
}
