/**
 * Recipient time zones for the Mailer's "only send in working hours" (release 2C; owner: the client's working hours).
 * First that applies: the company's own Time zone; the address (state / province / major city) in countries with
 * several zones; the country; else the sender's zone. A multi-zone country with no usable state or city gives all its
 * main zones, and mail goes only when it is working time in every one of them.
 */

export type TimezoneSource = 'company' | 'address' | 'country' | 'sender';

const key = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();

export const US_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
const CA_ZONES = ['America/Halifax', 'America/Toronto', 'America/Winnipeg', 'America/Edmonton', 'America/Vancouver'];
const MX_ZONES = ['America/Tijuana', 'America/Mazatlan', 'America/Mexico_City', 'America/Cancun'];
const BR_ZONES = ['America/Sao_Paulo', 'America/Manaus'];
const AU_ZONES = ['Australia/Perth', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Sydney'];

const ET = 'America/New_York', CT = 'America/Chicago', MT = 'America/Denver', PT = 'America/Los_Angeles';
/** US states and DC: name and postal code. Alaska / Hawaii / Arizona have their own zones. */
const US_STATES: Record<string, string> = {};
for (const [zone, list] of [
  [ET, 'Connecticut CT|Delaware DE|District of Columbia DC|Washington DC DC|Florida FL|Georgia GA|Indiana IN|Kentucky KY|Maine ME|Maryland MD|Massachusetts MA|Michigan MI|New Hampshire NH|New Jersey NJ|New York NY|North Carolina NC|Ohio OH|Pennsylvania PA|Rhode Island RI|South Carolina SC|Vermont VT|Virginia VA|West Virginia WV'],
  [CT, 'Alabama AL|Arkansas AR|Illinois IL|Iowa IA|Kansas KS|Louisiana LA|Minnesota MN|Mississippi MS|Missouri MO|Nebraska NE|North Dakota ND|Oklahoma OK|South Dakota SD|Tennessee TN|Texas TX|Wisconsin WI'],
  [MT, 'Colorado CO|Idaho ID|Montana MT|New Mexico NM|Utah UT|Wyoming WY'],
  [PT, 'California CA|Nevada NV|Oregon OR|Washington WA'],
  ['America/Phoenix', 'Arizona AZ'],
  ['America/Anchorage', 'Alaska AK'],
  ['Pacific/Honolulu', 'Hawaii HI'],
] as const) {
  for (const entry of list.split('|')) {
    const code = entry.slice(entry.lastIndexOf(' ') + 1);
    US_STATES[key(entry.slice(0, entry.lastIndexOf(' ')))] = zone;
    US_STATES[key(code)] = zone;
  }
}
const US_CITIES: Record<string, string> = Object.fromEntries(
  ([
    [ET, 'new york|new york city|nyc|brooklyn|boston|philadelphia|miami|atlanta|washington|baltimore|pittsburgh|charlotte|orlando|tampa|detroit|columbus|cleveland|cincinnati|indianapolis|jacksonville|raleigh|richmond|newark|jersey city|buffalo|hartford'],
    [CT, 'chicago|houston|dallas|austin|san antonio|fort worth|nashville|memphis|new orleans|kansas city|st louis|saint louis|minneapolis|milwaukee|oklahoma city|omaha|plano|irving'],
    [MT, 'denver|salt lake city|albuquerque|boise|colorado springs'],
    [PT, 'los angeles|san francisco|san diego|san jose|seattle|portland|sacramento|las vegas|oakland|irvine|palo alto|mountain view|santa clara|bellevue|redmond|fresno|long beach'],
    ['America/Phoenix', 'phoenix|scottsdale|tucson|tempe|mesa'],
  ] as const).flatMap(([zone, list]) => list.split('|').map((c) => [c, zone])),
);

const CA_PROVINCES: Record<string, string> = Object.fromEntries(
  ([
    ['America/Toronto', 'ontario|on|quebec|qc'],
    ['America/Halifax', 'nova scotia|ns|new brunswick|nb|prince edward island|pe|pei'],
    ['America/St_Johns', 'newfoundland and labrador|newfoundland|nl'],
    ['America/Winnipeg', 'manitoba|mb'],
    ['America/Regina', 'saskatchewan|sk'],
    ['America/Edmonton', 'alberta|ab|northwest territories|nt'],
    ['America/Vancouver', 'british columbia|bc|yukon|yt'],
  ] as const).flatMap(([zone, list]) => list.split('|').map((c) => [c, zone])),
);
const CA_CITIES: Record<string, string> = Object.fromEntries(
  ([
    ['America/Toronto', 'toronto|montreal|ottawa|mississauga|quebec city|brampton|hamilton|markham|waterloo|kitchener|london|laval|gatineau'],
    ['America/Halifax', 'halifax|moncton|fredericton|charlottetown'],
    ['America/Winnipeg', 'winnipeg'],
    ['America/Regina', 'regina|saskatoon'],
    ['America/Edmonton', 'calgary|edmonton'],
    ['America/Vancouver', 'vancouver|victoria|surrey|burnaby|richmond|kelowna'],
    ['America/St_Johns', "st john's|st johns"],
  ] as const).flatMap(([zone, list]) => list.split('|').map((c) => [c, zone])),
);

const MX_STATES: Record<string, string> = Object.fromEntries(
  ([
    ['America/Tijuana', 'baja california|bc'],
    ['America/Mazatlan', 'baja california sur|bcs|sinaloa|nayarit'],
    ['America/Hermosillo', 'sonora'],
    ['America/Cancun', 'quintana roo'],
    ['America/Chihuahua', 'chihuahua'],
  ] as const).flatMap(([zone, list]) => list.split('|').map((c) => [c, zone])),
);
const MX_CITIES: Record<string, string> = {
  tijuana: 'America/Tijuana', mexicali: 'America/Tijuana', ensenada: 'America/Tijuana',
  'la paz': 'America/Mazatlan', mazatlan: 'America/Mazatlan', culiacan: 'America/Mazatlan', hermosillo: 'America/Hermosillo',
  cancun: 'America/Cancun', 'playa del carmen': 'America/Cancun', chihuahua: 'America/Chihuahua', 'ciudad juarez': 'America/Ciudad_Juarez',
  monterrey: 'America/Monterrey', guadalajara: 'America/Mexico_City', 'mexico city': 'America/Mexico_City', 'ciudad de mexico': 'America/Mexico_City',
  cdmx: 'America/Mexico_City', puebla: 'America/Mexico_City', queretaro: 'America/Mexico_City', merida: 'America/Merida',
};
const BR_STATES: Record<string, string> = Object.fromEntries(
  ([
    ['America/Manaus', 'amazonas|am|roraima|rr|rondonia|ro'],
    ['America/Cuiaba', 'mato grosso|mt|mato grosso do sul|ms'],
    ['America/Rio_Branco', 'acre|ac'],
  ] as const).flatMap(([zone, list]) => list.split('|').map((c) => [c, zone])),
);
const AU_STATES: Record<string, string> = Object.fromEntries(
  ([
    ['Australia/Sydney', 'new south wales|nsw|australian capital territory|act'],
    ['Australia/Melbourne', 'victoria|vic'],
    ['Australia/Hobart', 'tasmania|tas'],
    ['Australia/Brisbane', 'queensland|qld'],
    ['Australia/Adelaide', 'south australia|sa'],
    ['Australia/Darwin', 'northern territory|nt'],
    ['Australia/Perth', 'western australia|wa'],
  ] as const).flatMap(([zone, list]) => list.split('|').map((c) => [c, zone])),
);
const AU_CITIES: Record<string, string> = {
  sydney: 'Australia/Sydney', canberra: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane',
  adelaide: 'Australia/Adelaide', perth: 'Australia/Perth', darwin: 'Australia/Darwin', hobart: 'Australia/Hobart',
};

type Rule = { zones: string[]; states?: Record<string, string>; cities?: Record<string, string> };
const multi = (zones: string[], states: Record<string, string>, cities: Record<string, string> = {}): Rule => ({ zones, states, cities });
const one = (zone: string, states?: Record<string, string>): Rule => ({ zones: [zone], states });

const CANARY = { canarias: 'Atlantic/Canary', 'canary islands': 'Atlantic/Canary', 'islas canarias': 'Atlantic/Canary', 'las palmas': 'Atlantic/Canary', 'santa cruz de tenerife': 'Atlantic/Canary', tenerife: 'Atlantic/Canary' };
const COUNTRIES: Record<string, Rule> = {};
const add = (names: string, rule: Rule) => names.split('|').forEach((n) => (COUNTRIES[key(n)] = rule));
add('United States|United States of America|USA|US|U S A|America', multi(US_ZONES, US_STATES, US_CITIES));
add('Canada', multi(CA_ZONES, CA_PROVINCES, CA_CITIES));
add('Mexico|México', multi(MX_ZONES, MX_STATES, MX_CITIES));
add('Brazil|Brasil', multi(BR_ZONES, BR_STATES));
add('Australia', multi(AU_ZONES, AU_STATES, AU_CITIES));
add('Spain|España', one('Europe/Madrid', CANARY));
add('Portugal', one('Europe/Lisbon', { azores: 'Atlantic/Azores', acores: 'Atlantic/Azores', madeira: 'Atlantic/Madeira' }));
for (const [names, zone] of [
  ['India', 'Asia/Kolkata'], ['United Kingdom|UK|Great Britain|England|Scotland|Wales|Northern Ireland', 'Europe/London'],
  ['Ireland', 'Europe/Dublin'], ['Germany|Deutschland', 'Europe/Berlin'], ['France', 'Europe/Paris'], ['Italy|Italia', 'Europe/Rome'],
  ['Netherlands|The Netherlands|Holland', 'Europe/Amsterdam'], ['Belgium', 'Europe/Brussels'], ['Switzerland', 'Europe/Zurich'],
  ['Austria', 'Europe/Vienna'], ['Sweden', 'Europe/Stockholm'], ['Norway', 'Europe/Oslo'], ['Denmark', 'Europe/Copenhagen'],
  ['Finland', 'Europe/Helsinki'], ['Poland', 'Europe/Warsaw'], ['Czechia|Czech Republic', 'Europe/Prague'], ['Greece', 'Europe/Athens'],
  ['Turkey|Türkiye', 'Europe/Istanbul'], ['United Arab Emirates|UAE', 'Asia/Dubai'], ['Saudi Arabia', 'Asia/Riyadh'], ['Qatar', 'Asia/Qatar'],
  ['Israel', 'Asia/Jerusalem'], ['Singapore', 'Asia/Singapore'], ['Japan', 'Asia/Tokyo'], ['South Korea|Korea', 'Asia/Seoul'],
  ['China', 'Asia/Shanghai'], ['Hong Kong', 'Asia/Hong_Kong'], ['Philippines', 'Asia/Manila'], ['Malaysia', 'Asia/Kuala_Lumpur'],
  ['Thailand', 'Asia/Bangkok'], ['Vietnam|Viet Nam', 'Asia/Ho_Chi_Minh'], ['Pakistan', 'Asia/Karachi'], ['Bangladesh', 'Asia/Dhaka'],
  ['Sri Lanka', 'Asia/Colombo'], ['Nepal', 'Asia/Kathmandu'], ['South Africa', 'Africa/Johannesburg'], ['Nigeria', 'Africa/Lagos'],
  ['Kenya', 'Africa/Nairobi'], ['Egypt', 'Africa/Cairo'], ['New Zealand', 'Pacific/Auckland'],
  ['Chile', 'America/Santiago'], ['Argentina', 'America/Argentina/Buenos_Aires'], ['Colombia', 'America/Bogota'], ['Peru|Perú', 'America/Lima'],
  ['Venezuela', 'America/Caracas'], ['Ecuador', 'America/Guayaquil'], ['Guatemala', 'America/Guatemala'], ['Cuba', 'America/Havana'],
  ['Bolivia', 'America/La_Paz'], ['Dominican Republic|República Dominicana', 'America/Santo_Domingo'], ['Honduras', 'America/Tegucigalpa'],
  ['Paraguay', 'America/Asuncion'], ['El Salvador', 'America/El_Salvador'], ['Nicaragua', 'America/Managua'],
  ['Costa Rica', 'America/Costa_Rica'], ['Panama|Panamá', 'America/Panama'], ['Uruguay', 'America/Montevideo'], ['Puerto Rico', 'America/Puerto_Rico'],
] as const) add(names, one(zone));

/** True for a time zone this runtime knows. */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezones(
  a: { companyTimezone?: string | null; country?: string | null; state?: string | null; city?: string | null },
  senderTimezone: string,
): { zones: string[]; source: TimezoneSource } {
  if (isValidTimezone(a.companyTimezone)) return { zones: [a.companyTimezone], source: 'company' };
  const rule = COUNTRIES[key(a.country)];
  if (!rule) return { zones: [senderTimezone], source: 'sender' };
  const byState = rule.states?.[key(a.state)];
  if (byState) return { zones: [byState], source: 'address' };
  const byCity = rule.cities?.[key(a.city)] ?? rule.states?.[key(a.city)];
  if (byCity) return { zones: [byCity], source: 'address' };
  return { zones: rule.zones, source: 'country' };
}

/** Working hours in a zone: Monday–Friday, 09:00 to before 18:00 local time. */
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 18;

/** True when `at` is working time in every one of `zones`. */
export function inWorkingHours(zones: string[], at: Date): boolean {
  return zones.every((timeZone) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return weekday !== 'Sat' && weekday !== 'Sun' && hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
  });
}

/** The country whose main zones these are, when a recipient's zone is "all zones of a country" (for labels). */
export function allZonesOf(zones: string[]): string | null {
  const k = zones.join(',');
  if (k === US_ZONES.join(',')) return 'United States';
  if (k === CA_ZONES.join(',')) return 'Canada';
  if (k === MX_ZONES.join(',')) return 'Mexico';
  if (k === BR_ZONES.join(',')) return 'Brazil';
  if (k === AU_ZONES.join(',')) return 'Australia';
  return null;
}
