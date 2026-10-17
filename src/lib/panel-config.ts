// The panel's configuration (client + server, no secrets): what it shows and how it behaves. Edited in Home
// Assistant (the kindle_panel integration's options) and read from there; DEFAULT_CONFIG is this household's
// setup as it was hard-coded before, which the panel seeds into HA on its first start, so nothing on the screen
// changes when the configuration moves to HA.
//
// applyPanelConfig() writes a config into the shared module constants (LIGHTS, ROOMS, PLUGS, AMP, …) in place, so
// the rest of the code keeps reading them as before. The server applies what HA answers; the browser applies the
// copy that comes with every snapshot.
import type { Lang } from "./i18n";

export const TAB_IDS = ["lights", "vacuum", "power", "media"] as const;
export type TabId = (typeof TAB_IDS)[number];
export const LIGHT_ICON_NAMES = ["lamp_ceiling", "spot", "strip", "lamp", "bulb"] as const;
export const ROOM_ICON_NAMES = [
  "shower",
  "baby",
  "door",
  "utensils",
  "home",
  "bath",
  "bed",
  "sofa",
  "room",
] as const;

export type PanelLight = { entity_id: string; name: string; room: string; icon: string };
export type PanelRoom = { entity_id: string; name: string; icon: string };
export type PanelPlug = {
  entity_id: string;
  name: string;
  power_entity?: string | null;
  energy_entity?: string | null;
  energy_to_wh: number;
};
/** Lights tab scene buttons (F1..F3; F4 stays "all off"). */
export const MAX_SCENES = 3;
export const SCENE_BUILTINS = ["bright", "evening"] as const;
export const SCENE_ICON_NAMES = [
  "sun",
  "moon",
  "film",
  "sofa",
  "bed",
  "book",
  "utensils",
  "star",
  "sparkles",
  "power",
] as const;
/** A scene button: an HA scene or script (`entity_id`), or a built-in scene (`builtin`). The name is English; its
 *  Hebrew comes from `names` (Bright / Evening / Movie also from the app's own translations). */
export type SceneButton = {
  entity_id?: string | null;
  builtin?: (typeof SCENE_BUILTINS)[number] | null;
  name: string;
  icon: string;
};
/** A soft key F1..F4 (Power tab): an entity of the tab's list (a plug), "all_off" (every entity of the list off) or
 *  "none". The same string model is meant for custom tabs (task 012). */
export const KEY_ALL_OFF = "all_off";
export const KEY_NONE = "none";
export const SOFT_KEY_COUNT = 4;

export const CARD_TYPES = ["outdoor", "indoor", "calendar", "sensor"] as const;
export const CARD_ICON_NAMES = [
  "thermometer",
  "droplets",
  "gauge",
  "zap",
  "plug",
  "wind",
  "sun",
  "leaf",
  "home",
  "battery",
] as const;
/** A card on the screensaver (at most 3, in this order). `sensor` shows any HA entity's state with its unit. */
export type SaverCard = {
  type: (typeof CARD_TYPES)[number];
  entity_id?: string | null;
  label?: string | null;
  icon?: string | null;
};
export type PhotoSource =
  | { type: "immich_favorites"; title?: string }
  | { type: "media_source"; id: string; title?: string };

export type PanelConfig = {
  version: number;
  language: Lang;
  tabs: TabId[];
  names: Partial<Record<Lang, Record<string, string>>>;
  lights: PanelLight[];
  scenes: SceneButton[];
  evening: { entity_id?: string | null; brightness_pct: number; warm_kelvin: number };
  vacuum: {
    entity_id?: string | null;
    battery_entity?: string | null;
    rooms_script?: string | null;
    rooms: PanelRoom[];
  };
  plugs: PanelPlug[];
  /** F1..F4 on the Power tab, always 4 entries. */
  power_keys: string[];
  media: {
    music_backend: "app" | "ha";
    amp_player?: string | null;
    amp_volume?: string | null;
    dlna_player?: string | null;
    amp_plug?: string | null;
    amp_plug_power?: string | null;
    tv?: string | null;
    movie_on?: string | null;
    movie_off?: string | null;
    movie_active?: string | null;
    ynca_entry_id?: string | null;
  };
  sensors: {
    indoor_temperature?: string | null;
    indoor_humidity?: string | null;
    weather?: string | null;
  };
  screensaver: {
    idle_minutes: number;
    photo_minutes: number;
    mode: "curate" | "all_but_skipped" | "kept_only";
    sources: PhotoSource[];
    cards: SaverCard[];
    /** When no picture library gives a photo: black-and-white art from Unsplash, or the bundled sample photo. */
    fallback: "unsplash" | "sample";
    unsplash_query: string;
    /** Unsplash API access key (server only, never sent to the browser). Empty: Lorem Picsum's grayscale Unsplash photos. */
    unsplash_key?: string | null;
  };
  schedule: {
    radio_duty: boolean;
    day_wake_min: number;
    night_start: string;
    night_end: string;
    night_wake_min: number;
    timezone: string;
  };
};

