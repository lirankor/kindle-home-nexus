import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, mergePanelConfig } from "./panel-config";

type Call = { path: string; body: Record<string, unknown> };

describe("panel config from Home Assistant", () => {
  const calls: Call[] = [];
  let haConfig: Record<string, unknown> | null = null;
  let marksSeeded = false;
  let panelInstalled = true;
  let haDown = false;
  let entryStillThere = false; // services gone, entry still there: HA starting or the entry being retried

  beforeEach(async () => {
    vi.resetModules();
    calls.length = 0;
    haConfig = null;
    marksSeeded = false;
    panelInstalled = true;
    haDown = false;
    entryStillThere = false;
    const dir = await mkdtemp(path.join(os.tmpdir(), "panel-"));
    await writeFile(
      path.join(dir, "kindle-photo-marks.json"),
      JSON.stringify({ marked: [{ id: "asset-1", at: "2026-10-01T00:00:00Z" }] }),
    );
    process.env["MEDIA_STATE_DIR"] = dir;
    process.env["HA_TOKEN"] = "t";
    process.env["HA_BASE_URL"] = "http://ha.test";
    process.env["UI_LANGUAGE"] = "he";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const p = url.replace("http://ha.test", "");
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ path: p, body });
        if (haDown) throw new TypeError("fetch failed");
        if (p.startsWith("/api/config/config_entries/entry"))
          return Response.json(panelInstalled || entryStillThere ? [{ entry_id: "e1" }] : []);
        if (!panelInstalled) return new Response("{}", { status: 400 });
        if (p.startsWith("/api/services/kindle_panel/get_config"))
          return Response.json({
            service_response: {
              seeded: haConfig !== null,
              marks_seeded: marksSeeded,
              config: haConfig ?? {},
            },
          });
        if (p.startsWith("/api/services/kindle_panel/seed")) {
          if (body["config"]) haConfig = body["config"] as Record<string, unknown>;
          if ("kept" in body) marksSeeded = true;
          return Response.json({ service_response: { config: "seeded", kept_added: 1 } });
        }
        return new Response("{}", { status: 404 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const onlyLight = () => {
    haConfig = {
      ...DEFAULT_CONFIG,
      lights: [{ entity_id: "light.only", name: "Only", room: "Hall", icon: "bulb" }],
    };
    marksSeeded = true;
  };

  it("keeps the HA config while HA is unreachable (an HA restart does not flip the screen)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onlyLight();
    const { ensurePanelConfig } = await import("./panel-config.server");
    const { LIGHTS } = await import("./home");
    await ensurePanelConfig();
    haDown = true;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(45_000);
      const l = await ensurePanelConfig();
      expect(l.source).toBe("ha");
      expect(LIGHTS.map((x) => x.id)).toEqual(["light.only"]);
    }
  });

  it("goes back to the built-in setup once kindle_panel is really gone (rollback)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onlyLight();
    const { ensurePanelConfig } = await import("./panel-config.server");
    await ensurePanelConfig();
    panelInstalled = false;
    vi.advanceTimersByTime(31_000);
    expect((await ensurePanelConfig()).source).toBe("ha"); // one "no such service" may be HA starting up
    vi.advanceTimersByTime(61_000);
    expect((await ensurePanelConfig()).source).toBe("default");
  });

  it("keeps the HA config while kindle_panel's services are missing but its entry is there (HA starting)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    onlyLight();
    const { ensurePanelConfig } = await import("./panel-config.server");
    await ensurePanelConfig();
    panelInstalled = false;
    entryStillThere = true;
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(61_000);
      expect((await ensurePanelConfig()).source).toBe("ha");
    }
  });

  it("does not take a missing marks file as 'no marks' when MEDIA_STATE_DIR is unset", async () => {
    delete process.env["MEDIA_STATE_DIR"];
    const { ensurePanelConfig } = await import("./panel-config.server");
    await ensurePanelConfig();
    const seed = calls.find((c) => c.path.startsWith("/api/services/kindle_panel/seed"))!;
    expect("kept" in seed.body).toBe(false);
  });

  it("does not hand over the marks while the marks file cannot be read", async () => {
    process.env["MEDIA_STATE_DIR"] = path.join(os.tmpdir(), "not-mounted-" + Date.now());
    const { ensurePanelConfig } = await import("./panel-config.server");
    await ensurePanelConfig();
    const seed = calls.find((c) => c.path.startsWith("/api/services/kindle_panel/seed"))!;
    expect(seed.body["config"]).toBeDefined();
    expect("kept" in seed.body).toBe(false);
    expect(marksSeeded).toBe(false); // HA keeps asking on the next start
  });

  it("seeds HA with the household setup and the photo marks on the first start", async () => {
    const { ensurePanelConfig } = await import("./panel-config.server");
    const { LIGHTS } = await import("./home");
    const l = await ensurePanelConfig();
    const seed = calls.find((c) => c.path.startsWith("/api/services/kindle_panel/seed"))!;
    expect(seed.body["kept"]).toEqual({ "asset-1": "2026-10-01T00:00:00Z" });
    const seeded = seed.body["config"] as typeof DEFAULT_CONFIG;
    expect(seeded.lights.map((x) => x.entity_id)).toEqual(
      DEFAULT_CONFIG.lights.map((x) => x.entity_id),
    );
    expect(seeded.language).toBe("he");
    expect(l.source).toBe("ha");
    expect(LIGHTS).toHaveLength(4);
  });

  it("applies what is configured in HA (lights, rooms, plugs, amp entities)", async () => {
    haConfig = {
      ...DEFAULT_CONFIG,
      lights: [{ entity_id: "light.only", name: "Only", room: "Hall", icon: "bulb" }],
      vacuum: { ...DEFAULT_CONFIG.vacuum, rooms: DEFAULT_CONFIG.vacuum.rooms.slice(0, 2) },
      plugs: [],
      media: { ...DEFAULT_CONFIG.media, amp_player: "media_player.r_n500" },
    };
    marksSeeded = true;
    const { ensurePanelConfig, panelViewNow } = await import("./panel-config.server");
    const { LIGHTS, PLUGS, ROOMS } = await import("./home");
    const { AMP } = await import("./media");
    await ensurePanelConfig();
    expect(calls.some((c) => c.path.includes("/seed"))).toBe(false); // nothing to seed
    expect(LIGHTS.map((l) => l.id)).toEqual(["light.only"]);
    expect(ROOMS).toHaveLength(2);
    expect(PLUGS).toHaveLength(0);
    expect(AMP.player).toBe("media_player.r_n500");
    expect(panelViewNow().source).toBe("ha");
  });

  it("runs on the built-in setup when kindle_panel is not installed", async () => {
    panelInstalled = false;
    const { ensurePanelConfig } = await import("./panel-config.server");
    const { LIGHTS } = await import("./home");
    const l = await ensurePanelConfig();
    expect(l.source).toBe("default");
    expect(LIGHTS.map((x) => x.id)).toEqual(DEFAULT_CONFIG.lights.map((x) => x.entity_id));
  });
});

