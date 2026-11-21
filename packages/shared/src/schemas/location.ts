import { z } from 'zod';
import { optionalText, optionalTimezone, optionalUrl } from './company.js';

export const LocationCreate = z.object({
  name: z.string().trim().min(1).max(120),
  locationType: z.string().trim().min(1).max(60),
  country: z.string().trim().min(1).max(80),
  state: optionalText(100),
  city: optionalText(100),
  street: optionalText(255),
  zip: optionalText(20),
  timezone: optionalTimezone,
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  mapsUrl: optionalUrl(),
  phone: optionalText(40),
  isVerified: z.boolean().default(false),
  source: z.string().trim().min(1).max(120).default('Manual'),
});
export type LocationCreate = z.infer<typeof LocationCreate>;

export const LocationUpdate = LocationCreate.partial().extend({ updatedAt: z.string().datetime() });
export type LocationUpdate = z.infer<typeof LocationUpdate>;
