import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSchedule, isNight, localParts, parseHHMM, readConfig } from "./schedule.js";

const cfg = readConfig({});
// Europe/Berlin: CEST (UTC+2) in summer, CET (UTC+1) in winter.
const cest = (M, D, h, m, s = 0) => Date.UTC(2026, M - 1, D, h - 2, m, s);
const cet = (M, D, h, m, s = 0) => Date.UTC(2026, M - 1, D, h - 1, m, s);

test("config: defaults (owner's 2026-10-16 window) and validation", () => {
  assert.deepEqual(cfg, {
    dayWakeMin: 10,
    nightStart: 0, // 00:00
    nightEnd: 6 * 60, // 06:00
    nightWakeMin: 120, // every two hours
    tz: "Europe/Berlin",
    minWindowSec: 60,
  });
  const c = readConfig({
    DAY_WAKE_MIN: "15",
    NIGHT_START: "23:00",
    NIGHT_END: "7:00",
    NIGHT_WAKE_MIN: "60",
    SLEEP_TZ: "Asia/Jerusalem",
  });
  assert.deepEqual(
    [c.dayWakeMin, c.nightStart, c.nightEnd, c.nightWakeMin, c.tz],
    [15, 23 * 60, 7 * 60, 60, "Asia/Jerusalem"],
  );
  const bad = readConfig({
    DAY_WAKE_MIN: "x",
    NIGHT_START: "25:00",
    NIGHT_END: "7",
    NIGHT_WAKE_MIN: "0",
    SLEEP_TZ: "Mars/Olympus",
  });
  assert.deepEqual(bad, cfg);
  assert.equal(parseHHMM("00:00", -1), 0);
  assert.equal(parseHHMM("06:00", -1), 360);
  assert.equal(parseHHMM("7:5", -1), -1);
});

test("local parts follow DST", () => {
  assert.equal(localParts(cest(10, 15, 14, 3), cfg.tz).label, "14:03");
  assert.equal(localParts(cet(12, 1, 0, 30), cfg.tz).label, "00:30");
  assert.equal(localParts(cet(12, 1, 0, 30), cfg.tz).secondOfDay, 1800);
});

test("night window is 00:00-06:00 local, no wrap past midnight", () => {
  assert.equal(isNight(cest(10, 15, 23, 59, 59), cfg), false);
  assert.equal(isNight(cest(10, 16, 0, 0), cfg), true); // the 00:00 edge belongs to the night
  assert.equal(isNight(cest(10, 16, 3, 0), cfg), true);
  assert.equal(isNight(cest(10, 16, 5, 59, 59), cfg), true);
  assert.equal(isNight(cest(10, 16, 6, 0), cfg), false); // … 06:00 does not
  assert.equal(isNight(cest(10, 16, 12, 0), cfg), false);
  const never = readConfig({ NIGHT_START: "06:00", NIGHT_END: "06:00" });
  assert.equal(isNight(cest(10, 16, 3, 0), never), false);
});

test("day: next 10-minute grid point, at least a minute away", () => {
  let s = computeSchedule(cest(10, 15, 14, 3), cfg);
  assert.deepEqual([s.night, s.windowSec, s.label], [false, 420, "14:10"]);
  s = computeSchedule(cest(10, 15, 14, 10), cfg);
  assert.deepEqual([s.windowSec, s.label], [600, "14:20"]);
  s = computeSchedule(cest(10, 15, 14, 9, 30), cfg); // 14:10 is only 30 s away: skip it
  assert.deepEqual([s.windowSec, s.label], [630, "14:20"]);
  s = computeSchedule(cest(10, 15, 14, 9, 0), cfg); // exactly 60 s away is fine
  assert.deepEqual([s.windowSec, s.label], [60, "14:10"]);
});

test("night: one update every two hours on the even hour", () => {
  let s = computeSchedule(cest(10, 16, 0, 0), cfg); // the 00:00 edge
  assert.deepEqual([s.night, s.windowSec, s.label], [true, 7200, "02:00"]);
  s = computeSchedule(cest(10, 16, 0, 0, 5), cfg);
  assert.deepEqual([s.night, s.windowSec, s.label], [true, 7195, "02:00"]);
  s = computeSchedule(cest(10, 16, 2, 0), cfg);
  assert.deepEqual([s.windowSec, s.label], [7200, "04:00"]);
  s = computeSchedule(cest(10, 16, 4, 0), cfg);
  assert.deepEqual([s.windowSec, s.label], [7200, "06:00"]); // the last night update is the night's end
  s = computeSchedule(cest(10, 16, 1, 10), cfg); // woken off-grid by a key: back onto the grid
  assert.deepEqual([s.windowSec, s.label], [3000, "02:00"]);
});

