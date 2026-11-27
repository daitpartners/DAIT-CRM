/**
 * Email screen date presets (web-mail release 2): the Flag menu's due days and the "Set follow-up" choices.
 * Every day is a `YYYY-MM-DD` string in the user's own time zone, and the caller passes today (from `localNow`),
 * so the presets never depend on the server's or the browser's zone.
 */

export const FLAG_PRESETS = ['today', 'tomorrow', 'thisWeek', 'nextWeek', 'noDate'] as const;
export type FlagPreset = (typeof FLAG_PRESETS)[number];

/** The day `n` days after `day` (before it for a negative `n`). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** The Monday after `day` (a week on when `day` is a Monday). */
function nextMonday(day: string): string {
  return addDays(day, ((8 - weekday(day)) % 7) || 7);
}

/**
 * The due day a Flag preset sets (Outlook): This week = this Friday, or today from Friday to Sunday; Next week = the
 * following Monday. `noDate` flags without a due day (null).
 */
export function flagDueDay(preset: FlagPreset, today: string): string | null {
  switch (preset) {
    case 'today': return today;
    case 'tomorrow': return addDays(today, 1);
    case 'thisWeek': {
      const wd = weekday(today);
      return wd >= 1 && wd <= 4 ? addDays(today, 5 - wd) : today;
    }
    case 'nextWeek': return nextMonday(today);
    case 'noDate': return null;
  }
}

export type FollowUpKey = 'laterToday' | 'tomorrow' | 'nextWeek' | 'twoWeeks';

/** Last hour "Later today" is offered for, and the time it sets. */
const LATER_TODAY = '17:00';
const MORNING = '09:00';

/**
 * The "Set follow-up" choices at `nowTime` (`HH:MM`, the user's zone) on `today`: Later today 17:00 (only before
 * 17:00), Tomorrow, Next week (the following Monday) and In 2 weeks, each at 09:00.
 */
export function followUpChoices(today: string, nowTime: string): { key: FollowUpKey; date: string; time: string }[] {
  const choices: { key: FollowUpKey; date: string; time: string }[] = [];
  if (nowTime < LATER_TODAY) choices.push({ key: 'laterToday', date: today, time: LATER_TODAY });
  choices.push(
    { key: 'tomorrow', date: addDays(today, 1), time: MORNING },
    { key: 'nextWeek', date: nextMonday(today), time: MORNING },
    { key: 'twoWeeks', date: addDays(today, 14), time: MORNING },
  );
  return choices;
}

/** Today's day and the 24-hour `HH:MM` time in `timezone` (UTC for an unknown zone). */
export function localNow(timezone: string, now: Date = new Date()): { day: string; time: string } {
  const parts = (timeZone: string) => new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  let list: Intl.DateTimeFormatPart[];
  try {
    list = parts(timezone);
  } catch {
    list = parts('UTC');
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => list.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
