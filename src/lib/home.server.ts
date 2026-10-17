// Server-only: talks to Home Assistant and Immich. Env vars are read at request
// time from process.env and never reach the browser.
import {
  CUSTOM_TABS,
  LIGHTS,
  MEDIA,
  PLUGS,
  ROOMS,
  SCENES,
  SCRIPTS,
  SAVER_CARDS,
  SENSORS,
  VACUUM,
  COLOR_MODES,
  nearestColor,
  customTab,
  nearestShade,
  softKeyTarget,
} from "@/lib/home";
import {
  addMark,
  cropToScreen,
  loadMarks,
  markedIds,
  pickAsset,
  skippedIds,
} from "@/lib/photo.server";
import type { PhotoAsset } from "@/lib/photo.server";
import type { Action, LightState, Shade, Snapshot } from "@/lib/home";

type HaAttrs = {
  brightness?: unknown;
  color_temp_kelvin?: unknown;
  color_mode?: unknown;
  supported_color_modes?: unknown;
  rgb_color?: unknown;
  battery_level?: unknown;
  volume_level?: unknown;
  source?: unknown;
  temperature?: unknown;
  unit_of_measurement?: unknown;
};
export type HaState = { entity_id: string; state: string; attributes: HaAttrs };
export class HomeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const env = (name: string) => (process.env[name] ?? "").trim().replace(/\/+$/, "");
export const haConfigured = () => env("HA_TOKEN") !== "";

