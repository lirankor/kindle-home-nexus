import { describe, expect, it } from "vitest";
import {
  isNight,
  localMinutes,
  nightWindowFromEnv,
  parseHHMM,
  photoMinutesFromEnv,
} from "./night-window";

const berlin = nightWindowFromEnv({});
// Europe/Berlin: CEST = UTC+2 (summer), CET = UTC+1 (winter).
const cest = (M: number, D: number, h: number, m: number) =>
  new Date(Date.UTC(2026, M - 1, D, h - 2, m));
const cet = (M: number, D: number, h: number, m: number) =>
  new Date(Date.UTC(2026, M - 1, D, h - 1, m));

describe("night window", () => {
  it("parses env with defaults and validation", () => {
    // The owner's window (2026-10-16): midnight to 06:00 local, so the photo holds all night.
    expect(berlin).toEqual({ start: 0, end: 6 * 60, tz: "Europe/Berlin" });
    expect(
      nightWindowFromEnv({ NIGHT_START: "22:30", NIGHT_END: "6:45", SLEEP_TZ: "Asia/Jerusalem" }),
    ).toEqual({
      start: 22 * 60 + 30,
      end: 6 * 60 + 45,
      tz: "Asia/Jerusalem",
    });
    expect(
      nightWindowFromEnv({ NIGHT_START: "25:00", NIGHT_END: "7", SLEEP_TZ: "Mars/Olympus" }),
    ).toEqual(berlin);
    expect(parseHHMM("00:00", -1)).toBe(0);
    expect(parseHHMM("06:00", -1)).toBe(360);
    expect(parseHHMM("7:5", -1)).toBe(-1);
    expect(photoMinutesFromEnv({})).toBe(10);
    expect(photoMinutesFromEnv({ DAY_WAKE_MIN: "15" })).toBe(15);
    expect(photoMinutesFromEnv({ DAY_WAKE_MIN: "0" })).toBe(10);
  });

  it("uses local time including DST", () => {
    expect(localMinutes(cest(10, 15, 14, 3), berlin.tz)).toBe(14 * 60 + 3);
    expect(localMinutes(cet(12, 1, 0, 30), berlin.tz)).toBe(30);
    // 2026-03-29 01:00Z is 03:00 CEST (02:00 does not exist); 2026-10-25 01:00Z is 02:00 CET (second 02:00).
    expect(localMinutes(new Date(Date.UTC(2026, 2, 29, 1, 0)), berlin.tz)).toBe(3 * 60);
    expect(localMinutes(new Date(Date.UTC(2026, 9, 25, 1, 0)), berlin.tz)).toBe(2 * 60);
  });

  it("covers 00:00 up to but not including 06:00", () => {
    expect(isNight(cest(10, 15, 23, 59), berlin)).toBe(false);
    expect(isNight(cest(10, 16, 0, 0), berlin)).toBe(true); // the midnight edge is night
    expect(isNight(cest(10, 16, 3, 0), berlin)).toBe(true);
    expect(isNight(cest(10, 16, 5, 59), berlin)).toBe(true);
    expect(isNight(cest(10, 16, 6, 0), berlin)).toBe(false); // … 06:00 is not
    expect(isNight(cest(10, 16, 12, 0), berlin)).toBe(false); // plain daytime
    expect(isNight(new Date(Date.UTC(2026, 2, 29, 1, 0)), berlin)).toBe(true); // 03:00 CEST on the DST night
    expect(isNight(new Date(Date.UTC(2026, 9, 25, 1, 0)), berlin)).toBe(true); // 02:00 CET, the repeated hour
    // A window that still wraps past midnight keeps working (the owner may tune it back).
    const wrapping = nightWindowFromEnv({ NIGHT_START: "23:00", NIGHT_END: "07:00" });
    expect(isNight(cest(10, 15, 23, 30), wrapping)).toBe(true);
    expect(isNight(cest(10, 16, 6, 59), wrapping)).toBe(true);
    expect(isNight(cest(10, 16, 7, 0), wrapping)).toBe(false);
    const sameDay = nightWindowFromEnv({ NIGHT_START: "13:00", NIGHT_END: "14:00" });
    expect(isNight(cest(10, 16, 13, 30), sameDay)).toBe(true);
    expect(isNight(cest(10, 16, 14, 0), sameDay)).toBe(false);
    expect(
      isNight(cest(10, 16, 3, 0), nightWindowFromEnv({ NIGHT_START: "06:00", NIGHT_END: "06:00" })),
    ).toBe(false);
  });
});
