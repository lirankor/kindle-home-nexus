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

  beforeEach(async () => {
    vi.resetModules();
    calls.length = 0;
    haConfig = null;
    marksSeeded = false;
    panelInstalled = true;
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
          marksSeeded = true;
          return Response.json({ service_response: { config: "seeded", kept_added: 1 } });
        }
        return new Response("{}", { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

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

describe("mergePanelConfig", () => {
  it("keeps only known tabs and fills missing parts", () => {
    const c = mergePanelConfig({ tabs: ["media", "bogus" as never], lights: [] });
    expect(c.tabs).toEqual(["media"]);
    expect(c.schedule.night_start).toBe("00:00");
    expect(c.media.music_backend).toBe("app");
  });
});
