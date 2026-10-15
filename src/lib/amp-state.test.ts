import { describe, expect, it } from "vitest";
import { AMP_XML_GRACE_MS, deriveAmpPower, shouldCyclePlug } from "./amp-state";

const now = 1_000_000;
const on = { power: true, input: "SERVER" };
const standby = { power: false, input: null };

describe("deriveAmpPower", () => {
  it("plug on, XML says Standby: off, even while HA still says on", () => {
    const v = deriveAmpPower({ xml: standby, cached: null, now, haState: "on", plugOn: true });
    expect(v).toMatchObject({ on: false, available: true, via: "xml" });
  });
  it("XML says On: on, whatever HA says (ynca dropped / stale off)", () => {
    expect(
      deriveAmpPower({ xml: on, cached: null, now, haState: "unavailable", plugOn: true }),
    ).toMatchObject({ on: true, available: true, via: "xml", input: "SERVER" });
    expect(deriveAmpPower({ xml: on, cached: null, now, haState: "off", plugOn: true }).on).toBe(
      true,
    );
  });
  it("XML silent within the grace: the last good answer still counts", () => {
    const v = deriveAmpPower({
      xml: null,
      cached: { at: now - 4000, value: on },
      now,
      haState: "unavailable",
      plugOn: true,
    });
    expect(v).toMatchObject({ on: true, via: "xml-cached" });
  });
  it("XML silent for 10 s with the plug on and HA unavailable: unknown, shown as off", () => {
    const v = deriveAmpPower({
      xml: null,
      cached: { at: now - AMP_XML_GRACE_MS, value: on },
      now,
      haState: "unavailable",
      plugOn: true,
    });
    expect(v).toEqual({ on: false, available: false, via: "unknown", input: null });
  });
  it("plug off: off, whatever HA remembers", () => {
    const v = deriveAmpPower({
      xml: null,
      cached: { at: now - 60_000, value: on },
      now,
      haState: "playing",
      plugOn: false,
    });
    expect(v).toMatchObject({ on: false, available: true, via: "plug-off" });
  });
  it("no XML (AMP_HOST unset) and the plug on: HA decides", () => {
    expect(
      deriveAmpPower({ xml: null, cached: null, now, haState: "idle", plugOn: true }),
    ).toMatchObject({ on: true, via: "ha" });
    expect(
      deriveAmpPower({ xml: null, cached: null, now, haState: "off", plugOn: null }),
    ).toMatchObject({ on: false, available: true, via: "ha" });
  });
});

describe("shouldCyclePlug", () => {
  it("plug on, tcp 80 closed, HA does not see the amp on: cycle", () => {
    expect(shouldCyclePlug({ plugOn: true, tcp80Open: false, haState: "unavailable" })).toBe(true);
    expect(shouldCyclePlug({ plugOn: true, tcp80Open: false, haState: "off" })).toBe(true);
    expect(shouldCyclePlug({ plugOn: true, tcp80Open: false, haState: null })).toBe(true);
  });
  it("never when the plug is off (plain plug-on path), tcp 80 answers, or HA sees the amp on", () => {
    expect(shouldCyclePlug({ plugOn: false, tcp80Open: false, haState: "unavailable" })).toBe(
      false,
    );
    expect(shouldCyclePlug({ plugOn: null, tcp80Open: false, haState: "unavailable" })).toBe(false);
    expect(shouldCyclePlug({ plugOn: true, tcp80Open: true, haState: "unavailable" })).toBe(false);
    expect(shouldCyclePlug({ plugOn: true, tcp80Open: false, haState: "playing" })).toBe(false);
  });
});
