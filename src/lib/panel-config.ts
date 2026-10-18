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
/** A built-in tab, or a custom tab `custom:<id>` (its setup in `custom_tabs[<id>]`). */
export type TabId = (typeof TAB_IDS)[number] | `custom:${string}`;
export const CUSTOM_PREFIX = "custom:";
export const CUSTOM_ID = /^[a-z0-9_]{1,24}$/;
export const MAX_TABS = 6;
export const MAX_TOGGLES = 4;
/** A row of a custom tab: a switch, light, input_boolean or fan; Enter switches it. */
export type CustomToggle = { entity_id: string; name: string; icon: string };
/** A custom tab: its title (English; Hebrew from names), icon, up to 4 toggles and F1..F4 (soft-key strings). */
export type CustomTab = { title: string; icon: string; toggles: CustomToggle[]; keys: string[] };
export const isCustomTab = (t: string): t is `custom:${string}` =>
  t.startsWith(CUSTOM_PREFIX) && CUSTOM_ID.test(t.slice(CUSTOM_PREFIX.length));

export type PanelLight = { entity_id: string; name: string; room: string; icon: string };
export type PanelRoom = { entity_id: string; name: string; icon: string };
export type PanelPlug = {
  entity_id: string;
  name: string;
  power_entity?: string | null;
  energy_entity?: string | null;
  energy_to_wh: number;
  /** icon pack name (src/data/icons.json, bus task 019); default "plug". */
  icon?: string | null;
};
/** Lights tab scene buttons (F1..F3; F4 stays "all off"). */
export const MAX_SCENES = 3;
/** A scene button: an HA scene or script. The name is English; its Hebrew comes from `names` (Bright / Evening / Movie
 *  also from the app's own translations). The panel has no scenes of its own (owner, 2026-10-17). */
export type SceneButton = {
  entity_id: string;
  name: string;
  icon: string;
};
/** A soft key F1..F4 (Power tab): an entity of the tab's list (a plug), "all_off" (every entity of the list off) or
 *  "none". The same string model is meant for custom tabs (task 012). */
export const KEY_ALL_OFF = "all_off";
export const KEY_NONE = "none";
export const SOFT_KEY_COUNT = 4;

/** Media tab (bus task 014): typed device nodes. Per type the field holding its main media_player; the type list is
 *  meant to grow (kindle_panel's NODE_TYPES is the other half of this table). */
export const NODE_TYPES = {
  receiver: { entity: "power_device" },
  tv: { entity: "entity" },
} as const;
export type NodeType = keyof typeof NODE_TYPES;
export type MediaNode = {
  id: string;
  type: NodeType;
  name: string;
  /** receiver: the media_player with power, inputs (and volume when there is no `volume` number). */
  power_device?: string | null;
  volume?: string | null;
  plug?: string | null;
  plug_power?: string | null;
  /** receiver: its DLNA/AirPlay select. */
  stream_output?: string | null;
  /** receiver: the bridge's NET RADIO station select (yamaha_netbridge >= 0.3.0; kindle_panel fills it in from the
   *  receiver's device when the node does not name one). Its `stations` attribute is the panel's radio list. */
  net_radio?: string | null;
  /** receiver: the Music Assistant players it plays (an output among them wakes the receiver). */
  players?: string[] | null;
  /** receiver, app backend only. */
  dlna_player?: string | null;
  ynca_entry_id?: string | null;
  /** tv: the TV's media_player. */
  entity?: string | null;
  movie_on?: string | null;
  movie_off?: string | null;
  movie_active?: string | null;
  /** Any type: renamed / hidden entries of its entity's source_list (bus task 015). */
  inputs?: NodeInput[] | null;
  /** icon pack name (bus task 019); default by type: receiver "speaker", tv "tv". */
  icon?: string | null;
};
/** One row of a node's inputs: `input` as the entity lists it, a name (+ Hebrew) to show instead, or hidden. */
export type NodeInput = {
  input: string;
  name?: string | null;
  name_he?: string | null;
  hidden?: boolean | null;
  /** icon pack name (bus task 019); none by default (no icon shown). */
  icon?: string | null;
};
export const nodeEntity = (n: MediaNode): string =>
  (n[NODE_TYPES[n.type].entity] as string | null) ?? "";
