import type { Action } from '@dait-crm/shared';
import { useMe, type Me } from './queries';

/** Inside the signed-in shell `me` is always loaded (RequireAuth renders nothing else until it is). */
export function useCurrentUser(): Me & { can: (a: Action) => boolean } {
  const { data } = useMe();
  const me = data!;
  return { ...me, can: (a: Action) => me.rights.includes(a) };
}
