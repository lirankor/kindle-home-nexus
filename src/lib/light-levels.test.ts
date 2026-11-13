import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIGHTS } from "./home";
import { buildSnapshot, resetLightLevels } from "./home.server";
import type { HaState } from "./home.server";

const id = LIGHTS[0]!.id;
const snap = (state: string, attributes: Record<string, unknown> = {}) =>
  buildSnapshot(new Map<string, HaState>([[id, { entity_id: id, state, attributes }]])).lights[0]!;
const dim = { supported_color_modes: ["color_temp"] };

describe("the level a light comes back at", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "khn-levels-"));
    delete process.env["MEDIA_STATE_DIR"];
    resetLightLevels();
  });
  afterEach(() => {
    delete process.env["MEDIA_STATE_DIR"];
    resetLightLevels();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an off light keeps its last level, and on without a brightness yet shows it too", () => {
    expect(snap("off", dim)).toMatchObject({ on: false, level: 0 });
    expect(snap("on", { ...dim, brightness: 102 })).toMatchObject({ on: true, level: 40 });
    expect(snap("off", dim)).toMatchObject({ on: false, level: 40 });
    expect(snap("on", dim)).toMatchObject({ on: true, level: 40 });
    expect(snap("on", { ...dim, brightness: 255 })).toMatchObject({ on: true, level: 100 });
    expect(snap("off", dim)).toMatchObject({ on: false, level: 100 });
  });

  it("an unknown level is still 100 when on, and an on/off-only light is always 100", () => {
    expect(snap("on", dim)).toMatchObject({ on: true, level: 100 });
    resetLightLevels();
    expect(snap("on", { supported_color_modes: ["onoff"] })).toMatchObject({
      on: true,
      level: 100,
    });
    expect(snap("off", { supported_color_modes: ["onoff"] })).toMatchObject({
      on: false,
      level: 0,
    });
  });

  it("survives a restart through the state file", async () => {
    process.env["MEDIA_STATE_DIR"] = dir;
    resetLightLevels();
    expect(snap("on", { ...dim, brightness: 64 }).level).toBe(25);
    const file = path.join(dir, "kindle-light-levels.json");
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
        } catch {
          return null;
        }
      })
      .toEqual({ [id]: 25 });
    resetLightLevels(); // a new process: nothing in memory
    expect(snap("off", dim)).toMatchObject({ on: false, level: 25 });
  });
});
