// Bus task 020: buttons borrow the icon the entity already has in Home Assistant.
import { mdiTheater, mdiSpeaker, mdiWeatherNight, mdiNumeric1Box } from "@mdi/js";
import { isValidElement, type ReactElement } from "react";
import { Bath, Film, Lightbulb, Play, Speaker, Tv } from "lucide-react";
import { entityIcons, resolveMdi } from "./mdi.server";
import { ICON_AUTO, mdiIcon, nodeIcon, pickIcon, pickOptionalIcon } from "./icons";
import { DEFAULT_CONFIG } from "./panel-config";

const theater = { name: "theater", path: mdiTheater };

describe("resolveMdi (server)", () => {
  it("resolves mdi: names (kebab -> camel, digits kept)", () => {
    expect(resolveMdi("mdi:theater")).toEqual(theater);
    expect(resolveMdi("mdi:weather-night")).toEqual({
      name: "weather-night",
      path: mdiWeatherNight,
    });
    expect(resolveMdi("mdi:numeric-1-box")?.path).toBe(mdiNumeric1Box);
    expect(resolveMdi("  MDI:Theater ")).toEqual(theater);
  });
  it("takes a bare name (Music Assistant's `speaker`) and HA's old hass: alias as MDI", () => {
    expect(resolveMdi("speaker")).toEqual({ name: "speaker", path: mdiSpeaker });
    expect(resolveMdi("hass:theater")).toEqual(theater);
  });
  it("returns null for unknown names, other icon sets, junk and no icon", () => {
    expect(resolveMdi("mdi:no-such-icon-xyz")).toBeNull();
    expect(resolveMdi("phu:robot-vacuum")).toBeNull();
    expect(resolveMdi("mdi:")).toBeNull();
    expect(resolveMdi("mdi:the ater")).toBeNull();
    expect(resolveMdi("mdi:__proto__")).toBeNull();
    expect(resolveMdi("constructor")).toBeNull();
    expect(resolveMdi(undefined)).toBeNull();
    expect(resolveMdi(42)).toBeNull();
  });
  it("entityIcons lists only the asked entities that have a resolvable icon", () => {
    const states = new Map([
      ["script.movie_mode", { attributes: { icon: "mdi:theater" } }],
      ["switch.plug", { attributes: {} }],
      ["light.x", { attributes: { icon: "mdi:bogus-name-1" } }],
      ["scene.other", { attributes: { icon: "mdi:weather-night" } }],
    ]);
    expect(
      entityIcons(states, ["script.movie_mode", "switch.plug", "light.x", "sensor.missing", null]),
    ).toEqual({ "script.movie_mode": theater });
  });
});

const draw = (c: (p: { size?: number }) => unknown) =>
  c({ size: 30 }) as ReactElement<Record<string, unknown>>;

describe("icon precedence (row pack icon > entity icon > row default)", () => {
  it("an explicit pack icon wins over the entity's icon", () => {
    expect(pickIcon("bath", { name: "toilet", path: "M0 0" }, "room")).toBe(Bath);
  });
  it("auto, empty, null and unknown row values fall through to the entity icon", () => {
    for (const row of [ICON_AUTO, "", null, undefined, "no_such_pack_name"]) {
      const c = pickIcon(row, theater, "film");
      expect(c).toBe(mdiIcon(theater));
      expect(c).not.toBe(Film);
    }
  });
  it("no entity icon: the row type's default name, or a fallback component", () => {
    expect(pickIcon(ICON_AUTO, undefined, "bulb")).toBe(Lightbulb);
    expect(pickIcon(null, null, Play)).toBe(Play);
    expect(pickOptionalIcon(null, undefined)).toBeNull();
    expect(pickOptionalIcon("auto", theater)).toBe(mdiIcon(theater));
  });
  it("nodes: row icon, else the entity's icon, else by type", () => {
    expect(nodeIcon({ type: "receiver", icon: "tv", entityIcon: theater })).toBe(Tv);
    expect(nodeIcon({ type: "receiver", entityIcon: theater })).toBe(mdiIcon(theater));
    expect(nodeIcon({ type: "receiver" })).toBe(Speaker);
    expect(nodeIcon({ type: "tv", icon: "auto" })).toBe(Tv);
  });
  it("an MDI icon draws one filled path, currentColor, in the box it is given", () => {
    const el = draw(mdiIcon(theater));
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe("svg");
    expect(el.props["width"]).toBe(30);
    expect(el.props["fill"]).toBe("currentColor");
    expect(el.props["className"]).toBe("mdi mdi-theater");
    const path = el.props["children"] as ReactElement<{ d: string }>;
    expect(path.props.d).toBe(mdiTheater);
    // the same path gives the same component (no remounts between polls)
    expect(mdiIcon({ ...theater })).toBe(mdiIcon(theater));
  });
});