/** Media tab F1..F4: "none", "all_off", "music" (the music screen), a node id, or a script entity. */
export const KEY_MUSIC = "music";
/** kindle_panel <= 0.4.0 (config version 1): flat amp / TV fields, the owner's amp hard-wired in the HA backend. */
export type LegacyMedia = {
  music_backend?: "app" | "ha";
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
const LEGACY_KEYS = [
  "amp_player",
  "amp_volume",
  "dlna_player",
  "amp_plug",
  "amp_plug_power",
  "tv",
  "movie_on",
  "movie_off",
  "movie_active",
  "ynca_entry_id",
] as const;
export const LEGACY_MA_PLAYERS = ["media_player.ma_amp_dlna", "media_player.ma_amp_airplay"];
/** Same rules as kindle_panel's config.migrate_media. */
export function migrateMedia(old: LegacyMedia): PanelConfig["media"] {
  const ha = old.music_backend === "ha";
  const nodes: MediaNode[] = [];
  const power = ha ? "media_player.r_n500" : old.amp_player;
  if (power) {
    const amp: MediaNode = {
      id: "amp",
      type: "receiver",
      name: "Yamaha R-N500",
      power_device: power,
    };
    if (old.amp_volume) amp.volume = old.amp_volume;
    if (old.amp_plug) amp.plug = old.amp_plug;
    if (old.amp_plug_power) amp.plug_power = old.amp_plug_power;
    if (old.dlna_player) amp.dlna_player = old.dlna_player;
    if (old.ynca_entry_id) amp.ynca_entry_id = old.ynca_entry_id;
    if (ha) {
      amp.stream_output = "select.r_n500_stream_output";
      amp.players = [...LEGACY_MA_PLAYERS];
    }
    nodes.push(amp);
  }
  if (old.tv) {
    const tv: MediaNode = { id: "tv", type: "tv", name: "Sony TV", entity: old.tv };
    if (old.movie_on) tv.movie_on = old.movie_on;
    if (old.movie_off) tv.movie_off = old.movie_off;
    if (old.movie_active) tv.movie_active = old.movie_active;
    nodes.push(tv);
  }
  return {
    music_backend: old.music_backend ?? "app",
    nodes,
    keys: defaultMediaKeys(nodes),
    output_keys: padTo4(ha ? [LEGACY_MA_PLAYERS[0]!] : defaultOutputKeys(nodes)),
  };
}
const padTo4 = (k: string[]) => Array.from({ length: SOFT_KEY_COUNT }, (_, i) => k[i] || KEY_NONE);
export function defaultMediaKeys(nodes: MediaNode[]): string[] {
  const first = (t: NodeType) => nodes.find((n) => n.type === t)?.id ?? KEY_NONE;
  return [KEY_MUSIC, first("receiver"), first("tv"), KEY_NONE];
}
export function defaultOutputKeys(nodes: MediaNode[]): string[] {
  return padTo4([nodes.find((n) => n.players?.length)?.players?.[0] ?? KEY_NONE]);
}
/** The movie script of the first TV that has one (default scene button "Movie"). */
export const movieScript = (m: PanelConfig["media"] | undefined) =>
  m?.nodes?.find((n) => n.movie_on)?.movie_on ?? null;

export const CARD_TYPES = ["outdoor", "indoor", "calendar", "sensor"] as const;
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
  custom_tabs: Record<string, CustomTab>;
  names: Partial<Record<Lang, Record<string, string>>>;
  lights: PanelLight[];
  scenes: SceneButton[];
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
    nodes: MediaNode[];
    /** Media tab F1..F4, always 4 entries. */
    keys: string[];
    /** Output picker F1..F4: an MA media_player or "none", always 4 entries. */
    output_keys: string[];
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
  custom_tabs: {},
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
    { entity_id: "scene.bright", name: "Bright", icon: "sun" },
    { entity_id: "scene.evening", name: "Evening", icon: "moon" },
    { entity_id: "script.movie_mode", name: "Movie", icon: "film" },
  ],
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
    // filled below from LEGACY_HOUSE_MEDIA (the same fields kindle_panel migrates)
    music_backend: "app",
    nodes: [],
    keys: [],
    output_keys: [],
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

/** This household's media fields as they were before nodes (config version 1). */
export const LEGACY_HOUSE_MEDIA: LegacyMedia = {
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
};
DEFAULT_CONFIG.media = migrateMedia({ ...LEGACY_HOUSE_MEDIA, music_backend: "app" });

/** What the browser needs (no service/script ids beyond what it already shows). */
export type PanelView = Pick<
  PanelConfig,
  | "language"
  | "tabs"
  | "custom_tabs"
  | "names"
  | "lights"
  | "scenes"
  | "vacuum"
  | "plugs"
  | "power_keys"
> & { source: "ha" | "default"; screensaver: Omit<PanelConfig["screensaver"], "unsplash_key"> };

export const panelView = (c: PanelConfig, source: "ha" | "default"): PanelView => ({
  language: c.language,
  tabs: c.tabs,
  custom_tabs: c.custom_tabs,
  names: c.names,
  lights: c.lights,
  scenes: c.scenes,
  vacuum: { rooms: c.vacuum.rooms },
  plugs: c.plugs,
  power_keys: c.power_keys,
  screensaver: (({ unsplash_key: _secret, ...rest }) => rest)(c.screensaver),
  source,
});

