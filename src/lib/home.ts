// Shared (client + server) Home Assistant model: entity map, snapshot shape,
// demo data and the pure optimistic reducer. Contains no secrets.

import { makeT, tryT } from "./i18n";
import type { Lang } from "./i18n";
import { DEFAULT_CONFIG } from "./panel-config";
import type { PanelView } from "./panel-config";

// Display-name overrides per language, keyed by the English name used below (from the panel config: names).
// Entities without an entry keep their English name.
export const NAME_OVERRIDES: Record<Lang, Record<string, string>> = { en: {}, he: {} };
export const localName = (lang: Lang, name: string) => NAME_OVERRIDES[lang][name] ?? name;

export type LightMeta = { id: string; name: string; room: string; icon: string };
/** Lights in screen order (panel config: lights). Mutated in place by applyHomeConfig. */
export const LIGHTS: LightMeta[] = [];

// Warm matches the HA "Evening light" automation (2200 K); HA clamps to each lamp's minimum.
export const SHADES = { Warm: 2200, Neutral: 4000, Cool: 6000 } as const;
export type Shade = keyof typeof SHADES;
export const COLORS = [
  "White",
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Cyan",
  "Blue",
  "Purple",
  "Pink",
] as const;
export const SHADE_NAMES = Object.keys(SHADES) as Shade[];

const COLOR_RGB: Record<string, [number, number, number]> = {
  Red: [255, 0, 0],
  Orange: [255, 165, 0],
  Yellow: [255, 255, 0],
  Green: [0, 128, 0],
  Cyan: [0, 255, 255],
  Blue: [0, 0, 255],
  Purple: [128, 0, 128],
  Pink: [255, 192, 203],
};

export type RoomMeta = { name: string; id: string; icon: string };
/** Vacuum rooms in screen order (panel config: vacuum.rooms). */
export const ROOMS: RoomMeta[] = [];

export const VACUUM = { id: "", battery: "" };

export type PlugMeta = {
  name: string;
  id: string;
  power: string | null;
  energy: string | null;
  /** energy is converted to Wh with energyToWh. */
  energyToWh: number;
};
export const PLUGS: PlugMeta[] = [];

export const MEDIA: { name: string; id: string }[] = [];
export const MEDIA_OPS = [
  "turn_on",
  "turn_off",
  "media_play",
  "media_pause",
  "media_next_track",
  "media_previous_track",
  "volume_up",
  "volume_down",
] as const;
export type MediaOp = (typeof MEDIA_OPS)[number];

export const SCRIPTS = { movie: "", movieOff: "", roomsStart: "", movieActive: "" };
export const SENSORS = { indoorTemp: "", indoorHumidity: "", weather: "" };
/** The screensaver's cards (panel config: screensaver.cards), in order; at most 3. */
export type CardConfig = {
  type: string;
  entity_id?: string | null;
  label?: string | null;
  icon?: string | null;
};
export const SAVER_CARDS: CardConfig[] = [];
/** The Evening scene (panel config: evening). */
export const EVENING = { entity: "", pct: 40, kelvin: 2200 };

const eveningIndex = () =>
  Math.max(
    0,
    LIGHTS.findIndex((l) => l.id === EVENING.entity),
  );

