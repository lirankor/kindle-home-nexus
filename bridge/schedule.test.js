import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSchedule, isNight, localParts, parseHHMM, readConfig } from "./schedule.js";

const cfg = readConfig({});
// Europe/Berlin: CEST (UTC+2) in summer, CET (UTC+1) in winter.
const cest = (M, D, h, m, s = 0) => Date.UTC(2026, M - 1, D, h - 2, m, s);
const cet = (M, D, h, m, s = 0) => Date.UTC(2026, M - 1, D, h - 1, m, s);

test("config: defaults and validation", () => {
  assert.deepEqual(cfg, {
    dayWakeMin: 10,
    nightStart: 23 * 60,
    nightEnd: 7 * 60,
    nightWakeMin: 60,
    tz: "Europe/Berlin",
    minSleepSec: 60,
  });
  const c = readConfig({
    DAY_WAKE_MIN: "15",
    NIGHT_START: "22:30",
    NIGHT_END: "6:45",
    NIGHT_WAKE_MIN: "30",
    SLEEP_TZ: "Asia/Jerusalem",
  });
  assert.deepEqual(
    [c.dayWakeMin, c.nightStart, c.nightEnd, c.nightWakeMin, c.tz],
    [15, 22 * 60 + 30, 6 * 60 + 45, 30, "Asia/Jerusalem"],
  );
  const bad = readConfig({
    DAY_WAKE_MIN: "x",
    NIGHT_START: "25:00",
    NIGHT_END: "7",
    NIGHT_WAKE_MIN: "0",
    SLEEP_TZ: "Mars/Olympus",
  });
  assert.deepEqual(bad, cfg);
  assert.equal(parseHHMM("07:00", -1), 420);
  assert.equal(parseHHMM("7:5", -1), -1);
});

test("local parts follow DST", () => {
  assert.equal(localParts(cest(10, 15, 14, 3), cfg.tz).label, "14:03");
  assert.equal(localParts(cet(12, 1, 0, 30), cfg.tz).label, "00:30");
  assert.equal(localParts(cet(12, 1, 0, 30), cfg.tz).secondOfDay, 1800);
});

test("night window wraps past midnight", () => {
  assert.equal(isNight(cest(10, 15, 22, 59), cfg), false);
  assert.equal(isNight(cest(10, 15, 23, 0), cfg), true);
  assert.equal(isNight(cest(10, 16, 3, 0), cfg), true);
  assert.equal(isNight(cest(10, 16, 6, 59), cfg), true);
  assert.equal(isNight(cest(10, 16, 7, 0), cfg), false);
  assert.equal(isNight(cest(10, 16, 12, 0), cfg), false);
  const sameDay = readConfig({ NIGHT_START: "13:00", NIGHT_END: "14:00" });
  assert.equal(isNight(cest(10, 16, 13, 30), sameDay), true);
  assert.equal(isNight(cest(10, 16, 14, 0), sameDay), false);
  const never = readConfig({ NIGHT_START: "07:00", NIGHT_END: "07:00" });
  assert.equal(isNight(cest(10, 16, 3, 0), never), false);
});

test("day: next 10-minute grid point, at least a minute away", () => {
  let s = computeSchedule(cest(10, 15, 14, 3), cfg);
  assert.deepEqual([s.night, s.sleepSec, s.label], [false, 420, "14:10"]);
  s = computeSchedule(cest(10, 15, 14, 10), cfg);
  assert.deepEqual([s.sleepSec, s.label], [600, "14:20"]);
  s = computeSchedule(cest(10, 15, 14, 9, 30), cfg); // 14:10 is only 30 s away: skip it
  assert.deepEqual([s.sleepSec, s.label], [630, "14:20"]);
  s = computeSchedule(cest(10, 15, 14, 9, 0), cfg); // exactly 60 s away is fine
  assert.deepEqual([s.sleepSec, s.label], [60, "14:10"]);
});

