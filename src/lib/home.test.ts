import { describe, expect, it } from "vitest";
import {
  LIGHTS,
  ROOMS,
  applyHomeConfig,
  applyOptimistic,
  actionLabel,
  demoSnapshot,
  nearestColor,
  nearestShade,
  sceneLabel,
  softKeyTarget,
} from "./home";
import { DEFAULT_CONFIG } from "./panel-config";

describe("applyOptimistic", () => {
  it("toggles a light without mutating the input", () => {
    const before = demoSnapshot();
    const after = applyOptimistic(before, { type: "light.toggle", entity: LIGHTS[1]!.id });
    expect(after.lights[1]?.on).toBe(true);
    expect(before.lights[1]?.on).toBe(false);
  });
  it("evening leaves only the main light on at 40%", () => {
    const s = applyOptimistic(demoSnapshot(), { type: "scene", key: "builtin:evening" });
    expect(s.lights.map((l) => l.on)).toEqual([true, false, false, false]);
    expect(s.lights[0]?.level).toBe(40);
  });
  it("bright turns every light on at 100%; the movie script only marks movie mode", () => {
    const bright = applyOptimistic(demoSnapshot(), { type: "scene", key: "builtin:bright" });
    expect(bright.lights.every((l) => l.on && l.level === 100)).toBe(true);
    const movie = applyOptimistic(demoSnapshot(), { type: "scene", key: "script.movie_mode" });
    expect(movie.movieActive).toBe(true);
    expect(movie.lights).toEqual(demoSnapshot().lights);
  });
  it("an HA scene is not guessed", () => {
    applyHomeConfig({
      ...DEFAULT_CONFIG,
      scenes: [{ entity_id: "scene.reading", name: "Reading", icon: "book" }],
    });
    const s = applyOptimistic(demoSnapshot(), { type: "scene", key: "scene.reading" });
    expect(s.lights).toEqual(demoSnapshot().lights);
    expect(actionLabel({ type: "scene", key: "scene.reading" }, "en")).toContain("Reading");
    applyHomeConfig(DEFAULT_CONFIG);
  });
  it("toggles and clears rooms", () => {
    const picked = applyOptimistic(demoSnapshot(), { type: "room.toggle", entity: ROOMS[2]!.id });
    expect(picked.rooms[2]).toBe(true);
    expect(applyOptimistic(picked, { type: "rooms.clear" }).rooms.some(Boolean)).toBe(false);
  });
});

describe("colour helpers", () => {
  it("maps kelvin and rgb to the named choices", () => {
    expect(nearestShade(2600)).toBe("Warm");
    expect(nearestShade(5500)).toBe("Cool");
    expect(nearestColor([250, 10, 5])).toBe("Red");
  });
});

describe("scene labels and soft keys", () => {
  it("Bright / Evening / Movie are Hebrew by themselves, names override, others stay", () => {
    expect(sceneLabel("he", "Evening")).toBe("ערב");
    expect(sceneLabel("en", "Movie")).toBe("Movie");
    expect(sceneLabel("he", "Reading")).toBe("Reading");
    expect(sceneLabel("he", "Main light")).toBe("אור ראשי");
  });
  it("maps a key to a toggle, all off, or nothing", () => {
    const ids = ["switch.a", "switch.b"];
    expect(softKeyTarget("switch.b", ids)).toEqual({ kind: "toggle", index: 1 });
    expect(softKeyTarget("all_off", ids)).toEqual({ kind: "all_off" });
    expect(softKeyTarget("none", ids)).toBeNull();
    expect(softKeyTarget("switch.gone", ids)).toBeNull();
  });
});
