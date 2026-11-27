/**
 * Email screen date presets (web-mail release 2): the Flag menu's due days and the "Set follow-up" choices; release 3
 * adds the send dialog's follow-up choices, the Schedule send presets and the instant of a wall-clock time in a zone.
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

/** The day `n` working days after `day`: only Saturday and Sunday are skipped (no public holidays). */
export function addWorkingDays(day: string, n: number): string {
  let d = day;
  for (let left = n; left > 0;) {
    d = addDays(d, 1);
    const wd = weekday(d);
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
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

export type SendFollowUpKey = 'tomorrow' | 'threeWorkingDays' | 'oneWeek' | 'twoWeeks';
/** The choice the send dialog's follow-up box starts on (badge `Default`). */
export const DEFAULT_SEND_FOLLOW_UP: SendFollowUpKey = 'threeWorkingDays';

/**
 * The send dialog's follow-up choices from `baseDay` (the user's today): Tomorrow, In 3 working days, In 1 week and
 * In 2 weeks, each at 09:00.
 */
export function sendFollowUpChoices(baseDay: string): { key: SendFollowUpKey; date: string; time: string }[] {
  return [
    { key: 'tomorrow', date: addDays(baseDay, 1), time: MORNING },
    { key: 'threeWorkingDays', date: addWorkingDays(baseDay, 3), time: MORNING },
    { key: 'oneWeek', date: addDays(baseDay, 7), time: MORNING },
    { key: 'twoWeeks', date: addDays(baseDay, 14), time: MORNING },
  ];
}

export type ScheduleKey = 'laterToday' | 'tomorrow' | 'monday';
/** The time Schedule send's Tomorrow morning and Monday morning set. */
const SCHEDULE_MORNING = '08:00';

/**
 * The Schedule send presets at `nowTime` (`HH:MM`, the user's zone) on `today`: Later today 17:00 (only before 17:00),
 * Tomorrow morning and Monday morning (the next Monday, a week on when today is Monday), both at 08:00.
 */
export function schedulePresets(today: string, nowTime: string): { key: ScheduleKey; date: string; time: string }[] {
  const presets: { key: ScheduleKey; date: string; time: string }[] = [];
  if (nowTime < LATER_TODAY) presets.push({ key: 'laterToday', date: today, time: LATER_TODAY });
  presets.push(
    { key: 'tomorrow', date: addDays(today, 1), time: SCHEDULE_MORNING },
    { key: 'monday', date: nextMonday(today), time: SCHEDULE_MORNING },
  );
  return presets;
}

/**
 * The UTC instant of the wall-clock `time` (`HH:MM`) on `day` in `timezone` (UTC for an unknown zone). Two passes of
 * the zone's offset, as `startOfDayIn` in the API: a wall time in a spring-forward gap moves forward by the gap
 * (Europe/London 01:30 on the change day is 02:30 BST).
 */
export function instantIn(day: string, time: string, timezone: string): Date {
  const wallAsUtc = new Date(`${day}T${time}:00Z`).getTime();
  const offsetAt = (ms: number) => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
      );
      const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
      return wall - ms;
    } catch {
      return 0;
    }
  };
  let guess = wallAsUtc - offsetAt(wallAsUtc);
  guess = wallAsUtc - offsetAt(guess);
  return new Date(guess);
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