test("night: hourly on the hour, no wake longer than the night step", () => {
  let s = computeSchedule(cest(10, 15, 23, 0, 5), cfg);
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 3595, "00:00"]);
  s = computeSchedule(cest(10, 16, 0, 0), cfg);
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 3600, "01:00"]);
  s = computeSchedule(cest(10, 16, 3, 59, 30), cfg);
  assert.deepEqual([s.sleepSec, s.label], [3630, "05:00"]);
  const half = readConfig({ NIGHT_WAKE_MIN: "30" });
  s = computeSchedule(cest(10, 16, 1, 10), half);
  assert.deepEqual([s.sleepSec, s.label], [1200, "01:30"]);
});

test("day -> night: the last day wake lands on the night grid", () => {
  let s = computeSchedule(cest(10, 15, 22, 55), cfg);
  assert.deepEqual([s.night, s.sleepSec, s.label], [false, 300, "23:00"]);
  // Night starting off the day grid: snap to the hour.
  const late = readConfig({ NIGHT_START: "23:15" });
  s = computeSchedule(cest(10, 15, 23, 12), late);
  assert.deepEqual([s.night, s.label], [false, "00:00"]);
  assert.equal(s.sleepSec, 48 * 60);
});

test("night -> day: day wakes resume at the night's end", () => {
  let s = computeSchedule(cest(10, 16, 6, 0), cfg);
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 3600, "07:00"]);
  s = computeSchedule(cest(10, 16, 6, 59, 30), cfg); // 07:00 too close: first day slot after it
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 630, "07:10"]);
  const odd = readConfig({ NIGHT_END: "07:05" });
  s = computeSchedule(cest(10, 16, 6, 30), odd); // 07:00 is still night (hourly grid) …
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 1800, "07:00"]);
  s = computeSchedule(s.wakeMs, odd); // … then the first day slot after 07:05
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 600, "07:10"]);
  const never = readConfig({ NIGHT_START: "07:00", NIGHT_END: "07:00" });
  s = computeSchedule(cest(10, 16, 3, 0), never);
  assert.deepEqual([s.night, s.sleepSec], [false, 600]);
});

test("DST spring forward (2026-03-29 02:00 -> 03:00): still one hour of sleep", () => {
  const s = computeSchedule(Date.UTC(2026, 2, 29, 0, 0), cfg); // 01:00 CET
  assert.deepEqual([s.night, s.sleepSec, s.label], [true, 3600, "03:00"]);
  const next = computeSchedule(s.wakeMs, cfg);
  assert.deepEqual([next.sleepSec, next.label], [3600, "04:00"]);
});

test("DST fall back (2026-10-25 03:00 -> 02:00): hourly through the repeated hour", () => {
  const a = computeSchedule(Date.UTC(2026, 9, 25, 0, 0), cfg); // 02:00 CEST (first)
  assert.deepEqual([a.night, a.sleepSec, a.label], [true, 3600, "02:00"]);
  const b = computeSchedule(a.wakeMs, cfg); // 02:00 CET (second)
  assert.deepEqual([b.night, b.sleepSec, b.label], [true, 3600, "03:00"]);
  const c = computeSchedule(b.wakeMs, cfg);
  assert.deepEqual([c.sleepSec, c.label], [3600, "04:00"]);
});

test("sweep: every wake is bounded by its step and lands on the grid", () => {
  let t = cest(10, 15, 7, 0, 17);
  const end = t + 2 * 86400 * 1000;
  while (t < end) {
    const s = computeSchedule(t, cfg);
    const step = (s.night ? cfg.nightWakeMin : cfg.dayWakeMin) * 60;
    assert.ok(
      s.sleepSec >= cfg.minSleepSec && s.sleepSec <= step + cfg.minSleepSec,
      `${new Date(t).toISOString()} -> ${s.sleepSec}`,
    );
    const lp = localParts(s.wakeMs, cfg.tz);
    assert.equal(lp.secondOfDay % 600, 0, `off grid at ${lp.label}`);
    t = s.wakeMs + 1000 * 7; // ~7 s awake per cycle
  }
});
