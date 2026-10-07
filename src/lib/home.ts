// Shared (client + server) Home Assistant model: entity map, snapshot shape,
// demo data and the pure optimistic reducer. Contains no secrets.

import { makeT, tryT } from "./i18n";
import type { Lang } from "./i18n";

// Display-name overrides per language, keyed by the English name used below.
// Entities without an entry keep their English name.
export const NAME_OVERRIDES: Record<Lang, Record<string, string>> = {
  en: {},
  he: {
    "Main light": "אור ראשי",
    "Spot light": "ספוטים",
    "Dining table": "שולחן אוכל",
    "Cabinet strips": "פסי ארון",
    "Living room": "סלון",
    "Dining room": "פינת אוכל",
    Shower: "מקלחת",
    "Kids room": "חדר ילדים",
    Corridor: "מסדרון",
    Kitchen: "מטבח",
    Hall: "כניסה",
    Bathroom: "אמבטיה",
    Bedroom: "חדר שינה",
    "TV Plug": "שקע טלוויזיה",
    Workstation: "עמדת עבודה",
    "Kitchen boiler": "דוד מטבח",
    "Sony TV": "טלוויזיה",
    "Yamaha R-N500": "מגבר ימאהה",
  },
};
export const localName = (lang: Lang, name: string) => NAME_OVERRIDES[lang][name] ?? name;

export const LIGHTS = [
  { id: "light.main_light", name: "Main light", room: "Living room" },
  { id: "light.spots", name: "Spot light", room: "Living room" },
  { id: "light.dining_table", name: "Dining table", room: "Dining room" },
  { id: "light.cabinet_strips", name: "Cabinet strips", room: "Dining room" },
] as const;
export const LIGHT_IDS = LIGHTS.map((l) => l.id) as [string, ...string[]];

export const SHADES = { Warm: 2700, Neutral: 4000, Cool: 6000 } as const;
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

// UI order. Entity numbers follow input_boolean.robo_grid_N.
export const ROOMS = [
  { name: "Shower", id: "input_boolean.robo_grid_1" },
  { name: "Kids room", id: "input_boolean.robo_grid_2" },
  { name: "Corridor", id: "input_boolean.robo_grid_3" },
  { name: "Kitchen", id: "input_boolean.robo_grid_7" },
  { name: "Hall", id: "input_boolean.robo_grid_6" },
  { name: "Bathroom", id: "input_boolean.robo_grid_5" },
  { name: "Bedroom", id: "input_boolean.robo_grid_4" },
  { name: "Living room", id: "input_boolean.robo_grid_8" },
] as const;
export const ROOM_IDS = ROOMS.map((r) => r.id) as [string, ...string[]];

export const VACUUM = {
  id: "vacuum.roborock_qrevo_edge_series",
  battery: "sensor.roborock_qrevo_edge_series_battery",
} as const;

const TV_PLUG = "smart_switch_23081678814571510d0548e1e9d69992";
const WORKSTATION = "smart_switch_23081667767888510d0548e1e9d69812";
const BOILER = "smart_switch_23091502032711510d0248e1e9dac29d";
// energy is converted to Wh with energyToWh.
export const PLUGS = [
  {
    name: "TV Plug",
    id: `switch.${TV_PLUG}_outlet`,
    power: `sensor.${TV_PLUG}_power`,
    energy: `sensor.${TV_PLUG}_energy`,
    energyToWh: 1,
  },
  {
    name: "Workstation",
    id: `switch.${WORKSTATION}_outlet`,
    power: `sensor.${WORKSTATION}_power`,
    energy: `sensor.${WORKSTATION}_energy`,
    energyToWh: 1,
  },
  {
    name: "Kitchen boiler",
    id: `switch.${BOILER}_outlet`,
    power: `sensor.${BOILER}_power`,
    energy: "sensor.kitchen_boiler_energy_calc",
    energyToWh: 1000,
  },
] as const;
export const SWITCH_IDS = PLUGS.map((p) => p.id) as [string, ...string[]];

export const MEDIA = [
  { name: "Yamaha R-N500", id: "media_player.r_n500_main" },
  { name: "Sony TV", id: "media_player.bravia_xr_65x90k" },
] as const;
export const MEDIA_IDS = MEDIA.map((m) => m.id) as [string, ...string[]];
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

export const SCRIPTS = {
  movie: "script.movie_mode",
  movieOff: "script.movie_mode_off",
  roomsStart: "script.robo_grid_start",
  movieActive: "input_boolean.movie_mode_active",
} as const;
export const SENSORS = {
  indoorTemp: "sensor.ikea_of_sweden_vindstyrka_temperature",
  indoorHumidity: "sensor.ikea_of_sweden_vindstyrka_humidity",
  weather: "weather.forecast_home",
} as const;

export type LightState = { on: boolean; level: number; shade: Shade; color: string };
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
};
export type SnapshotResult = {
  configured: boolean;
  error?: string;
  snapshot: Snapshot | null;
  lang: Lang;
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

export function demoSnapshot(): Snapshot {
  return {
    lights: [
      { on: true, level: 96, shade: "Warm", color: "White" },
      { on: false, level: 60, shade: "Neutral", color: "White" },
      { on: false, level: 80, shade: "Warm", color: "White" },
      { on: false, level: 50, shade: "Cool", color: "White" },
    ],
    movieActive: false,
    vacuum: { state: "docked", battery: 100 },
    rooms: ROOMS.map(() => false),
    plugs: [
      { on: false, power: 0, energyWh: 244 },
      { on: true, power: 62.1, energyWh: 569 },
      { on: false, power: 0, energyWh: 0 },
    ],
    media: MEDIA.map(() => ({ state: "unavailable", volume: null, source: null })),
    weather: { condition: "sunny", temp: 19.1 },
    indoor: { temp: 22, humidity: 63 },
  };
}

// Shown when HA is configured but not reachable yet: no invented readings.
export function emptySnapshot(): Snapshot {
  return {
    lights: LIGHTS.map(() => ({ on: false, level: 0, shade: "Neutral" as Shade, color: "White" })),
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
            on: a.name === "Bright" || i === 0,
            level: a.name === "Bright" ? 100 : i === 0 ? 40 : (next.lights[i]?.level ?? 0),
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