test("day -> night: the last day update lands on the night grid", () => {
  let s = computeSchedule(cest(10, 15, 23, 41), cfg); // still well inside the day grid
  assert.deepEqual([s.night, s.windowSec, s.label], [false, 540, "23:50"]);
  s = computeSchedule(cest(10, 15, 23, 55), cfg); // the next day point is already night: snap to it
  assert.deepEqual([s.night, s.windowSec, s.label], [false, 300, "00:00"]);
  // A night that does not start on the day grid snaps forward to the night grid.
  const late = readConfig({ NIGHT_START: "23:15", NIGHT_END: "06:00" });
  s = computeSchedule(cest(10, 15, 23, 12), late);
  assert.deepEqual([s.night, s.windowSec, s.label], [false, 48 * 60, "00:00"]);
});

test("night -> day: 10-minute updates resume at 06:00", () => {
  let s = computeSchedule(cest(10, 16, 5, 50), cfg);
  assert.deepEqual([s.night, s.windowSec, s.label], [true, 600, "06:00"]);
  s = computeSchedule(cest(10, 16, 5, 59, 30), cfg); // 06:00 too close: first day slot after it
  assert.deepEqual([s.night, s.windowSec, s.label], [true, 630, "06:10"]);
  s = computeSchedule(cest(10, 16, 6, 0), cfg);
  assert.deepEqual([s.night, s.windowSec, s.label], [false, 600, "06:10"]);
  const odd = readConfig({ NIGHT_START: "00:00", NIGHT_END: "06:05" });
  s = computeSchedule(cest(10, 16, 4, 0), odd); // 06:00 is still night (2 h grid) …
  assert.deepEqual([s.night, s.windowSec, s.label], [true, 7200, "06:00"]);
  s = computeSchedule(s.wakeMs, odd); // … then the first day slot after 06:05
  assert.deepEqual([s.night, s.windowSec, s.label], [true, 600, "06:10"]);
});

test("DST spring forward (2026-03-29 02:00 -> 03:00) inside the night window", () => {
  const a = computeSchedule(cet(3, 29, 0, 0), cfg); // 00:00 CET
  // Two hours of real time, but 02:00 local never happens: the device wakes at 03:00 CEST.
  assert.deepEqual([a.night, a.windowSec, a.label], [true, 7200, "03:00"]);
  const b = computeSchedule(a.wakeMs, cfg); // back onto the even-hour grid
  assert.deepEqual([b.night, b.windowSec, b.label], [true, 3600, "04:00"]);
  const c = computeSchedule(b.wakeMs, cfg);
  assert.deepEqual([c.night, c.windowSec, c.label], [true, 7200, "06:00"]);
});

test("DST fall back (2026-10-25 03:00 -> 02:00) inside the night window", () => {
  const a = computeSchedule(cest(10, 25, 0, 0), cfg); // 00:00 CEST
  assert.deepEqual([a.night, a.windowSec, a.label], [true, 7200, "02:00"]);
  const b = computeSchedule(a.wakeMs, cfg); // 02:00 CEST + 2 h real = 03:00 CET (the hour repeats)
  assert.deepEqual([b.night, b.windowSec, b.label], [true, 7200, "03:00"]);
  const c = computeSchedule(b.wakeMs, cfg); // one extra update, then the grid is clean again
  assert.deepEqual([c.night, c.windowSec, c.label], [true, 3600, "04:00"]);
  const d = computeSchedule(c.wakeMs, cfg);
  assert.deepEqual([d.night, d.windowSec, d.label], [true, 7200, "06:00"]);
});

test("sweep: every window is bounded by its step and lands on the grid", () => {
  let t = cest(10, 15, 7, 0, 17);
  const end = t + 2 * 86400 * 1000;
  let night = 0;
  while (t < end) {
    const s = computeSchedule(t, cfg);
    const step = (s.night ? cfg.nightWakeMin : cfg.dayWakeMin) * 60;
    assert.ok(
      s.windowSec >= cfg.minWindowSec && s.windowSec <= step + cfg.minWindowSec,
      `${new Date(t).toISOString()} -> ${s.windowSec}`,
    );
    const lp = localParts(s.wakeMs, cfg.tz);
    assert.equal(lp.secondOfDay % 600, 0, `off grid at ${lp.label}`);
    if (s.night) night++;
    t = s.wakeMs + 1000 * 8; // ~8 s of radio per cycle
  }
  // Two nights x three in-night updates (~00:00 -> 02:00 -> 04:00 -> 06:00, where 06:00 ends the night
  // and is already a day update): six radio-on cycles between midnight and 06:00, not 2 x 36.
  assert.equal(night, 6);
});
