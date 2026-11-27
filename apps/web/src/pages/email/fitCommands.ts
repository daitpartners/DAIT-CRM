/** An item no wider than this in both forms is a separator (a real command is at least an icon button wide). */
const SEPARATOR_MAX_WIDTH = 16;

/**
 * How the command bar fits (web-mail release 2, mockup `fitCmds`): `full` and `compact` are each item's width with and
 * without its label (a separator, or a command with no short form, has the same width in both), `available` the room
 * left once the always-shown "…" button is taken off (F29). Everything fits at full width → not compact, all visible;
 * else the compact widths are used and `visible` is how many leading items fit, the rest going to "…". A separator is
 * never left last.
 */
export function fitCommands(full: number[], compact: number[], available: number): { compact: boolean; visible: number } {
  const sum = (ws: number[]) => ws.reduce((a, w) => a + w, 0);
  if (sum(full) <= available) return { compact: false, visible: full.length };
  let visible = 0;
  let used = 0;
  while (visible < compact.length && used + compact[visible]! <= available) used += compact[visible++]!;
  const isSeparator = (i: number) => full[i]! <= SEPARATOR_MAX_WIDTH && compact[i]! <= SEPARATOR_MAX_WIDTH;
  while (visible > 0 && isSeparator(visible - 1)) visible--;
  return { compact: true, visible };
}
