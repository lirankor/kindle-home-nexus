// Night window for the screensaver (battery saver): between NIGHT_START and NIGHT_END local time
// (SLEEP_TZ, default Europe/Berlin, DST-aware via Intl) the photo is not rotated — the same picture
// stays up all night while the Kindle sleeps, waking once an hour for the readings and the badge.
// The bridge computes the matching wake schedule from the same env values (bridge/schedule.js).

export type NightWindow = { start: number; end: number; tz: string };

export const NIGHT_DEFAULTS: NightWindow = { start: 23 * 60, end: 7 * 60, tz: "Europe/Berlin" };

/** "HH:MM" → minutes after local midnight; invalid → `dflt`. */
export function parseHHMM(s: string | undefined | null, dflt: number): number {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s ?? "");
  if (!m) return dflt;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? dflt : h * 60 + min;
}

function validTz(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function nightWindowFromEnv(
  env: Record<string, string | undefined> = process.env,
): NightWindow {
  return {
    start: parseHHMM(env["NIGHT_START"], NIGHT_DEFAULTS.start),
    end: parseHHMM(env["NIGHT_END"], NIGHT_DEFAULTS.end),
    tz: validTz(env["SLEEP_TZ"]) ? env["SLEEP_TZ"] : NIGHT_DEFAULTS.tz,
  };
}

/** Minutes after local midnight of `date` in `tz`. */
export function localMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** Is `date` inside the night window (wrapping past midnight when start > end)? */
export function isNight(date: Date, w: NightWindow): boolean {
  if (w.start === w.end) return false;
  const m = localMinutes(date, w.tz);
  return w.start < w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end;
}

/** Day-time photo rotation period in minutes (DAY_WAKE_MIN, the Kindle's day wake interval). */
export function photoMinutesFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["DAY_WAKE_MIN"]);
  return Number.isFinite(n) && n >= 1 && n <= 720 ? Math.round(n) : 10;
}
