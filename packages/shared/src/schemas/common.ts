import { z } from 'zod';
import { safeUrl } from '../safeUrl.js';
import { Timezone } from './user.js';

/** '' or whitespace-only strings become null; anything else passes through. */
export const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Optional free text: trimmed; '' (or whitespace) becomes null so the column is cleared. */
export const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullish());

/** Optional link: must pass safeUrl and be http(s); bare hosts get https://. */
export const optionalUrl = (max = 255) =>
  z.preprocess(
    blankToNull,
    z.string().nullish().transform((v, ctx) => {
      if (v == null) return v;
      const url = safeUrl(v);
      let ok = !!url && /^https?:\/\//i.test(url) && url.length <= max;
      if (ok) {
        try { new URL(url!); } catch { ok = false; }
      }
      if (!ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid URL' });
        return z.NEVER;
      }
      return url;
    }),
  );

/** Optional email: trimmed and lower-cased; '' becomes null. */
export const optionalEmail = (max = 255) =>
  z.preprocess(blankToNull, z.string().trim().toLowerCase().max(max).email().nullish());

export const optionalTimezone = z.preprocess(blankToNull, Timezone.nullish());