export async function ha<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 6000,
): Promise<T> {
  const base = env("HA_BASE_URL") || "http://host.docker.internal:8123";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env("HA_TOKEN")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HomeError("HA unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new HomeError("HA rejected token");
  if (!res.ok) throw new HomeError(`HA error ${res.status}`, res.status);
  return (await res.json()) as T;
}

export const fetchStates = async () =>
  new Map((await ha<HaState[]>("GET", "/api/states")).map((s) => [s.entity_id, s]));
export const service = (domain: string, name: string, data: Record<string, unknown>) =>
  ha("POST", `/api/services/${domain}/${name}`, data);

const num = (s?: HaState): number | null => {
  if (!s || s.state === "unavailable" || s.state === "unknown") return null;
  const n = parseFloat(s.state);
  return Number.isFinite(n) ? n : null;
};
const attrNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseLight(s?: HaState): LightState {
  const on = s?.state === "on";
  const a = s?.attributes ?? {};
  const b = attrNum(a.brightness);
  const kelvin = attrNum(a.color_temp_kelvin);
  const mode = typeof a.color_mode === "string" ? a.color_mode : "";
  const rgb = Array.isArray(a.rgb_color) ? (a.rgb_color as number[]) : null;
  const colored =
    rgb !== null &&
    mode !== "" &&
    mode !== "color_temp" &&
    mode !== "brightness" &&
    mode !== "onoff";
  const modes = Array.isArray(a.supported_color_modes)
    ? (a.supported_color_modes as unknown[])
    : [];
  const canColor = modes.some((m) => typeof m === "string" && COLOR_MODES.includes(m));
  const shade: Shade = kelvin !== null ? nearestShade(kelvin) : "Neutral";
  return {
    on,
    level: on ? (b === null ? 100 : Math.max(1, Math.round((b / 255) * 100))) : 0,
    shade,
    color: canColor && colored ? nearestColor(rgb) : "White",
    canColor,
  };
}

export function buildSnapshot(states: Map<string, HaState>): Snapshot {
  const vac = states.get(VACUUM.id);
  const battery = num(states.get(VACUUM.battery)) ?? attrNum(vac?.attributes.battery_level);
  const media = MEDIA.map((m) => {
    const s = states.get(m.id);
    return {
      state: s?.state ?? "unavailable",
      volume: attrNum(s?.attributes.volume_level),
      source: typeof s?.attributes.source === "string" ? s.attributes.source : null,
    };
  });
  const w = states.get(SENSORS.weather);
  return {
    lights: LIGHTS.map((l) => parseLight(states.get(l.id))),
    movieActive: states.get(SCRIPTS.movieActive)?.state === "on",
    vacuum: {
      state: vac?.state ?? "unavailable",
      battery: battery === null ? null : Math.round(battery),
    },
    rooms: ROOMS.map((r) => states.get(r.id)?.state === "on"),
    plugs: PLUGS.map((p) => {
      const e = p.energy ? num(states.get(p.energy)) : null;
      return {
        on: states.get(p.id)?.state === "on",
        power: p.power ? num(states.get(p.power)) : null,
        energyWh: e === null ? null : e * p.energyToWh,
      };
    }),
    media,
    weather: {
      condition: w && w.state !== "unavailable" && w.state !== "unknown" ? w.state : null,
      temp: attrNum(w?.attributes.temperature),
    },
    indoor: {
      temp: num(states.get(SENSORS.indoorTemp)),
      humidity: num(states.get(SENSORS.indoorHumidity)),
    },
    ...(SAVER_CARDS.some((c) => c.type === "sensor") ? { cards: cardReadings(states) } : {}),
    ...(Object.keys(CUSTOM_TABS).length ? { custom: customReadings(states) } : {}),
  };
}

function customReadings(states: Map<string, HaState>) {
  const out: NonNullable<Snapshot["custom"]> = {};
  for (const [id, tab] of Object.entries(CUSTOM_TABS)) {
    const ids = tab.toggles.map((t) => t.entity_id);
    const names: Record<string, string> = {};
    for (const key of tab.keys) {
      const target = softKeyTarget(key, ids);
      if (target?.kind !== "run") continue;
      const name = (states.get(key)?.attributes as { friendly_name?: unknown } | undefined)
        ?.friendly_name;
      names[key] = typeof name === "string" ? name : key;
    }
    out[id] = { on: ids.map((e) => states.get(e)?.state === "on"), names };
  }
  return out;
}

function cardReadings(states: Map<string, HaState>) {
  const out: Record<string, { value: string | null; unit: string | null }> = {};
  for (const c of SAVER_CARDS) {
    if (c.type !== "sensor" || !c.entity_id) continue;
    const s = states.get(c.entity_id);
    const bad = !s || s.state === "unavailable" || s.state === "unknown";
    const n = bad ? NaN : Number(s.state);
    const unit = s?.attributes.unit_of_measurement;
    out[c.entity_id] = {
      value: bad ? null : Number.isFinite(n) ? String(Math.round(n * 10) / 10) : s.state,
      unit: typeof unit === "string" ? unit : null,
    };
  }
  return out;
}

export async function readSnapshot(): Promise<Snapshot> {
  return buildSnapshot(await fetchStates());
}

export async function performAction(a: Action): Promise<void> {
  switch (a.type) {
    case "light.toggle":
      await service("light", "toggle", { entity_id: a.entity });
      break;
    case "light.brightness":
      await service("light", "turn_on", { entity_id: a.entity, brightness_pct: a.pct });
      break;
    case "light.kelvin":
      await service("light", "turn_on", { entity_id: a.entity, color_temp_kelvin: a.kelvin });
      break;
    case "light.color":
      await service("light", "turn_on", {
        entity_id: a.entity,
        ...(a.color === "White"
          ? { color_temp_kelvin: 4000 }
          : { color_name: a.color.toLowerCase() }),
      });
      break;
    case "lights.off":
      await service("light", "turn_off", { entity_id: LIGHTS.map((l) => l.id) });
      break;
    case "scene": {
      const row = SCENES.find((x) => x.entity_id === a.entity);
      if (!row) throw new HomeError("Unknown scene");
      // turn_on: a script is started, not waited for
      await service(row.entity_id.startsWith("scene.") ? "scene" : "script", "turn_on", {
        entity_id: row.entity_id,
      });
      break;
    }
    case "movie.end":
      await service("script", "turn_on", { entity_id: SCRIPTS.movieOff });
      break;
    case "vacuum":
      if (a.op === "start") {
        const states = await fetchStates();
        if (ROOMS.some((r) => states.get(r.id)?.state === "on"))
          await service("script", "turn_on", { entity_id: SCRIPTS.roomsStart });
        else await service("vacuum", "start", { entity_id: VACUUM.id });
      } else
        await service(
          "vacuum",
          { pause: "pause", dock: "return_to_base", locate: "locate" }[a.op],
          { entity_id: VACUUM.id },
        );
      break;
    case "room.toggle":
      await service("input_boolean", "toggle", { entity_id: a.entity });
      break;
    case "rooms.clear":
      await service("input_boolean", "turn_off", { entity_id: ROOMS.map((r) => r.id) });
      break;
    case "switch.toggle":
      await service("switch", "toggle", { entity_id: a.entity });
      break;
    case "media":
      await service("media_player", a.op, { entity_id: a.entity });
      break;
    case "custom.toggle":
      await service("homeassistant", "toggle", { entity_id: a.entity });
      break;
    case "custom.off": {
      const ids = customTab(a.tab)?.toggles.map((t) => t.entity_id) ?? [];
      if (ids.length) await service("homeassistant", "turn_off", { entity_id: ids });
      break;
    }
    case "custom.run":
      await service(a.entity.split(".")[0]!, "turn_on", { entity_id: a.entity });
      break;
  }
}

export const errorMessage = (e: unknown) => (e instanceof HomeError ? e.message : "HA unreachable");

// ---- Immich ----
export const immichConfigured = () => env("IMMICH_API_KEY") !== "" && env("IMMICH_URL") !== "";

let previousPhoto: string | null = null;
// Ids served lately: a mark is only accepted for one of these, so the marks file cannot be grown
// with arbitrary ids (and a stale F1 after a photo change still lands on a real favourite).
const servedPhotos: string[] = [];
const SERVED_PHOTOS_KEPT = 8;

export type FavoritePhoto = { image: string; assetId: string; marked: number };

/** All favourite images (Immich pages 250 at a time; capped so a huge library cannot stall the saver). */
async function favoriteAssets(
  base: string,
  headers: Record<string, string>,
): Promise<PhotoAsset[]> {
  const items: PhotoAsset[] = [];
  for (let page = 1; page <= 8; page++) {
    const search = await fetch(`${base}/api/search/metadata`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ isFavorite: true, type: "IMAGE", size: 250, page, withExif: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!search.ok) throw new Error(`Immich search ${search.status}`);
    const assets = (
      (await search.json()) as {
        assets?: { items?: PhotoAsset[]; nextPage?: string | number | null };
      }
    ).assets;
    items.push(...(assets?.items ?? []));
    if (!assets?.nextPage) break;
  }
  return items;
}

/** A random favourite that has not been marked yet, cropped to the screen. */
export async function randomFavorite(): Promise<FavoritePhoto> {
  const base = env("IMMICH_URL");
  const headers = { "x-api-key": env("IMMICH_API_KEY") };
  const [items, marks] = await Promise.all([favoriteAssets(base, headers), loadMarks()]);
  if (!items.length) throw new Error("No favorites");
  const asset = pickAsset(items, previousPhoto, Math.random, markedIds(marks), skippedIds(marks));
  if (!asset) throw new Error("Every favourite is skipped");
  previousPhoto = asset.id;
  if (!servedPhotos.includes(asset.id)) servedPhotos.push(asset.id);
  while (servedPhotos.length > SERVED_PHOTOS_KEPT) servedPhotos.shift();
  const img = await fetch(`${base}/api/assets/${asset.id}/thumbnail?size=preview`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!img.ok) throw new Error(`Immich thumbnail ${img.status}`);
  const raw = Buffer.from(await img.arrayBuffer());
  const marked = marks.marked.length;
  try {
    // Exactly the screen size, so the page never letterboxes or re-crops it.
    const image = `data:image/jpeg;base64,${(await cropToScreen(raw)).toString("base64")}`;
    return { image, assetId: asset.id, marked };
  } catch (e) {
    console.error("Screensaver crop failed, sending the uncropped preview:", e);
    const type = img.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    return { image: `data:${type};base64,${raw.toString("base64")}`, assetId: asset.id, marked };
  }
}

/** F1 on the screensaver: remember that this favourite looks good on the e-ink; F4: never show it again. Stored in
 *  the local marks file. Returns the new kept total. */
export async function markFavorite(id: string, verdict: "keep" | "skip" = "keep"): Promise<number> {
  if (!servedPhotos.includes(id)) throw new Error("Not a photo shown recently");
  return addMark(id, undefined, new Date(), verdict);
}