describe("snapshots carry the entities' HA icons", () => {
  it("home snapshot: icons of lights, rooms, scenes, plugs, custom tab entities and sensor cards", async () => {
    const { buildSnapshot } = await import("./home.server");
    const { applyHomeConfig } = await import("./home");
    const c = structuredClone(DEFAULT_CONFIG);
    c.custom_tabs = {
      fans: {
        title: "Fans",
        icon: "fan",
        toggles: [{ entity_id: "fan.desk", name: "Desk" }],
        keys: ["script.cool", "none", "none", "all_off"],
      },
    };
    c.screensaver.cards = [{ type: "sensor", entity_id: "sensor.co2" }];
    applyHomeConfig(c);
    const st = (id: string, icon?: string) =>
      [id, { entity_id: id, state: "on", attributes: icon ? { icon } : {} }] as const;
    const states = new Map([
      st("script.movie_mode", "mdi:theater"),
      st("scene.evening", "mdi:weather-night"),
      st("input_boolean.robo_grid_5", "mdi:toilet"),
      st("light.main_light", "mdi:light-recessed"),
      st("fan.desk", "mdi:fan"),
      st("script.cool", "mdi:snowflake"),
      st("sensor.co2", "mdi:molecule-co2"),
      st("light.unrelated", "mdi:lamp"),
      st("switch.plain"),
    ]);
    const icons = buildSnapshot(states).icons ?? {};
    expect(Object.keys(icons).sort()).toEqual([
      "fan.desk",
      "input_boolean.robo_grid_5",
      "light.main_light",
      "scene.evening",
      "script.cool",
      "script.movie_mode",
      "sensor.co2",
    ]);
    expect(icons["script.movie_mode"]).toEqual(theater);
    applyHomeConfig(DEFAULT_CONFIG);
  });

  it("the loader no longer fills pack defaults into rows (they apply at draw time)", async () => {
    const { applyHomeConfig, LIGHTS, ROOMS, PLUGS } = await import("./home");
    const c = structuredClone(DEFAULT_CONFIG);
    c.lights = [{ entity_id: "light.a", name: "A", room: "" }];
    c.vacuum.rooms = [{ entity_id: "input_boolean.r", name: "R" }];
    c.plugs = [{ entity_id: "switch.p", name: "P", energy_to_wh: 1 }];
    applyHomeConfig(c);
    expect([LIGHTS[0]?.icon, ROOMS[0]?.icon, PLUGS[0]?.icon]).toEqual(["", "", ""]);
    applyHomeConfig(DEFAULT_CONFIG);
  });

  it("media: a node carries its entity's icon; key scripts and MA players get theirs", async () => {
    const { nodeView, mediaKeyIcons } = await import("./media-nodes.server");
    const { MEDIA_KEYS, OUTPUT_KEYS } = await import("./media");
    const states = new Map([
      [
        "media_player.tv",
        {
          entity_id: "media_player.tv",
          state: "off",
          attributes: { icon: "mdi:television-classic" },
        },
      ],
      [
        "script.movie_mode",
        { entity_id: "script.movie_mode", state: "off", attributes: { icon: "mdi:theater" } },
      ],
      [
        "media_player.ma_amp_dlna",
        { entity_id: "media_player.ma_amp_dlna", state: "idle", attributes: { icon: "speaker" } },
      ],
      [
        "media_player.ma_kitchen",
        {
          entity_id: "media_player.ma_kitchen",
          state: "idle",
          attributes: { icon: "mdi:speaker-wireless" },
        },
      ],
    ]);
    const tv = nodeView({ id: "tv", type: "tv", name: "TV", entity: "media_player.tv" }, states);
    expect(tv.entityIcon?.name).toBe("television-classic");
    const keys = [...MEDIA_KEYS];
    const outs = [...OUTPUT_KEYS];
    MEDIA_KEYS.splice(0, 4, "script.movie_mode", "amp", "tv", "music");
    OUTPUT_KEYS.splice(0, 4, "media_player.ma_amp_dlna", "none", "none", "none");
    const icons = mediaKeyIcons(states, ["media_player.ma_kitchen"]);
    expect(icons["script.movie_mode"]).toEqual(theater);
    expect(icons["media_player.ma_amp_dlna"]).toEqual({ name: "speaker", path: mdiSpeaker });
    expect(icons["media_player.ma_kitchen"]?.name).toBe("speaker-wireless");
    expect(Object.keys(icons)).toHaveLength(3);
    MEDIA_KEYS.splice(0, 4, ...keys);
    OUTPUT_KEYS.splice(0, 4, ...outs);
  });
});
