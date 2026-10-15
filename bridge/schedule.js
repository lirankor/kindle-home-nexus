// Wake schedule for the Kindle's sleep cycle (battery saver). Pure: no I/O, no timers.
//
// The Kindle's clock is UTC and it has no time-zone data, so the bridge decides when the panel
// wakes next and hands it a sleep length in seconds. Day: every DAY_WAKE_MIN minutes on the grid
// (:00, :10, :20 … so the badge shows round times). Night (NIGHT_START–NIGHT_END local time,
// Europe/Berlin incl. DST): one wake every NIGHT_WAKE_MIN minutes (default hourly, on the hour) —
// the screensaver photo is not rotated at night (the app enforces that; see src/lib/night-window.ts).

export const DEFAULTS = Object.freeze({
  dayWakeMin: 10,
  nightStart: "23:00",
  nightEnd: "07:00",
  nightWakeMin: 60,
  tz: "Europe/Berlin",
  minSleepSec: 60, // a grid point closer than this is skipped (the Kindle needs ~10 s awake per cycle)
});

/** "HH:MM" → minutes after local midnight; invalid → `dflt`. */
export function parseHHMM(s, dflt) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ""));
  if (!m) return dflt;
  const h = Number(m[1]),
    min = Number(m[2]);
  if (h > 23 || min > 59) return dflt;
  return h * 60 + min;
}

/** Schedule config from environment variables (strings), falling back to DEFAULTS. */
export function readConfig(env = {}) {
  const num = (k, d, lo, hi) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d;
  };
  return {
    dayWakeMin: num("DAY_WAKE_MIN", DEFAULTS.dayWakeMin, 1, 720),
    nightStart: parseHHMM(env.NIGHT_START, parseHHMM(DEFAULTS.nightStart)),
    nightEnd: parseHHMM(env.NIGHT_END, parseHHMM(DEFAULTS.nightEnd)),
    nightWakeMin: num("NIGHT_WAKE_MIN", DEFAULTS.nightWakeMin, 1, 720),
    tz: validTz(env.SLEEP_TZ) ? env.SLEEP_TZ : DEFAULTS.tz,
    minSleepSec: DEFAULTS.minSleepSec,
  };
}

function validTz(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Local wall-clock parts of an instant in `tz`. */
export function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = value;
  const hour = Number(p.hour) % 24; // some ICU builds print 24 for midnight
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    second: Number(p.second),
    secondOfDay: hour * 3600 + Number(p.minute) * 60 + Number(p.second),
    label: `${String(hour).padStart(2, "0")}:${p.minute}`,
  };
}

/** Is `ms` inside the night window (local minutes [nightStart, nightEnd), wrapping past midnight)? */
export function isNight(ms, cfg) {
  const m = Math.floor(localParts(ms, cfg.tz).secondOfDay / 60);
  const { nightStart: s, nightEnd: e } = cfg;
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

// Smallest multiple of `stepSec` that is >= `fromSec` (seconds of the local day; may run past 86400).
const gridCeil = (fromSec, stepSec) => Math.ceil(fromSec / stepSec) * stepSec;

/**
 * Next wake for a device that is about to sleep at `nowMs`.
 * Returns { night, wakeMs, sleepSec, label } — `night` says whether `nowMs` is in the night window,
 * `label` is the local HH:MM of the wake (computed from the resulting instant, so a DST jump during
 * the sleep shows the real local time; the sleep length itself is always one grid step or less).
 */
export function computeSchedule(nowMs, cfg) {
  const now = localParts(nowMs, cfg.tz);
  const L = now.secondOfDay;
  const earliest = L + cfg.minSleepSec;
  const dayStep = cfg.dayWakeMin * 60;
  const nightStep = cfg.nightWakeMin * 60;
  const night = isNight(nowMs, cfg);
  let T;
  if (night) {
    T = gridCeil(earliest, nightStep);
    // The night may end before the next night-grid point: resume day wakes right at its end.
    if (cfg.nightStart !== cfg.nightEnd) {
      let endSec = cfg.nightEnd * 60;
      if (endSec < L) endSec += 86400; // the window wraps past midnight and we are before it
      if (endSec < T) T = Math.max(gridCeil(endSec, dayStep), gridCeil(earliest, dayStep));
    }
  } else {
    T = gridCeil(earliest, dayStep);
    // Crossing into the night: snap to the night grid so the first night wake is already an hourly one.
    if (isNight(nowMs + (T - L) * 1000, cfg)) T = gridCeil(T, nightStep);
  }
  const sleepSec = T - L;
  const wakeMs = nowMs + sleepSec * 1000;
  return { night, wakeMs, sleepSec, label: localParts(wakeMs, cfg.tz).label };
}