const TV_PLUG = "smart_switch_23081678814571510d0548e1e9d69992";
const WORKSTATION = "smart_switch_23081667767888510d0548e1e9d69812";
const BOILER = "smart_switch_23091502032711510d0248e1e9dac29d";

/** This household, exactly as the panel had it hard-coded (seeded into HA on the first start). */
export const DEFAULT_CONFIG: PanelConfig = {
  version: 1,
  language: "he",
  tabs: ["lights", "vacuum", "power", "media"],
  names: {
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
  },
  lights: [
    {
      entity_id: "light.main_light",
      name: "Main light",
      room: "Living room",
      icon: "lamp_ceiling",
    },
    { entity_id: "light.spots", name: "Spot light", room: "Living room", icon: "spot" },
    {
      entity_id: "light.dining_table",
      name: "Dining table",
      room: "Dining room",
      icon: "lamp_ceiling",
    },
    {
      entity_id: "light.cabinet_strips",
      name: "Cabinet strips",
      room: "Dining room",
      icon: "strip",
    },
  ],
  scenes: [
    { builtin: "bright", name: "Bright", icon: "sun" },
    { builtin: "evening", name: "Evening", icon: "moon" },
    { entity_id: "script.movie_mode", name: "Movie", icon: "film" },
  ],
  evening: { entity_id: "light.main_light", brightness_pct: 40, warm_kelvin: 2200 },
  vacuum: {
    entity_id: "vacuum.roborock_qrevo_edge_series",
    battery_entity: "sensor.roborock_qrevo_edge_series_battery",
    rooms_script: "script.robo_grid_start",
    rooms: [
      { entity_id: "input_boolean.robo_grid_1", name: "Shower", icon: "shower" },
      { entity_id: "input_boolean.robo_grid_2", name: "Kids room", icon: "baby" },
      { entity_id: "input_boolean.robo_grid_3", name: "Corridor", icon: "door" },
      { entity_id: "input_boolean.robo_grid_7", name: "Kitchen", icon: "utensils" },
      { entity_id: "input_boolean.robo_grid_6", name: "Hall", icon: "home" },
      { entity_id: "input_boolean.robo_grid_5", name: "Bathroom", icon: "bath" },
      { entity_id: "input_boolean.robo_grid_4", name: "Bedroom", icon: "bed" },
      { entity_id: "input_boolean.robo_grid_8", name: "Living room", icon: "sofa" },
    ],
  },
  plugs: [
    {
      entity_id: `switch.${TV_PLUG}_outlet`,
      name: "TV Plug",
      power_entity: `sensor.${TV_PLUG}_power`,
      energy_entity: `sensor.${TV_PLUG}_energy`,
      energy_to_wh: 1,
    },
    {
      entity_id: `switch.${WORKSTATION}_outlet`,
      name: "Workstation",
      power_entity: `sensor.${WORKSTATION}_power`,
      energy_entity: `sensor.${WORKSTATION}_energy`,
      energy_to_wh: 1,
    },
    {
      entity_id: `switch.${BOILER}_outlet`,
      name: "Kitchen boiler",
      power_entity: `sensor.${BOILER}_power`,
      energy_entity: "sensor.kitchen_boiler_energy_calc",
      energy_to_wh: 1000,
    },
  ],
  power_keys: [
    `switch.${TV_PLUG}_outlet`,
    `switch.${WORKSTATION}_outlet`,
    `switch.${BOILER}_outlet`,
    KEY_ALL_OFF,
  ],
  media: {
    music_backend: "app",
    amp_player: "media_player.r_n500_main",
    amp_volume: "number.r_n500_main_volume_db",
    dlna_player: "media_player.yamaha_r_n500",
    amp_plug: `switch.${TV_PLUG}_outlet`,
    amp_plug_power: `sensor.${TV_PLUG}_power`,
    tv: "media_player.bravia_xr_65x90k",
    movie_on: "script.movie_mode",
    movie_off: "script.movie_mode_off",
    movie_active: "input_boolean.movie_mode_active",
    ynca_entry_id: "01M0ZMQXMTWAAW7BXTBCXD1YZR",
  },
  sensors: {
    indoor_temperature: "sensor.ikea_of_sweden_vindstyrka_temperature",
    indoor_humidity: "sensor.ikea_of_sweden_vindstyrka_humidity",
    weather: "weather.forecast_home",
  },
  screensaver: {
    idle_minutes: 5,
    photo_minutes: 10,
    mode: "curate",
    sources: [{ type: "immich_favorites", title: "Immich · Favourites" }],
    cards: [{ type: "outdoor" }, { type: "indoor" }, { type: "calendar" }],
    fallback: "unsplash",
    unsplash_query: "black and white art",
  },
  schedule: {
    radio_duty: true,
    day_wake_min: 10,
    night_start: "00:00",
    night_end: "06:00",
    night_wake_min: 120,
    timezone: "Europe/Berlin",
  },
};

