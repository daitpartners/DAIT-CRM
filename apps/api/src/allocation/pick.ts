import type { Prisma } from '@prisma/client';

/**
 * Picks the assignee for a lead from `country` using the active allocation rules.
 * Must run inside the caller's transaction so the round-robin advance commits with the lead.
 */
export async function pickAssignee(tx: Prisma.TransactionClient, country: string, language = 'en'): Promise<number | null> {
  return (await pickAllocation(tx, country, language))?.userId ?? null;
}

/** As `pickAssignee`, also naming the rule that chose the user (for `lead_assignments.rule_id`). */
export async function pickAllocation(
  tx: Prisma.TransactionClient, country: string, language = 'en',
): Promise<{ userId: number; ruleId: number } | null> {
  const rules = await tx.allocationRule.findMany({
    where: { isActive: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  });
  // A rule matches on its countries (or '*') and, when it names one, the lead's outreach language.
  const match = rules.find((r) => {
    const countries = r.matchCountries as string[];
    const countryOk = countries.includes(country) || (countries.length === 1 && countries[0] === '*');
    return countryOk && (r.matchLanguage === null || r.matchLanguage === language);
  });
  if (!match) return null;

  // Lock the row, then re-read the position so concurrent picks serialize.
  const [locked] = await tx.$queryRaw<{ round_robin_pos: number; assign_to: unknown }[]>`
    SELECT round_robin_pos, assign_to FROM allocation_rules WHERE id = ${match.id} FOR UPDATE`;
  if (!locked) return null;
  const assignTo = locked.assign_to as number | number[];
  if (!Array.isArray(assignTo)) return { userId: assignTo, ruleId: match.id };
  if (assignTo.length === 0) return null;
  const chosen = assignTo[locked.round_robin_pos % assignTo.length];
  await tx.allocationRule.update({ where: { id: match.id }, data: { roundRobinPos: locked.round_robin_pos + 1 } });
  return { userId: chosen, ruleId: match.id };
}