/** The default scene buttons: the HA scenes Bright and Evening and the movie-mode script (kindle_panel derives the same
 *  while none are saved). */
export function defaultScenes(movieOn: string | null | undefined): SceneButton[] {
  const rows: SceneButton[] = [
    { entity_id: "scene.bright", name: "Bright", icon: "sun" },
    { entity_id: "scene.evening", name: "Evening", icon: "moon" },
  ];
  if (movieOn) rows.push({ entity_id: movieOn, name: "Movie", icon: "film" });
  return rows;
}

/** F1..F3 the first three entities of a tab's list, F4 all off: the Power tab as it always was (custom tabs too). */
export function defaultPowerKeys(plugs: { entity_id: string }[]): string[] {
  const keys = plugs.slice(0, SOFT_KEY_COUNT - 1).map((p) => p.entity_id);
  while (keys.length < SOFT_KEY_COUNT - 1) keys.push(KEY_NONE);
  return [...keys, KEY_ALL_OFF];
}

/** kindle_panel <= 0.3.0 had built-in Bright / Evening rows; they now run these HA scenes. */
const LEGACY_BUILTIN_SCENES: Record<string, string> = {
  bright: "scene.bright",
  evening: "scene.evening",
};
const migrateScene = (s: SceneButton & { builtin?: string | null }): SceneButton => {
  const { builtin, ...row } = s;
  return builtin && !row.entity_id && LEGACY_BUILTIN_SCENES[builtin]
    ? { ...row, entity_id: LEGACY_BUILTIN_SCENES[builtin] }
    : row;
};
const validScene = (s: SceneButton) =>
  !!s.name && /^(scene|script)\.[a-z0-9_]+$/.test(s.entity_id ?? "");

/** A config from HA, missing parts filled from the defaults' shape (HA normalises it already; this guards old ones). */
export function mergePanelConfig(raw: Partial<PanelConfig> | null | undefined): PanelConfig {
  const d = DEFAULT_CONFIG;
  if (!raw) return structuredClone(d);
  const plugs = (raw.plugs ?? []).map((p) => ({ ...p, energy_to_wh: p.energy_to_wh ?? 1 }));
  const padKeys = (k: string[] | undefined, rows: { entity_id: string }[]) => {
    const keys = k ?? defaultPowerKeys(rows);
    return Array.from({ length: SOFT_KEY_COUNT }, (_, i) => keys[i] || KEY_NONE);
  };
  const customTabs: Record<string, CustomTab> = {};
  for (const [id, t] of Object.entries(raw.custom_tabs ?? {})) {
    if (!CUSTOM_ID.test(id) || !t?.title) continue;
    const toggles = (t.toggles ?? []).slice(0, MAX_TOGGLES);
    customTabs[id] = {
      title: t.title,
      icon: t.icon ?? "star",
      toggles,
      keys: padKeys(t.keys, toggles),
    };
  }
  const media = mergeMedia(raw.media);
  const tabs = [...new Set(raw.tabs ?? d.tabs)]
    .filter(
      (t): t is TabId =>
        (TAB_IDS as readonly string[]).includes(t) ||
        (isCustomTab(t) && t.slice(CUSTOM_PREFIX.length) in customTabs),
    )
    .slice(0, MAX_TABS);
  return {
    version: 2,
    language: raw.language === "en" || raw.language === "he" ? raw.language : d.language,
    tabs: tabs.length ? tabs : [...d.tabs],
    custom_tabs: customTabs,
    names: raw.names ?? {},
    lights: raw.lights ?? [],
    scenes: (raw.scenes ?? defaultScenes(movieScript(media)))
      .map(migrateScene)
      .filter(validScene)
      .slice(0, MAX_SCENES),
    vacuum: { rooms: [], ...(raw.vacuum ?? {}) },
    plugs,
    power_keys: padKeys(raw.power_keys, plugs),
    media,
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

/** Media as HA answers it (version 2), or a version-1 one migrated the way kindle_panel does. */
export function mergeMedia(
  raw: (Partial<PanelConfig["media"]> & LegacyMedia) | undefined,
): PanelConfig["media"] {
  const m = raw ?? {};
  if (!m.nodes && LEGACY_KEYS.some((k) => m[k])) return migrateMedia(m);
  const nodes = (m.nodes ?? []).filter((n) => n?.id && n.type in NODE_TYPES && nodeEntity(n));
  return {
    music_backend: m.music_backend === "ha" ? "ha" : "app",
    nodes,
    keys: m.keys ? padTo4(m.keys) : defaultMediaKeys(nodes),
    output_keys: m.output_keys?.length ? padTo4(m.output_keys) : defaultOutputKeys(nodes),
  };
}
