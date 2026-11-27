import { expect, test } from 'vitest';
import {
  addDays, addWorkingDays, flagDueDay, followUpChoices, instantIn, localNow, schedulePresets, sendFollowUpChoices,
  DEFAULT_SEND_FOLLOW_UP, type FlagPreset,
} from '../src/index.js';

test('addDays crosses month and year ends', () => {
  expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
});
test('flag presets from Thursday 26 Nov 2026 (mockup)', () => {
  expect(['today', 'tomorrow', 'thisWeek', 'nextWeek', 'noDate'].map((p) => flagDueDay(p as FlagPreset, '2026-11-26')))
    .toEqual(['2026-11-26', '2026-11-27', '2026-11-27', '2026-11-30', null]);
});
test('This week from Monday is that Friday', () => {
  expect(flagDueDay('thisWeek', '2026-11-23')).toBe('2026-11-27');
  expect(flagDueDay('nextWeek', '2026-11-23')).toBe('2026-11-30');
});
test('This week on Friday, Saturday and Sunday is that day; Next week is the following Monday (Review Focus 5)', () => {
  expect(flagDueDay('thisWeek', '2026-11-27')).toBe('2026-11-27');
  expect(flagDueDay('thisWeek', '2026-11-28')).toBe('2026-11-28');
  expect(flagDueDay('thisWeek', '2026-11-29')).toBe('2026-11-29');
  expect(flagDueDay('nextWeek', '2026-11-29')).toBe('2026-11-30');
});
test('follow-up choices at 14:30 on Thu 26 Nov (mockup), and no Later today from 17:00 (Review Focus 5)', () => {
  expect(followUpChoices('2026-11-26', '14:30')).toEqual([
    { key: 'laterToday', date: '2026-11-26', time: '17:00' }, { key: 'tomorrow', date: '2026-11-27', time: '09:00' },
    { key: 'nextWeek', date: '2026-11-30', time: '09:00' }, { key: 'twoWeeks', date: '2026-12-10', time: '09:00' },
  ]);
  expect(followUpChoices('2026-11-26', '16:59').map((c) => c.key)).toEqual(['laterToday', 'tomorrow', 'nextWeek', 'twoWeeks']);
  expect(followUpChoices('2026-11-26', '17:00').map((c) => c.key)).toEqual(['tomorrow', 'nextWeek', 'twoWeeks']);
});
test('localNow uses the user zone: 23:30 UTC is already the next day in Asia/Kolkata (Review Focus 5)', () => {
  expect(localNow('Asia/Kolkata', new Date('2026-11-26T23:30:00Z'))).toEqual({ day: '2026-11-27', time: '05:00' });
});
test('localNow shows midnight as 00:00 and falls back to UTC for an unknown zone', () => {
  expect(localNow('Europe/London', new Date('2026-11-27T00:05:00Z'))).toEqual({ day: '2026-11-27', time: '00:05' });
  expect(localNow('Not/AZone', new Date('2026-11-27T10:15:00Z'))).toEqual({ day: '2026-11-27', time: '10:15' });
});

test('send follow-up choices from Thu 26 Nov 2026 (mockup state 6)', () => {
  expect(sendFollowUpChoices('2026-11-26')).toEqual([
    { key: 'tomorrow', date: '2026-11-27', time: '09:00' }, { key: 'threeWorkingDays', date: '2026-12-01', time: '09:00' },
    { key: 'oneWeek', date: '2026-12-03', time: '09:00' }, { key: 'twoWeeks', date: '2026-12-10', time: '09:00' },
  ]);
  expect(DEFAULT_SEND_FOLLOW_UP).toBe('threeWorkingDays');
});
test('3 working days from Friday is Wednesday, from Saturday is Wednesday (Review Focus 5)', () => {
  expect(addWorkingDays('2026-11-27', 3)).toBe('2026-12-02');
  expect(addWorkingDays('2026-11-28', 3)).toBe('2026-12-02');
});
test('working days: from Sunday, across a month and year end, zero days', () => {
  expect(addWorkingDays('2026-11-29', 1)).toBe('2026-11-30');
  expect(addWorkingDays('2026-12-31', 3)).toBe('2027-01-05');
  expect(addWorkingDays('2026-11-26', 0)).toBe('2026-11-26');
});
test('schedule presets at 14:30 on Thu 26 Nov (mockup), none "later today" from 17:00, Monday on a Monday is next week (Review Focus 5)', () => {
  expect(schedulePresets('2026-11-26', '14:30')).toEqual([
    { key: 'laterToday', date: '2026-11-26', time: '17:00' }, { key: 'tomorrow', date: '2026-11-27', time: '08:00' },
    { key: 'monday', date: '2026-11-30', time: '08:00' },
  ]);
  expect(schedulePresets('2026-11-26', '17:00').map((p) => p.key)).toEqual(['tomorrow', 'monday']);
  expect(schedulePresets('2026-11-30', '09:00').find((p) => p.key === 'monday')!.date).toBe('2026-12-07');
});
test('instantIn: Kolkata 09:00, London 08:00 either side of the DST change, a spring-forward gap moves forward (Review Focus 5)', () => {
  expect(instantIn('2026-12-01', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-12-01T03:30:00.000Z');
  expect(instantIn('2027-03-27', '08:00', 'Europe/London').toISOString()).toBe('2027-03-27T08:00:00.000Z');
  expect(instantIn('2027-03-29', '08:00', 'Europe/London').toISOString()).toBe('2027-03-29T07:00:00.000Z');
  expect(instantIn('2027-03-28', '01:30', 'Europe/London').toISOString()).toBe('2027-03-28T01:30:00.000Z');
});
test('a Kolkata user at 23:30 UTC is already on tomorrow: presets and instants use their day (Review Focus 5)', () => {
  const now = localNow('Asia/Kolkata', new Date('2026-11-26T23:30:00Z'));
  expect(now).toEqual({ day: '2026-11-27', time: '05:00' });
  const fu = sendFollowUpChoices(now.day).find((c) => c.key === 'threeWorkingDays')!;
  expect(fu.date).toBe('2026-12-02');
  expect(instantIn(fu.date, fu.time, 'Asia/Kolkata').toISOString()).toBe('2026-12-02T03:30:00.000Z');
  expect(schedulePresets(now.day, now.time)[0]).toEqual({ key: 'laterToday', date: '2026-11-27', time: '17:00' });
});
test('instantIn falls back to UTC for an unknown zone', () => {
  expect(instantIn('2026-12-01', '09:00', 'Not/AZone').toISOString()).toBe('2026-12-01T09:00:00.000Z');
});