/** Write a panel config into the constants above, in place (server: from HA; browser: from the snapshot). */
export function applyHomeConfig(c: {
  names: Partial<Record<Lang, Record<string, string>>>;
  lights: { entity_id: string; name: string; room?: string; icon?: string }[];
  vacuum: {
    entity_id?: string | null;
    battery_entity?: string | null;
    rooms_script?: string | null;
    rooms: { entity_id: string; name: string; icon?: string }[];
  };
  plugs: {
    entity_id: string;
    name: string;
    power_entity?: string | null;
    energy_entity?: string | null;
    energy_to_wh?: number;
  }[];
  media?: {
    amp_player?: string | null;
    tv?: string | null;
    movie_on?: string | null;
    movie_off?: string | null;
    movie_active?: string | null;
  };
  sensors?: {
    indoor_temperature?: string | null;
    indoor_humidity?: string | null;
    weather?: string | null;
  };
  evening?: { entity_id?: string | null; brightness_pct: number; warm_kelvin: number };
  screensaver?: { cards?: CardConfig[] };
}) {
  NAME_OVERRIDES.en = { ...(c.names.en ?? {}) };
  NAME_OVERRIDES.he = { ...(c.names.he ?? {}) };
  LIGHTS.splice(
    0,
    LIGHTS.length,
    ...c.lights.map((l) => ({
      id: l.entity_id,
      name: l.name,
      room: l.room ?? "",
      icon: l.icon ?? "bulb",
    })),
  );
  ROOMS.splice(
    0,
    ROOMS.length,
    ...c.vacuum.rooms.map((r) => ({ id: r.entity_id, name: r.name, icon: r.icon ?? "room" })),
  );
  VACUUM.id = c.vacuum.entity_id ?? "";
  VACUUM.battery = c.vacuum.battery_entity ?? "";
  SCRIPTS.roomsStart = c.vacuum.rooms_script ?? "";
  PLUGS.splice(
    0,
    PLUGS.length,
    ...c.plugs.map((p) => ({
      name: p.name,
      id: p.entity_id,
      power: p.power_entity ?? null,
      energy: p.energy_entity ?? null,
      energyToWh: p.energy_to_wh ?? 1,
    })),
  );
  if (c.media) {
    MEDIA.splice(0, MEDIA.length);
    if (c.media.amp_player) MEDIA.push({ name: "Yamaha R-N500", id: c.media.amp_player });
    if (c.media.tv) MEDIA.push({ name: "Sony TV", id: c.media.tv });
    SCRIPTS.movie = c.media.movie_on ?? "";
    SCRIPTS.movieOff = c.media.movie_off ?? "";
    SCRIPTS.movieActive = c.media.movie_active ?? "";
  }
  if (c.sensors) {
    SENSORS.indoorTemp = c.sensors.indoor_temperature ?? "";
    SENSORS.indoorHumidity = c.sensors.indoor_humidity ?? "";
    SENSORS.weather = c.sensors.weather ?? "";
  }
  if (c.screensaver?.cards)
    SAVER_CARDS.splice(0, SAVER_CARDS.length, ...c.screensaver.cards.slice(0, 3));
  if (c.evening) {
    EVENING.entity = c.evening.entity_id ?? LIGHTS[0]?.id ?? "";
    EVENING.pct = c.evening.brightness_pct;
    EVENING.kelvin = c.evening.warm_kelvin;
  }
}
applyHomeConfig(DEFAULT_CONFIG);

export type LightState = {
  on: boolean;
  level: number;
  shade: Shade;
  color: string;
  /** From supported_color_modes: hs, rgb, rgbw, rgbww or xy. Otherwise only white tones. */
  canColor: boolean;
};
export const COLOR_MODES = ["hs", "rgb", "rgbw", "rgbww", "xy"];
export type MediaState = { state: string; volume: number | null; source: string | null };
export type Snapshot = {
  lights: LightState[];
  movieActive: boolean;
  vacuum: { state: string; battery: number | null };
  rooms: boolean[];
  plugs: { on: boolean; power: number | null; energyWh: number | null }[];
  media: MediaState[];
  weather: { condition: string | null; temp: number | null };
  indoor: { temp: number | null; humidity: number | null };
  /** Readings for the screensaver's sensor cards, by entity id. */
  cards?: Record<string, { value: string | null; unit: string | null }>;
};
export type SnapshotResult = {
  configured: boolean;
  error?: string;
  snapshot: Snapshot | null;
  lang: Lang;
  /** Screensaver photo rotation in minutes (panel config, else env DAY_WAKE_MIN). */
  photoMinutes?: number;
  /** The panel configuration the browser renders with (lights, rooms, plugs, tabs, names, …). */
  panel?: PanelView;
};

export type Action =
  | { type: "light.toggle"; entity: string }
  | { type: "light.brightness"; entity: string; pct: number }
  | { type: "light.kelvin"; entity: string; kelvin: number }
  | { type: "light.color"; entity: string; color: (typeof COLORS)[number] }
  | { type: "lights.off" }
  | { type: "scene"; name: "Bright" | "Evening" | "Movie" }
  | { type: "movie.end" }
  | { type: "vacuum"; op: "start" | "pause" | "dock" | "locate" }
  | { type: "room.toggle"; entity: string }
  | { type: "rooms.clear" }
  | { type: "switch.toggle"; entity: string }
  | { type: "media"; entity: string; op: MediaOp };
