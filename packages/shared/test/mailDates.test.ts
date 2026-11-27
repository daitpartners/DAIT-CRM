import { expect, test } from 'vitest';
import { addDays, flagDueDay, followUpChoices, localNow, type FlagPreset } from '../src/index.js';

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
