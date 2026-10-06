import { describe, expect, it } from "vitest";
import { LIGHTS, ROOMS, applyOptimistic, demoSnapshot, nearestColor, nearestShade } from "./home";

describe("applyOptimistic", () => {
  it("toggles a light without mutating the input", () => {
    const before = demoSnapshot();
    const after = applyOptimistic(before, { type: "light.toggle", entity: LIGHTS[1].id });
    expect(after.lights[1]?.on).toBe(true);
    expect(before.lights[1]?.on).toBe(false);
  });
  it("evening leaves only the main light on at 40%", () => {
    const s = applyOptimistic(demoSnapshot(), { type: "scene", name: "Evening" });
    expect(s.lights.map((l) => l.on)).toEqual([true, false, false, false]);
    expect(s.lights[0]?.level).toBe(40);
  });
  it("toggles and clears rooms", () => {
    const picked = applyOptimistic(demoSnapshot(), { type: "room.toggle", entity: ROOMS[2].id });
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