export type ActionResult = { ok: boolean; error?: string; snapshot?: Snapshot | null };

export const nearestShade = (kelvin: number): Shade =>
  (Object.entries(SHADES) as [Shade, number][]).reduce((best, item) =>
    Math.abs(item[1] - kelvin) < Math.abs(best[1] - kelvin) ? item : best,
  )[0];

export const nearestColor = (rgb: number[]): string =>
  Object.entries(COLOR_RGB).reduce(
    (best, [name, c]) => {
      const d =
        (c[0] - (rgb[0] ?? 0)) ** 2 + (c[1] - (rgb[1] ?? 0)) ** 2 + (c[2] - (rgb[2] ?? 0)) ** 2;
      return d < best.d ? { name, d } : best;
    },
    { name: "White", d: Infinity },
  ).name;

const DEMO_LIGHTS: LightState[] = [
  { on: true, level: 96, shade: "Warm", color: "White", canColor: true },
  { on: false, level: 60, shade: "Neutral", color: "White", canColor: true },
  { on: false, level: 80, shade: "Warm", color: "White", canColor: false },
  { on: false, level: 50, shade: "Cool", color: "White", canColor: false },
];
const DEMO_PLUGS = [
  { on: false, power: 0, energyWh: 244 },
  { on: true, power: 62.1, energyWh: 569 },
  { on: false, power: 0, energyWh: 0 },
];

export function demoSnapshot(): Snapshot {
  return {
    lights: LIGHTS.map((_, i) => ({ ...DEMO_LIGHTS[i % DEMO_LIGHTS.length]! })),
    movieActive: false,
    vacuum: { state: "docked", battery: 100 },
    rooms: ROOMS.map(() => false),
    plugs: PLUGS.map((_, i) => ({ ...DEMO_PLUGS[i % DEMO_PLUGS.length]! })),
    media: MEDIA.map(() => ({ state: "unavailable", volume: null, source: null })),
    weather: { condition: "sunny", temp: 19.1 },
    indoor: { temp: 22, humidity: 63 },
  };
}

// Shown when HA is configured but not reachable yet: no invented readings.
export function emptySnapshot(): Snapshot {
  return {
    lights: LIGHTS.map(() => ({
      on: false,
      level: 0,
      shade: "Neutral" as Shade,
      color: "White",
      canColor: false,
    })),
    movieActive: false,
    vacuum: { state: "unavailable", battery: null },
    rooms: ROOMS.map(() => false),
    plugs: PLUGS.map(() => ({ on: false, power: null, energyWh: null })),
    media: MEDIA.map(() => ({ state: "unavailable", volume: null, source: null })),
    weather: { condition: null, temp: null },
    indoor: { temp: null, humidity: null },
  };
}

const lightIndex = (entity: string) => LIGHTS.findIndex((l) => l.id === entity);
const label = (lang: Lang, list: readonly { id: string; name: string }[], id: string) =>
  localName(lang, list.find((i) => i.id === id)?.name ?? id);

/** Human-readable result for the status line. */
export function actionLabel(a: Action, lang: Lang): string {
  const t = makeT(lang);
  switch (a.type) {
    case "light.toggle":
      return t("act.toggled", { name: label(lang, LIGHTS, a.entity) });
    case "light.brightness":
      return t("act.brightness", { name: label(lang, LIGHTS, a.entity), pct: a.pct });
    case "light.kelvin":
      return t("act.kelvin", {
        name: label(lang, LIGHTS, a.entity),
        shade: t(`shade.${nearestShade(a.kelvin)}`),
      });
    case "light.color":
      return t("act.color", {
        name: label(lang, LIGHTS, a.entity),
        color: t(`color.${a.color}`),
      });
    case "lights.off":
      return t("act.lightsOff");
    case "scene":
      return t("act.scene", { scene: t(`scene.${a.name}`) });
    case "movie.end":
      return t("act.movieEnd");
    case "vacuum":
      return t(`act.vacuum.${a.op}`);
    case "room.toggle":
      return t("act.room", { name: label(lang, ROOMS, a.entity) });
    case "rooms.clear":
      return t("act.roomsClear");
    case "switch.toggle":
      return t("act.switch", { name: label(lang, PLUGS, a.entity) });
    case "media":
      return t("act.media", { name: label(lang, MEDIA, a.entity), op: t(`op.${a.op}`) });
  }
}

