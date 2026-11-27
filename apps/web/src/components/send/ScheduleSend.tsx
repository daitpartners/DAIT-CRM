import { useEffect, useRef, useState } from 'react';
import { addDays, instantIn, localNow, schedulePresets, type ScheduleKey } from '@dait-crm/shared';
import { errorText } from '../../i18n/labels';
import { useLang, useT, type TFn } from '../../i18n/useT';
import { whenLabel } from '../../pages/email/sendDates';

/** How far ahead a send may be scheduled (the server's `schedule_time` rule): at least a minute, at most 365 days. */
const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_DAYS = 365;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function presetText(t: TFn, key: ScheduleKey): string {
  switch (key) {
    case 'laterToday':
      return t('Later today');
    case 'tomorrow':
      return t('Tomorrow morning');
    case 'monday':
      return t('Monday morning');
  }
}

/** Whether `at` is a time a send may be scheduled for, `now` being now. */
export function schedulable(at: Date, now: Date = new Date()): boolean {
  const ms = at.getTime() - now.getTime();
  return Number.isFinite(ms) && ms >= MIN_AHEAD_MS && ms <= MAX_AHEAD_DAYS * 86_400_000;
}

/**
 * Schedule send (mockup `.schedpop`): Later today (before 17:00), Tomorrow morning and Monday morning with their
 * times, a custom date and 24-hour time, and the recipient's time when their zone differs from the sender's. A preset
 * fills the date and time; `Schedule` hands the instant (`instantIn` the sender's `timezone`) to `onPick`.
 */
export function ScheduleSend({ timezone, recipientZone, onPick, onClose }: {
  timezone: string;
  recipientZone?: { zone: string; label: string } | null;
  onPick(at: Date): void;
  onClose(): void;
}) {
  const t = useT();
  const lang = useLang();
  const ref = useRef<HTMLDivElement>(null);
  const [now] = useState(() => localNow(timezone));
  const presets = schedulePresets(now.day, now.time);
  const first = presets.find((p) => p.key === 'tomorrow') ?? presets[0]!;
  const [day, setDay] = useState(first.date);
  const [time, setTime] = useState(first.time);

  const valid = DAY.test(day) && TIME.test(time);
  const at = valid ? instantIn(day, time, timezone) : null;
  const ok = at !== null && schedulable(at);
  // Only a zone other than the sender's (decision 19).
  const zone = recipientZone && recipientZone.zone !== timezone ? recipientZone : null;
  const theirs = zone && at ? localNow(zone.zone, at).time : null;

  // Esc and a click outside close it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('.opt.hl')?.focus();
  }, []);

  return (
    <div ref={ref} className="schedpop" role="dialog" aria-label={t('Schedule send')}>
      <h4>{t('Schedule send')}</h4>
      {presets.map((p) => (
        <button
          key={p.key}
          type="button"
          className={p.date === day && p.time === time ? 'opt hl' : 'opt'}
          onClick={() => {
            setDay(p.date);
            setTime(p.time);
          }}
        >
          {presetText(t, p.key)} <span>{whenLabel(p.date, p.time, timezone, lang)}</span>
        </button>
      ))}
      <div className="custom">
        <input
          className="in"
          type="date"
          aria-label={t('Date')}
          value={day}
          min={now.day}
          max={addDays(now.day, MAX_AHEAD_DAYS)}
          onChange={(e) => setDay(e.target.value)}
        />
        {/* A text field, not type="time": the browser would show 12-hour times in some languages; the CRM is 24-hour. */}
        <input className="in" inputMode="numeric" maxLength={5} placeholder="HH:MM" aria-label={t('Time (24-hour)')} value={time} onChange={(e) => setTime(e.target.value.trim())} />
      </div>
      {valid && !ok ? <div className="err">{errorText(t, 'schedule_time')}</div> : null}
      {zone && theirs ? (
        <div className="tz">{t("Recipient's time: {label} — sent at their {time}", { label: zone.label, time: theirs })}</div>
      ) : null}
      <div className="act">
        <button type="button" className="btn xs" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className="btn xs primary" disabled={!ok} onClick={() => at && onPick(at)}>{t('Schedule')}</button>
      </div>
    </div>
  );
}