/** What the browser needs (no service/script ids beyond what it already shows). */
export type PanelView = Pick<
  PanelConfig,
  "language" | "tabs" | "names" | "lights" | "scenes" | "vacuum" | "plugs" | "power_keys"
> & { source: "ha" | "default"; screensaver: Omit<PanelConfig["screensaver"], "unsplash_key"> };

export const panelView = (c: PanelConfig, source: "ha" | "default"): PanelView => ({
  language: c.language,
  tabs: c.tabs,
  names: c.names,
  lights: c.lights,
  scenes: c.scenes,
  vacuum: { rooms: c.vacuum.rooms },
  plugs: c.plugs,
  power_keys: c.power_keys,
  screensaver: (({ unsplash_key: _secret, ...rest }) => rest)(c.screensaver),
  source,
});

/** The scene buttons the panel always had (HA's kindle_panel derives the same while none are saved). */
export function defaultScenes(movieOn: string | null | undefined): SceneButton[] {
  const rows: SceneButton[] = [
    { builtin: "bright", name: "Bright", icon: "sun" },
    { builtin: "evening", name: "Evening", icon: "moon" },
  ];
  if (movieOn) rows.push({ entity_id: movieOn, name: "Movie", icon: "film" });
  return rows;
}

/** F1..F3 the first three plugs, F4 all off: the Power tab as it always was. */
export function defaultPowerKeys(plugs: { entity_id: string }[]): string[] {
  const keys = plugs.slice(0, SOFT_KEY_COUNT - 1).map((p) => p.entity_id);
  while (keys.length < SOFT_KEY_COUNT - 1) keys.push(KEY_NONE);
  return [...keys, KEY_ALL_OFF];
}

const validScene = (s: SceneButton) =>
  !!s.name &&
  (s.builtin
    ? (SCENE_BUILTINS as readonly string[]).includes(s.builtin) && !s.entity_id
    : /^(scene|script)\./.test(s.entity_id ?? ""));

/** A config from HA, missing parts filled from the defaults' shape (HA normalises it already; this guards old ones). */
export function mergePanelConfig(raw: Partial<PanelConfig> | null | undefined): PanelConfig {
  const d = DEFAULT_CONFIG;
  if (!raw) return structuredClone(d);
  const plugs = (raw.plugs ?? []).map((p) => ({ ...p, energy_to_wh: p.energy_to_wh ?? 1 }));
  const keys = raw.power_keys ?? defaultPowerKeys(plugs);
  const tabs = (raw.tabs ?? d.tabs).filter((t): t is TabId =>
    (TAB_IDS as readonly string[]).includes(t),
  );
  return {
    version: raw.version ?? 1,
    language: raw.language === "en" || raw.language === "he" ? raw.language : d.language,
    tabs: tabs.length ? tabs : [...d.tabs],
    names: raw.names ?? {},
    lights: raw.lights ?? [],
    scenes: (raw.scenes ?? defaultScenes(raw.media?.movie_on))
      .filter(validScene)
      .slice(0, MAX_SCENES),
    evening: { ...d.evening, entity_id: null, ...(raw.evening ?? {}) },
    vacuum: { rooms: [], ...(raw.vacuum ?? {}) },
    plugs,
    power_keys: Array.from({ length: SOFT_KEY_COUNT }, (_, i) => keys[i] || KEY_NONE),
    media: { music_backend: "app", ...(raw.media ?? {}) },
    sensors: { ...(raw.sensors ?? {}) },
    screensaver: {
      ...d.screensaver,
      sources: [],
      ...(raw.screensaver ?? {}),
      cards: (raw.screensaver?.cards ?? d.screensaver.cards)
        .filter((x) => (CARD_TYPES as readonly string[]).includes(x.type))
        .filter((x) => x.type !== "sensor" || !!x.entity_id)
        .slice(0, 3),
    },
    schedule: { ...d.schedule, ...(raw.schedule ?? {}) },
  };
}