/** Pure optimistic update, also the whole behaviour of demo mode. */
export function applyOptimistic(s: Snapshot, a: Action): Snapshot {
  const next: Snapshot = {
    ...s,
    lights: s.lights.map((l) => ({ ...l })),
    rooms: [...s.rooms],
    plugs: s.plugs.map((p) => ({ ...p })),
    media: s.media.map((m) => ({ ...m })),
    vacuum: { ...s.vacuum },
  };
  const patchLight = (i: number, p: Partial<LightState>) => {
    if (next.lights[i]) next.lights[i] = { ...next.lights[i], ...p };
  };
  switch (a.type) {
    case "light.toggle": {
      const l = next.lights[lightIndex(a.entity)];
      if (l)
        patchLight(lightIndex(a.entity), {
          on: !l.on,
          level: !l.on && l.level === 0 ? 100 : l.level,
        });
      break;
    }
    case "light.brightness":
      patchLight(lightIndex(a.entity), { on: true, level: a.pct });
      break;
    case "light.kelvin":
      patchLight(lightIndex(a.entity), { on: true, shade: nearestShade(a.kelvin), color: "White" });
      break;
    case "light.color":
      patchLight(
        lightIndex(a.entity),
        a.color === "White"
          ? { on: true, shade: "Neutral", color: "White" }
          : { on: true, color: a.color },
      );
      break;
    case "lights.off":
      next.lights.forEach((_, i) => patchLight(i, { on: false }));
      break;
    case "scene":
      if (a.name === "Movie") next.movieActive = true;
      else
        next.lights.forEach((_, i) =>
          patchLight(i, {
            on: a.name === "Bright" || i === eveningIndex(),
            level:
              a.name === "Bright"
                ? 100
                : i === eveningIndex()
                  ? EVENING.pct
                  : (next.lights[i]?.level ?? 0),
          }),
        );
      break;
    case "movie.end":
      next.movieActive = false;
      break;
    case "vacuum":
      if (a.op === "start") next.vacuum.state = "cleaning";
      else if (a.op === "pause") next.vacuum.state = "paused";
      else if (a.op === "dock") next.vacuum.state = "returning";
      break;
    case "room.toggle": {
      const i = ROOMS.findIndex((r) => r.id === a.entity);
      if (i >= 0) next.rooms[i] = !next.rooms[i];
      break;
    }
    case "rooms.clear":
      next.rooms = next.rooms.map(() => false);
      break;
    case "switch.toggle": {
      const i = PLUGS.findIndex((p) => p.id === a.entity);
      const p = next.plugs[i];
      if (p) next.plugs[i] = { ...p, on: !p.on, power: p.on ? 0 : p.power };
      break;
    }
    case "media": {
      const i = MEDIA.findIndex((m) => m.id === a.entity);
      const m = next.media[i];
      if (!m) break;
      if (a.op === "turn_on") m.state = "on";
      else if (a.op === "turn_off") m.state = "off";
      else if (a.op === "media_play") m.state = "playing";
      else if (a.op === "media_pause") m.state = "paused";
      else if (a.op === "volume_up" && m.volume !== null) m.volume = Math.min(1, m.volume + 0.02);
      else if (a.op === "volume_down" && m.volume !== null) m.volume = Math.max(0, m.volume - 0.02);
      break;
    }
  }
  return next;
}

export const vacuumLabel = (state: string, lang: Lang) =>
  tryT(lang, `state.${state}`) ?? state.charAt(0).toUpperCase() + state.slice(1);
export const conditionLabel = (c: string | null, lang: Lang) =>
  c === null
    ? makeT(lang)("weather.unavailable")
    : (tryT(lang, `weather.${c}`) ?? c.charAt(0).toUpperCase() + c.slice(1));