describe("screensaver cards", () => {
  it("default to outdoor, indoor, calendar; sensor cards read their entity", async () => {
    const { buildSnapshot } = await import("./home.server");
    const { applyHomeConfig, SAVER_CARDS } = await import("./home");
    expect(SAVER_CARDS.map((c) => c.type)).toEqual(["outdoor", "indoor", "calendar"]);
    expect(buildSnapshot(new Map()).cards).toBeUndefined();
    const c = structuredClone(DEFAULT_CONFIG);
    c.screensaver.cards = [
      { type: "sensor", entity_id: "sensor.tv_power", label: "TV", icon: "zap" },
    ];
    applyHomeConfig(c);
    const states = new Map([
      [
        "sensor.tv_power",
        { entity_id: "sensor.tv_power", state: "112.46", attributes: { unit_of_measurement: "W" } },
      ],
    ]);
    expect(buildSnapshot(states).cards).toEqual({
      "sensor.tv_power": { value: "112.5", unit: "W" },
    });
    applyHomeConfig(DEFAULT_CONFIG);
  });

  it("drops unknown cards, sensor cards without an entity, and more than three", () => {
    const m = mergePanelConfig({
      ...DEFAULT_CONFIG,
      screensaver: {
        ...DEFAULT_CONFIG.screensaver,
        cards: [
          { type: "calendar" },
          { type: "sensor" },
          { type: "bogus" as "calendar" },
          { type: "outdoor" },
          { type: "indoor" },
          { type: "calendar" },
        ],
      },
    });
    expect(m.screensaver.cards.map((c) => c.type)).toEqual(["calendar", "outdoor", "indoor"]);
  });
});

describe("mergePanelConfig", () => {
  it("keeps only known tabs and fills missing parts", () => {
    const c = mergePanelConfig({ tabs: ["media", "bogus" as never], lights: [] });
    expect(c.tabs).toEqual(["media"]);
    expect(c.schedule.night_start).toBe("00:00");
    expect(c.media.music_backend).toBe("app");
  });
});

describe("scene buttons and Power tab keys (task 011)", () => {
  it("a config saved before they existed gets today's buttons and keys", () => {
    const { scenes: _s, power_keys: _k, ...old } = DEFAULT_CONFIG;
    const c = mergePanelConfig(old);
    expect(c.scenes).toEqual(DEFAULT_CONFIG.scenes);
    expect(c.power_keys).toEqual(DEFAULT_CONFIG.power_keys);
  });
  it("keeps saved values, drops invalid rows, pads the keys", () => {
    const c = mergePanelConfig({
      plugs: DEFAULT_CONFIG.plugs,
      scenes: [
        { entity_id: "scene.reading", name: "Reading", icon: "book" },
        { entity_id: "light.main_light", name: "Not a scene", icon: "star" },
        { builtin: "evening", name: "Evening", icon: "moon" },
        { name: "Nothing", icon: "star" },
        { entity_id: "script.a", name: "A", icon: "star" },
        { entity_id: "script.b", name: "B", icon: "star" },
      ],
      power_keys: ["all_off"],
    });
    expect(c.scenes.map((s) => s.entity_id ?? s.builtin)).toEqual([
      "scene.reading",
      "evening",
      "script.a",
    ]);
    expect(c.power_keys).toEqual(["all_off", "none", "none", "none"]);
    expect(mergePanelConfig({ scenes: [] }).scenes).toEqual([]);
  });
});

describe("custom tabs (task 012)", () => {
  it("none by default; a tab entry needs its block; keys start like the Power tab", () => {
    expect(mergePanelConfig(DEFAULT_CONFIG).custom_tabs).toEqual({});
    const c = mergePanelConfig({
      tabs: ["custom:garden", "lights", "custom:gone", "custom:Bad", "lights"],
      custom_tabs: {
        garden: {
          title: "Garden",
          icon: "leaf",
          toggles: [{ entity_id: "input_boolean.pump", name: "Pump", icon: "zap" }],
        } as never,
        Bad: { title: "x", icon: "star", toggles: [], keys: [] },
      },
    });
    expect(c.tabs).toEqual(["custom:garden", "lights"]);
    expect(Object.keys(c.custom_tabs)).toEqual(["garden"]);
    expect(c.custom_tabs["garden"]!.keys).toEqual([
      "input_boolean.pump",
      "none",
      "none",
      "all_off",
    ]);
  });
});
